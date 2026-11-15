import { ISSUER_PRESETS } from './issuer.config';
import { documentIssuerFrom } from './issuer-mapping';
import { createCii } from './cii-en16931';
import { createHtml } from './layout-html';
import type { InvoiceDocument } from './document.types';

/**
 * DIE TEXTE, DIE GESPEICHERT WURDEN UND AUF KEINEM BELEG ANKAMEN.
 *
 * Beim Umbau auf den Bearbeiten-Screen bekam die Rechnung drei Textfelder
 * (Einleitung, Zahlungshinweis, interne Notiz) und der Posten zwei Daten
 * (Zeitraum von/bis). Geschrieben wurden sie sofort — gedruckt zunächst
 * nicht: Der Zusammenbau in `document.service.ts` liess sie fallen.
 *
 * Das ist DERSELBE Fehlertyp wie [H2] (`einheit` wurde gespeichert und im XML
 * stand fest `C62`): Die Betreiberin tippt einen Satz, das System bestätigt
 * das Speichern, und auf der Rechnung steht er nicht. Auffallen würde es
 * frühestens der Empfängerin.
 *
 * Diese Tests prüfen die AUSGABE, nicht die Spalte. Eine Spalte, die niemand
 * rendert, ist kein Feld, sondern ein Versprechen.
 */

const REASON: InvoiceDocument = {
  number: '2026-004',
  invoiceDate: '2026-08-31',
  dueAt: '2026-09-14',
  currency: 'EUR',
  servicePeriod: { from: '2026-09-01', until: '2027-08-31' },
  deliveryDate: '2026-09-01',
  orderReference: '2026-004',
  issuer: documentIssuerFrom(ISSUER_PRESETS),
  recipient: {
    name: 'Kollektiv Grünspecht e. V.',
    address: { street: 'Ziegelgasse 14', postalCode: '99423', city: 'Weimar', country: 'DE' },
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

describe('Einleitung und Zahlungshinweis stehen auf dem Beleg', () => {
  const withTexts: InvoiceDocument = {
    ...REASON,
    introduction: 'wie im Mai besprochen, hier die Rechnung für das kommende Jahr.',
    paymentNote: 'Bitte im Verwendungszweck die Rechnungsnummer angeben.',
  };

  it('druckt keinen Einleitungssatz in das PDF (Entwurf B)', () => {
    expect(createHtml(withTexts)).not.toContain('wie im Mai besprochen');
  });

  it('druckt den Zahlungshinweis in das PDF', () => {
    expect(createHtml(withTexts)).toContain(
      'Bitte im Verwendungszweck die Rechnungsnummer angeben.',
    );
  });

  it('trägt die Einleitung als IncludedNote in das XML', () => {
    expect(createCii(withTexts)).toContain(
      '<ram:IncludedNote><ram:Content>wie im Mai besprochen, hier die Rechnung für das kommende Jahr.</ram:Content></ram:IncludedNote>',
    );
  });

  it('hängt den Zahlungshinweis an die Zahlungsbedingung des XML', () => {
    // BT-20. Ein Zahlungshinweis IST eine Zahlungsbedingung — er gehört
    // dorthin, nicht in eine freie Notiz, wo ihn keine Software liest.
    expect(createCii(withTexts)).toContain(
      '<ram:Description>Zahlbar ohne Abzug bis zum 14.09.2026. ' +
        'Bitte im Verwendungszweck die Rechnungsnummer angeben.</ram:Description>',
    );
  });

  it('lässt beide weg, wenn sie leer sind — keine leere Zeile auf dem Beleg', () => {
    const html = createHtml(REASON);
    expect(html).not.toContain('class="einleitung"');
    // Die Zahlungsbedingung steht allein, ohne angehängtes Leerzeichen.
    expect(createCii(REASON)).toContain(
      '<ram:Description>Zahlbar ohne Abzug bis zum 14.09.2026.</ram:Description>',
    );
  });

  it('maskiert die Texte, statt sie als Markup zu deuten', () => {
    const boes: InvoiceDocument = {
      ...REASON,
      introduction: 'Rabatt <b>5 %</b> & mehr',
    };
    expect(createHtml(boes)).not.toContain('Rabatt');
    expect(createCii(boes)).toContain('Rabatt &lt;b&gt;5 %&lt;/b&gt; &amp; mehr');
  });
});

describe('Der Zeitraum je Posten', () => {
  const withPeriod: InvoiceDocument = {
    ...REASON,
    lines: [
      {
        ...REASON.lines[0]!,
        description: 'Zugang für bis zu 60 Teilhabende',
        period: { from: '2026-09-01', until: '2027-08-31' },
      },
    ],
  };

  it('steht nicht als Unterzeile im PDF (Entwurf B: nur Leistung fett)', () => {
    expect(
      createHtml({
        ...withPeriod,
        lines: [{ ...withPeriod.lines[0]!, period: { from: '2026-10-05', until: '2026-10-20' } }],
      }),
    ).not.toContain('05.10.2026');
  });

  it('steht als BillingSpecifiedPeriod an der XML-Zeile', () => {
    const xml = createCii(withPeriod);
    // Zweimal: einmal am Posten, einmal am Kopf. Der Kopfzeitraum ist
    // derselbe — der Test prüft, dass der POSTEN einen eigenen bekommt.
    const hits = xml.match(/<ram:BillingSpecifiedPeriod>/g) ?? [];
    expect(hits).toHaveLength(2);
  });

  it('trägt die Beschreibung ins XML, aber nicht als Unterzeile ins PDF', () => {
    expect(createHtml(withPeriod)).not.toContain('Zugang für bis zu 60 Teilhabende');
    expect(createCii(withPeriod)).toContain(
      '<ram:Description>Zugang für bis zu 60 Teilhabende</ram:Description>',
    );
  });

  it('lässt die Zeile ohne Zeitraum unverändert', () => {
    const hits = (createCii(REASON).match(/<ram:BillingSpecifiedPeriod>/g) ?? []).length;
    expect(hits).toBe(1);
  });
});
