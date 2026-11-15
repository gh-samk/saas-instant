import { ISSUER_PRESETS } from './issuer.config';
import { documentIssuerFrom } from './issuer-mapping';
import {
  PROFILE_IDENTIFIER,
  TYPE_CODE_INVOICE,
  dateAsCii,
  createCii,
  countryCode,
} from './cii-en16931';
import { createHtml } from './layout-html';
import type { InvoiceDocument } from './document.types';

const DOCUMENT: InvoiceDocument = {
  number: '2026-001',
  invoiceDate: '2026-08-31',
  dueAt: '2026-09-14',
  currency: 'EUR',
  servicePeriod: { from: '2026-09-01', until: '2027-08-31' },
  deliveryDate: '2026-09-01',
  orderReference: '2026-001',
  issuer: documentIssuerFrom(ISSUER_PRESETS),
  recipient: {
    name: 'Kollektiv Grünspecht e. V.',
    address: {
      street: 'Ziegelgasse 14',
      postalCode: '99423',
      city: 'Weimar',
      country: 'DE',
    },
    email: 'vorstand@gruenspecht-weimar.example.com',
  },
  lines: [
    {
      row: '1',
      label: 'Jahresbeitrag, Stufe 2',
      quantity: 1,
      unit: 'C62',
      unitPriceCent: 38_500,
      netCent: 38_500,
      taxCategory: 'S',
      taxRate: 19,
    },
  ],
  taxBreakdown: [
    { category: 'S', record: 19, basisCent: 38_500, taxCent: 7315 },
  ],
  sumNetCent: 38_500,
  sumTaxCent: 7315,
  sumGrossCent: 45_815,
  prepaidCent: 0,
  paymentAmountCent: 45_815,
  paymentTerm: 'Zahlbar ohne Abzug bis zum 14.09.2026.',
  hint: 'Es gilt die Regelbesteuerung.',
};

describe('Kennungen', () => {
  /**
   * DIE GEFÄHRLICHSTE FEHLERART IN DIESEM UMFELD.
   *
   * Der Erkundungsschritt hat sie gefunden: Mit einem veralteten Kennstring
   * lehnte der KoSIT-Validator das Dokument pauschal ab
   * (`<rep:noScenarioMatched>`) — ohne einen einzigen inhaltlichen Fehler zu
   * nennen. Das sieht aus wie ein Datenproblem und ist ein Tippfehler in einer
   * Zeichenkette. Deshalb prüft schon der Prototyp diese Konstante
   * ausdrücklich, und deshalb tut es diese Fassung auch.
   */
  it('nennt das Profil EN 16931 wörtlich', () => {
    expect(PROFILE_IDENTIFIER).toBe('urn:cen.eu:en16931:2017');
    expect(createCii(DOCUMENT)).toContain(
      '<ram:ID>urn:cen.eu:en16931:2017</ram:ID>',
    );
  });

  it('benutzt den Typcode 380 (Handelsrechnung)', () => {
    expect(TYPE_CODE_INVOICE).toBe('380');
  });

  it('schreibt Datumsangaben im CII-Format 102', () => {
    expect(dateAsCii('2026-08-31')).toBe('20260831');
    expect(() => dateAsCii('31.08.2026')).toThrow(TypeError);
  });
});

describe('createCii', () => {
  const xml = createCii(DOCUMENT);

  it('trägt Rechnungsnummer, Datum und Fälligkeit', () => {
    expect(xml).toContain('<ram:ID>2026-001</ram:ID>');
    expect(xml).toContain('20260831');
    expect(xml).toContain('20260914');
  });

  it('trägt die USt-IdNr. mit schemeID VA (BT-31)', () => {
    expect(xml).toContain(
      `<ram:ID schemeID="VA">${ISSUER_PRESETS.vatId}</ram:ID>`,
    );
  });

  /**
   * § 125a HGB VERLANGT DIE REGISTERANGABEN AUF DEM GESCHÄFTSBRIEF.
   *
   * In EN 16931 gibt es dafür kein eigenes Feld je Angabe. Der Block steht
   * deshalb zweimal: strukturiert als BT-30 (Handelsregisternummer) und als
   * Fließtext in BT-33 (`ram:Description`) sowie als Notiz mit SubjectCode REG.
   */
  it('trägt die Registerangaben nach § 125a HGB', () => {
    expect(xml).toContain(
      `<ram:SpecifiedLegalOrganization><ram:ID>${ISSUER_PRESETS.registerIdentifier}</ram:ID></ram:SpecifiedLegalOrganization>`,
    );
    expect(xml).toContain('<ram:SubjectCode>REG</ram:SubjectCode>');
    expect(xml).toContain(ISSUER_PRESETS.generalPartner.registerIdentifier);
    expect(xml).toContain(
      ISSUER_PRESETS.generalPartner.managingDirector[0],
    );
  });

  /** BR-CO-26: BT-29, BT-30 oder BT-31 muss vorhanden sein. */
  it('nennt die Steuernummer als Verkäuferkennung, wenn weder USt-IdNr. noch Register existieren', () => {
    const sole = createCii({
      ...DOCUMENT,
      issuer: documentIssuerFrom({
        ...ISSUER_PRESETS,
        legalForm: 'einzelunternehmen',
        vatId: '',
        taxNumber: '12/345/67890',
        registerIdentifier: '',
      }),
    });
    expect(sole).toContain('<ram:SellerTradeParty><ram:ID>12/345/67890</ram:ID><ram:Name>');
    expect(sole).toContain('<ram:ID schemeID="FC">12/345/67890</ram:ID>');
    expect(sole).not.toContain('schemeID="VA">DE');
    // Mit USt-IdNr. entfällt die zusätzliche Kennung.
    expect(xml).not.toContain('<ram:SellerTradeParty><ram:ID>');
  });

  it('trennt Netto, Steuer und Brutto (§ 14 Abs. 4 Nr. 8 UStG)', () => {
    expect(xml).toContain('<ram:LineTotalAmount>385.00</ram:LineTotalAmount>');
    expect(xml).toContain('<ram:TaxBasisTotalAmount>385.00</ram:TaxBasisTotalAmount>');
    expect(xml).toContain('<ram:TaxTotalAmount currencyID="EUR">73.15</ram:TaxTotalAmount>');
    expect(xml).toContain('<ram:GrandTotalAmount>458.15</ram:GrandTotalAmount>');
    expect(xml).toContain('<ram:RateApplicablePercent>19.00</ram:RateApplicablePercent>');
  });

  it('nennt die Bankverbindung als SEPA-Überweisung (Code 58)', () => {
    expect(xml).toContain('<ram:TypeCode>58</ram:TypeCode>');
    expect(xml).toContain(
      `<ram:IBANID>${ISSUER_PRESETS.bank.iban}</ram:IBANID>`,
    );
  });

  /**
   * DIE ELEMENTREIHENFOLGE IST IM XSD ALS `<xs:sequence>` FESTGELEGT.
   *
   * Ein vertauschtes Element ist kein Schönheitsfehler, sondern ein
   * Schemafehler — und den meldet erst der Validator im Container, also nach
   * dem Rendern. Der Test hält die Reihenfolge der drei Hauptblöcke fest.
   */
  it('hält die Reihenfolge der Hauptblöcke ein', () => {
    const order = [
      '<rsm:ExchangedDocumentContext>',
      '<rsm:ExchangedDocument>',
      '<rsm:SupplyChainTradeTransaction>',
      '<ram:IncludedSupplyChainTradeLineItem>',
      '<ram:ApplicableHeaderTradeAgreement>',
      '<ram:ApplicableHeaderTradeDelivery>',
      '<ram:ApplicableHeaderTradeSettlement>',
    ].map((brand) => xml.indexOf(brand));
    expect(order.every((value) => value >= 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
  });

  it('maskiert Sonderzeichen, statt das Dokument zu zerbrechen', () => {
    const withCharacter = createCii({
      ...DOCUMENT,
      recipient: { ...DOCUMENT.recipient, name: 'Hof & Halle <e. V.>' },
    });
    expect(withCharacter).toContain('Hof &amp; Halle &lt;e. V.&gt;');
    expect(withCharacter).not.toContain('<e. V.>');
  });

  it('schreibt negative Beträge einer Stornorechnung aus', () => {
    const cancellation = createCii({
      ...DOCUMENT,
      number: '2026-002',
      lines: [
        {
          ...(DOCUMENT.lines[0] as (typeof DOCUMENT.lines)[number]),
          quantity: -1,
          netCent: -38_500,
        },
      ],
      taxBreakdown: [
        { category: 'S', record: 19, basisCent: -38_500, taxCent: -7315 },
      ],
      sumNetCent: -38_500,
      sumTaxCent: -7315,
      sumGrossCent: -45_815,
      paymentAmountCent: -45_815,
      cancellationNote: 'Stornorechnung zu Rechnung 2026-001 — Tippfehler bei der Stufe',
    });
    expect(cancellation).toContain('<ram:GrandTotalAmount>-458.15</ram:GrandTotalAmount>');
    expect(cancellation).toContain('Stornorechnung zu Rechnung 2026-001');
    // Auch eine Stornorechnung bleibt eine 380 mit negativen Beträgen — keine
    // Gutschrift (381): Bei einer Gutschrift im Sinne des UStG rechnet der
    // Leistungsempfänger ab, und das ist etwas anderes.
    expect(cancellation).toContain('<ram:TypeCode>380</ram:TypeCode>');
  });
});

describe('createHtml', () => {
  const html = createHtml(DOCUMENT);

  it('hält den Zahlungssatz, den ZUGFeRD-Hinweis nur bei EN16931 und keine Unterzeile', () => {
    expect(html).toContain('ZUGFeRD (EN 16931)');
    expect(createHtml(DOCUMENT, 'XRECHNUNG')).not.toContain('ZUGFeRD');
    expect(html).not.toContain('Vielen Dank');
    expect(html).not.toContain('class="s">Monatliche');
  });

  it('rückt die Fußzeile bei vielen Zeilen nach oben, statt abzuschneiden', () => {
    const many = createHtml({
      ...DOCUMENT,
      issuer: {
        ...DOCUMENT.issuer,
        blocks: {
          ...DOCUMENT.issuer.blocks,
          legalLines: Array.from({ length: 10 }, (_, i) => `Zeile ${i}`),
        },
      },
    });
    const top = (h: string): number =>
      Number(/class="abs g ft" style="top:([\d.]+)mm"/.exec(h)?.[1]);
    expect(top(many)).toBeCloseTo(279 - 10 * 4.5, 5);
    expect(top(many)).toBeLessThan(top(html));
    expect(top(html)).toBeLessThanOrEqual(247.5);
  });

  /**
   * KEINE EXTERNEN RESSOURCEN.
   *
   * Was beim Rendern fehlt, fehlt STILL: Das PDF entstünde trotzdem, nur ohne
   * Logo, und niemand bekäme eine Fehlermeldung.
   */
  it('druckt ohne Komplementärin keinen Block und kein erfundenes Land', () => {
    const bare = createHtml({
      ...DOCUMENT,
      issuer: documentIssuerFrom({
        ...ISSUER_PRESETS,
        legalForm: 'gmbh',
        address: { ...ISSUER_PRESETS.address, country: '' },
        generalPartner: {
          name: '',
          seat: '',
          registerCourt: '',
          registerIdentifier: '',
          managingDirector: [],
        },
      }),
    });
    expect(bare).not.toContain('Persönlich haftende Gesellschafterin');
    expect(bare).not.toContain('Geschäftsführer:');
    expect(bare).not.toContain('Deutschland');
  });

  it('nennt ein Land außerhalb Deutschlands im Briefkopf, Deutschland nicht', () => {
    expect(html).not.toContain('Deutschland');
    const abroad = createHtml({
      ...DOCUMENT,
      issuer: documentIssuerFrom({
        ...ISSUER_PRESETS,
        address: { ...ISSUER_PRESETS.address, country: 'Österreich' },
      }),
    });
    expect(abroad).toContain('Österreich');
  });

  it('übernimmt Logo und Akzentfarbe des Firmenprofils, nur gültige Farben', () => {
    const withLogo = createHtml({
      ...DOCUMENT,
      issuer: documentIssuerFrom(ISSUER_PRESETS, {
        logoDataUri: 'data:image/png;base64,AAAA',
        accentColor: '#0f5132',
      }),
    });
    expect(withLogo).toContain('src="data:image/png;base64,AAAA"');
    expect(withLogo).toContain('--acc:#0f5132');
    // Mit Logo gibt es keine Initialmarke: die Akzentfarbe haengt am Titel.
    expect(withLogo).toMatch(/h1\{[^}]*color:var\(--acc\)/);
    const injected = createHtml({
      ...DOCUMENT,
      issuer: documentIssuerFrom(ISSUER_PRESETS, {
        accentColor: 'red;}</style><script>',
      }),
    });
    expect(injected).toContain('--acc:#0369A1');
    expect(injected).not.toContain('<script>');
  });

  it('lädt nichts von außen', () => {
    expect(html).not.toMatch(/src\s*=\s*["']https?:/i);
    expect(html).not.toMatch(/@import/i);
    expect(html).not.toMatch(/url\(\s*["']?https?:/i);
  });

  /**
   * GENAU EINE SCHRIFT, DIE IM CONTAINER ALS DATEI VORLIEGT.
   *
   * Ein Rückfall auf eine Systemschrift kann dazu führen, dass der Renderer
   * eine nicht einbettbare Schrift wählt — PDF/A verlangt, dass jede
   * verwendete Schrift eingebettet ist.
   */
  it('nennt genau eine Schrift ohne Rückfallkette (Familienname der Datei: „Inter Variable“)', () => {
    const hits = [...html.matchAll(/font-family:\s*([^;]+);/g)].map((t) =>
      (t[1] ?? '').trim(),
    );
    expect(hits).toEqual(['"Inter Variable"']);
  });

  it('trägt alle Pflichtangaben sichtbar im Dokument', () => {
    expect(html).toContain('2026-001');
    expect(html).toContain('Kollektiv Grünspecht e. V.');
    expect(html).toContain(`USt-IdNr. ${ISSUER_PRESETS.vatId}`);
    expect(html).toContain(ISSUER_PRESETS.registerIdentifier);
    expect(html).toContain(ISSUER_PRESETS.generalPartner.registerIdentifier);
    // Netto, Steuer und Brutto stehen getrennt.
    expect(html).toContain('Summe netto');
    expect(html).toContain('19 % USt');
    expect(html).toContain('Rechnungsbetrag');
  });

  it('maskiert Sonderzeichen im Namen', () => {
    const withCharacter = createHtml({
      ...DOCUMENT,
      recipient: { ...DOCUMENT.recipient, name: 'Hof & Halle <e. V.>' },
    });
    expect(withCharacter).toContain('Hof &amp; Halle &lt;e. V.&gt;');
  });

  it('weist auf die maschinenlesbare Anlage hin', () => {
    expect(html).toContain('ZUGFeRD (EN 16931)');
  });
});

describe('laendercode — der Fehler, den erst der Selbstprüfer fand', () => {
  /**
   * WARUM DIESE PRÜFUNG NACHGEZOGEN WURDE. Der Aufbau oben setzt
   * `land: 'DE'` — also bereits den Code. Die WIRKLICHKEIT liefert etwas
   * anderes: `Organisation.land` ist ein Freitextfeld und steht laut Schema
   * auf „Deutschland". Der Aufbau war korrekter als die Daten, und deshalb
   * ging der Test an einem Fehler vorbei, der JEDE Rechnung an eine deutsche
   * Adresse betraf: Mustang wies das Dokument zurück
   * (`Value of 'ram:CountryID' is not allowed`), und es liess sich zu keiner
   * dieser Rechnungen ein Beleg erzeugen.
   *
   * Gefunden hat es nicht der Test, sondern der Selbstprüfer des
   * Rechnungsdienstes im laufenden Betrieb.
   */
  it('macht aus dem ausgeschriebenen Namen den ISO-Code', () => {
    expect(countryCode('Deutschland')).toBe('DE');
    expect(countryCode('Österreich')).toBe('AT');
    expect(countryCode('Schweiz')).toBe('CH');
  });

  it('lässt einen bereits gesetzten Code durch, auch klein geschrieben', () => {
    expect(countryCode('DE')).toBe('DE');
    expect(countryCode('at')).toBe('AT');
    expect(countryCode('  ch  ')).toBe('CH');
  });

  it('WIRFT BEI UNBEKANNTEM LAND, statt auf DE zurückzufallen', () => {
    // Ein stiller Rückfall schriebe einer österreichischen Kundin ein Land in
    // den Beleg, in dem sie nicht sitzt. Der Fehler nennt den Wert, an dem es
    // lag — sonst stünde in der Meldung nur „ungültiges Dokument".
    expect(() => countryCode('Absurdistan')).toThrow(/Absurdistan/);
    expect(() => countryCode('Absurdistan')).toThrow(/ISO 3166-1/);
  });

  it('schreibt den Code ins Dokument, nicht den Namen', () => {
    const xml = createCii({
      ...DOCUMENT,
      recipient: {
        ...DOCUMENT.recipient,
        address: { ...DOCUMENT.recipient.address, country: 'Deutschland' },
      },
    });
    expect(xml).toContain('<ram:CountryID>DE</ram:CountryID>');
    expect(xml).not.toContain('Deutschland');
  });
});

// ===========================================================================
// ZWEI PROFILE: EN 16931 (ZUGFeRD) und XRECHNUNG 3.0
// ===========================================================================

// jsdom liefert hier keine Typen; es dient nur als XML-Parser (wohlgeformt?).
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { JSDOM } = require('jsdom') as {
  JSDOM: new (
    xml: string,
    options: { contentType: string },
  ) => { window: { document: Document } };
};
import {
  BUSINESS_PROCESS_IDENTIFIER,
  XRECHNUNG_IDENTIFIER,
  profileIdentifier,
} from './cii-en16931';

/** Parst das XML (wohlgeformt?) und liefert Abfragehilfen nach Tagnamen. */
function parse(xml: string) {
  const dom = new JSDOM(xml, { contentType: 'text/xml' });
  const doc = dom.window.document;
  return {
    all: (tag: string) => Array.from(doc.getElementsByTagName(tag)),
    first: (tag: string) => doc.getElementsByTagName(tag)[0] ?? null,
    text: (tag: string) => doc.getElementsByTagName(tag)[0]?.textContent ?? null,
  };
}

/** Reihenfolge der Kindelemente eines Elements. */
function childNames(el: Element | null): string[] {
  return el ? Array.from(el.children).map((c) => c.tagName) : [];
}

const AUTHORITY: InvoiceDocument = {
  ...DOCUMENT,
  buyerReference: '991-12345-67',
  recipient: {
    name: 'Stadt Weimar — Amt für Digitales',
    address: {
      street: 'Markt 1',
      postalCode: '99423',
      city: 'Weimar',
      country: 'DE',
    },
    email: 'rechnung@weimar.example.org',
    vatId: 'DE811111111',
    buyerType: 'authority',
    electronicAddress: { id: '991-12345-67', scheme: '0204' },
  },
};

describe('Profil EN16931 (ZUGFeRD)', () => {
  const xml = createCii(DOCUMENT);
  const x = parse(xml);

  it('ist wohlgeformt und trägt den EN-16931-Kennstring, KEINE Geschäftsprozesskennung', () => {
    expect(x.text('ram:ID')).toBe(PROFILE_IDENTIFIER);
    expect(xml).not.toContain('xrechnung');
    expect(xml).not.toContain(BUSINESS_PROCESS_IDENTIFIER);
    expect(createCii(DOCUMENT, 'EN16931')).toBe(xml);
  });

  it('nimmt als Käuferreferenz (BT-10) die Rechnungsnummer, wenn keine Leitweg-ID da ist', () => {
    expect(x.text('ram:BuyerReference')).toBe('2026-001');
  });

  it('trägt den Verwendungszweck (BT-83) und die Währung aus der Rechnung', () => {
    expect(x.text('ram:PaymentReference')).toBe('2026-001');
    expect(x.text('ram:InvoiceCurrencyCode')).toBe('EUR');
    const chf = createCii({ ...DOCUMENT, currency: 'CHF' });
    expect(chf).toContain('<ram:InvoiceCurrencyCode>CHF</ram:InvoiceCurrencyCode>');
    expect(chf).toContain('<ram:TaxTotalAmount currencyID="CHF">');
  });
});

describe('Profil XRECHNUNG 3.0', () => {
  const xml = createCii(AUTHORITY, 'XRECHNUNG');
  const x = parse(xml);

  it('nennt Kennstring (BT-24) und Geschäftsprozesskennung (BT-23) wörtlich', () => {
    expect(XRECHNUNG_IDENTIFIER).toBe(
      'urn:cen.eu:en16931:2017#compliant#urn:xeinkauf.de:kosit:xrechnung_3.0',
    );
    expect(BUSINESS_PROCESS_IDENTIFIER).toBe(
      'urn:fdc:peppol.eu:2017:poacc:billing:01:1.0',
    );
    expect(profileIdentifier('XRECHNUNG')).toBe(XRECHNUNG_IDENTIFIER);
    const context = x.first('rsm:ExchangedDocumentContext');
    // Reihenfolge laut XSD: erst Geschäftsprozess, dann Guideline.
    expect(childNames(context)).toEqual([
      'ram:BusinessProcessSpecifiedDocumentContextParameter',
      'ram:GuidelineSpecifiedDocumentContextParameter',
    ]);
    expect(context?.textContent).toContain(BUSINESS_PROCESS_IDENTIFIER);
    expect(context?.textContent).toContain(XRECHNUNG_IDENTIFIER);
  });

  it('nimmt die Leitweg-ID als Käuferreferenz (BT-10)', () => {
    expect(x.text('ram:BuyerReference')).toBe('991-12345-67');
  });

  it('nennt die elektronische Adresse der Behörde mit schemeID 0204 (BT-49)', () => {
    const buyer = x.first('ram:BuyerTradeParty');
    const uri = buyer?.getElementsByTagName('ram:URIID')[0];
    expect(uri?.getAttribute('schemeID')).toBe('0204');
    expect(uri?.textContent).toBe('991-12345-67');
  });

  it('nennt für eine E-Mail-Adresse das Schema EM', () => {
    const business = parse(createCii(DOCUMENT, 'XRECHNUNG'));
    const uri = business.first('ram:BuyerTradeParty')?.getElementsByTagName('ram:URIID')[0];
    expect(uri?.getAttribute('schemeID')).toBe('EM');
    expect(uri?.textContent).toBe('vorstand@gruenspecht-weimar.example.com');
  });

  it('trägt die USt-IdNr. der Käuferin (BT-48, schemeID VA)', () => {
    const tax = x
      .first('ram:BuyerTradeParty')
      ?.getElementsByTagName('ram:SpecifiedTaxRegistration')[0];
    expect(tax?.textContent).toBe('DE811111111');
    expect(tax?.getElementsByTagName('ram:ID')[0]?.getAttribute('schemeID')).toBe('VA');
  });

  it('trägt den Verkäuferkontakt (BR-DE-2) aus dem Aussteller', () => {
    const contact = x.first('ram:SellerTradeParty')?.getElementsByTagName('ram:DefinedTradeContact')[0];
    expect(childNames(contact ?? null)).toEqual([
      'ram:PersonName',
      'ram:TelephoneUniversalCommunication',
      'ram:EmailURIUniversalCommunication',
    ]);
  });

  it('hält die Reihenfolge im Settlement-Block ein (XSD-Sequenz)', () => {
    const settlement = x.first('ram:ApplicableHeaderTradeSettlement');
    const names = childNames(settlement);
    const order = [
      'ram:PaymentReference',
      'ram:InvoiceCurrencyCode',
      'ram:SpecifiedTradeSettlementPaymentMeans',
      'ram:ApplicableTradeTax',
      'ram:BillingSpecifiedPeriod',
      'ram:SpecifiedTradePaymentTerms',
      'ram:SpecifiedTradeSettlementHeaderMonetarySummation',
    ];
    expect(order.map((n) => names.indexOf(n))).toEqual(
      [...order.map((n) => names.indexOf(n))].sort((a, b) => a - b),
    );
    expect(names.every((n) => order.includes(n))).toBe(true);
  });

  it('verweigert fehlende Pflichtangaben des Profils mit einer Meldung', () => {
    expect(() =>
      createCii(
        { ...AUTHORITY, buyerReference: undefined },
        'XRECHNUNG',
      ),
    ).toThrow(/Leitweg-ID/);
    expect(() =>
      createCii(
        { ...DOCUMENT, issuer: documentIssuerFrom({ ...ISSUER_PRESETS, contact: { name: '', phone: '', email: '' } }) },
        'XRECHNUNG',
      ),
    ).toThrow(/Ansprechpartner/);
    expect(() =>
      createCii(
        { ...DOCUMENT, recipient: { ...DOCUMENT.recipient, email: undefined } },
        'XRECHNUNG',
      ),
    ).toThrow(/Elektronische Adresse/);
  });
});

describe('Steuerkategorien je Position (BT-118/BT-120)', () => {
  const withCategory = (
    category: string,
    reason?: string,
    vatId?: string,
  ): InvoiceDocument => ({
    ...DOCUMENT,
    recipient: { ...DOCUMENT.recipient, ...(vatId ? { vatId } : {}) },
    lines: [
      {
        ...DOCUMENT.lines[0]!,
        taxCategory: category,
        taxRate: 0,
        ...(reason ? { taxExemptionReason: reason } : {}),
      },
    ],
    taxBreakdown: [
      {
        category,
        record: 0,
        ...(reason ? { exemptionReason: reason } : {}),
        basisCent: 38_500,
        taxCent: 0,
      },
    ],
    sumTaxCent: 0,
    sumGrossCent: 38_500,
    paymentAmountCent: 38_500,
  });

  it('schreibt S mit Satz und ohne Befreiungsgrund', () => {
    const x = parse(createCii(DOCUMENT));
    expect(x.all('ram:CategoryCode').map((e) => e.textContent)).toEqual(['S', 'S']);
    expect(x.all('ram:ExemptionReason')).toHaveLength(0);
    expect(x.text('ram:RateApplicablePercent')).toBe('19.00');
  });

  it('schreibt E mit Befreiungsgrund VOR dem Basisbetrag', () => {
    const xml = createCii(withCategory('E', 'Steuerfrei nach § 4 Nr. 21 UStG'));
    const breakdown = parse(xml).all('ram:ApplicableTradeTax').find((e) =>
      e.getElementsByTagName('ram:CalculatedAmount').length > 0,
    ) ?? null;
    expect(childNames(breakdown)).toEqual([
      'ram:CalculatedAmount',
      'ram:TypeCode',
      'ram:ExemptionReason',
      'ram:BasisAmount',
      'ram:CategoryCode',
      'ram:RateApplicablePercent',
    ]);
    expect(breakdown?.textContent).toContain('§ 4 Nr. 21 UStG');
  });

  it('schreibt Z (Nullsatz) ohne Befreiungsgrund', () => {
    const x = parse(createCii(withCategory('Z')));
    expect(x.all('ram:CategoryCode').map((e) => e.textContent)).toEqual(['Z', 'Z']);
    expect(x.all('ram:ExemptionReason')).toHaveLength(0);
  });

  it('verlangt für AE und K die USt-IdNr. der Käuferin', () => {
    expect(() => createCii(withCategory('AE', 'Reverse Charge'))).toThrow(/BT-48/);
    expect(() => createCii(withCategory('K', 'Innergemeinschaftlich'))).toThrow(/BT-48/);
    const ae = parse(createCii(withCategory('AE', 'Reverse Charge', 'DE811111111')));
    expect(ae.all('ram:CategoryCode').map((e) => e.textContent)).toEqual(['AE', 'AE']);
  });

  it('verlangt für E, AE, K den Befreiungsgrund und für S einen Satz über 0', () => {
    expect(() => createCii(withCategory('E'))).toThrow(/Befreiungsgrund/);
    expect(() =>
      createCii({
        ...DOCUMENT,
        taxBreakdown: [{ category: 'S', record: 0, basisCent: 38_500, taxCent: 0 }],
      }),
    ).toThrow(/Steuersatz/);
  });

  it('lässt bei Kategorie O den Satz weg (BR-O-05)', () => {
    const x = parse(createCii(withCategory('O', 'Nicht steuerbar')));
    expect(x.all('ram:RateApplicablePercent')).toHaveLength(0);
  });
});

describe('Zahlungsart und Lastschriftmandat (BT-81, BT-89, BT-90)', () => {
  const debit: InvoiceDocument = {
    ...DOCUMENT,
    paymentMeansCode: '59',
    directDebit: {
      mandateReference: 'MANDAT-0042',
      creditorId: 'DE09ZZZ00000000001',
    },
  };

  it('nimmt ohne Angabe 58 und die Bank des Ausstellers (BT-84)', () => {
    const x = parse(createCii(DOCUMENT));
    expect(x.text('ram:TypeCode')).toBeDefined();
    const means = x.first('ram:SpecifiedTradeSettlementPaymentMeans');
    expect(means?.getElementsByTagName('ram:TypeCode')[0]?.textContent).toBe('58');
    expect(means?.getElementsByTagName('ram:IBANID')[0]?.textContent).toBe(
      ISSUER_PRESETS.bank.iban,
    );
    expect(x.all('ram:DirectDebitMandateID')).toHaveLength(0);
    expect(x.all('ram:CreditorReferenceID')).toHaveLength(0);
  });

  it('schreibt bei 59 Mandat (BT-89) und Gläubiger-ID (BT-90) an die richtigen Stellen', () => {
    const x = parse(createCii(debit));
    const means = x.first('ram:SpecifiedTradeSettlementPaymentMeans');
    expect(means?.getElementsByTagName('ram:TypeCode')[0]?.textContent).toBe('59');
    // Bei Lastschrift kein Überweisungskonto der Ausstellerin.
    expect(means?.getElementsByTagName('ram:PayeePartyCreditorFinancialAccount')).toHaveLength(0);
    expect(x.text('ram:CreditorReferenceID')).toBe('DE09ZZZ00000000001');
    const terms = x.first('ram:SpecifiedTradePaymentTerms');
    expect(childNames(terms)).toEqual([
      'ram:Description',
      'ram:DueDateDateTime',
      'ram:DirectDebitMandateID',
    ]);
    expect(terms?.getElementsByTagName('ram:DirectDebitMandateID')[0]?.textContent).toBe('MANDAT-0042');
  });

  it('schreibt BT-91, wenn das Konto der Zahlerin bekannt ist', () => {
    const x = parse(
      createCii({
        ...debit,
        directDebit: { ...debit.directDebit!, debtorIban: 'DE89370400440532013000' },
      }),
    );
    expect(x.first('ram:PayerPartyDebtorFinancialAccount')?.textContent).toBe(
      'DE89370400440532013000',
    );
  });

  it('weigert Lastschrift ohne Mandat', () => {
    expect(() => createCii({ ...DOCUMENT, paymentMeansCode: '59' })).toThrow(/Mandat/);
  });
});
