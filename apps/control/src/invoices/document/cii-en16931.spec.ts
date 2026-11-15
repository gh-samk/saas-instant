import { ISSUER_PRESETS } from './issuer.config';
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
  issuer: ISSUER_PRESETS,
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

  /**
   * KEINE EXTERNEN RESSOURCEN.
   *
   * Was beim Rendern fehlt, fehlt STILL: Das PDF entstünde trotzdem, nur ohne
   * Logo, und niemand bekäme eine Fehlermeldung.
   */
  it('druckt ohne Komplementärin keinen Block und kein erfundenes Land', () => {
    const bare = createHtml({
      ...DOCUMENT,
      issuer: {
        ...DOCUMENT.issuer,
        address: { ...DOCUMENT.issuer.address, country: '' },
        generalPartner: {
          name: '',
          seat: '',
          registerCourt: '',
          registerIdentifier: '',
          managingDirector: [],
        },
      },
    });
    expect(bare).not.toContain('Persönlich haftende Gesellschafterin');
    expect(bare).not.toContain('Geschäftsführer:');
    expect(bare).not.toContain('Deutschland');
  });

  it('nennt das Land aus dem Code der Ausstellerin', () => {
    expect(html).toContain(`${ISSUER_PRESETS.address.city}, Deutschland`);
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
  it('nennt genau eine Schrift ohne Rückfallkette', () => {
    const hits = [...html.matchAll(/font-family:\s*([^;]+);/g)].map((t) =>
      (t[1] ?? '').trim(),
    );
    expect(hits).toEqual(['"DejaVu Sans"']);
  });

  it('trägt alle Pflichtangaben sichtbar im Dokument', () => {
    expect(html).toContain('2026-001');
    expect(html).toContain('Kollektiv Grünspecht e. V.');
    expect(html).toContain(`USt-IdNr. ${ISSUER_PRESETS.vatId}`);
    expect(html).toContain(ISSUER_PRESETS.registerIdentifier);
    expect(html).toContain(ISSUER_PRESETS.generalPartner.registerIdentifier);
    // Netto, Steuer und Brutto stehen getrennt.
    expect(html).toContain('Summe netto');
    expect(html).toContain('19 % USt.');
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
    expect(html).toContain('factur-x.xml');
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
