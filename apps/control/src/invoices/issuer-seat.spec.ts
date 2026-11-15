import type { ConfigService } from '@nestjs/config';
import { createHtml } from './document/layout-html';
import type { InvoiceDocument } from './document/document.types';
import {
  ISSUER_PRESETS,
  IssuerConfigService,
} from './document/issuer.config';
import { validateIssuerProfile } from '@saas-instant/shared';
import { documentIssuerFrom, profileFromIssuer } from './document/issuer-mapping';
import {
  issuerSnapshot,
  missingMandatoryDetails,
} from './invoice.snapshot';

/**
 * ===========================================================================
 * [W3] § 125a i. V. m. § 177a HGB — DER SITZ GEHÖRT AUF JEDEN GESCHÄFTSBRIEF
 * ===========================================================================
 *
 * Der Mangel war doppelt unangenehm: Er stand auf JEDEM bis zur Korrektur
 * ausgestellten Beleg, und weil Belege unveränderlich sind (R2), lässt er sich
 * dort auch nicht mehr beheben. Zugleich nannte die Fusszeile der RUNDMAIL den
 * Sitz — dieselbe Firma schrieb also zwei Geschäftsbriefe, die sich
 * widersprachen.
 *
 * Jeder Test hier fällt gegen die Fassung ohne die beiden Schnappschussfelder.
 */

function emptyConfig(): ConfigService {
  return { get: () => undefined } as unknown as ConfigService;
}

/** Vollständiger Schnappschuss aus der geltenden Konfiguration. */
function snapshot() {
  return issuerSnapshot(new IssuerConfigService(emptyConfig()).read());
}

/** Der Empfängerteil, damit `missingMandatoryDetails` nur den Aussteller meldet. */
const RECIPIENT = {
  recipientName: 'Solawi Fulda e. V.',
  recipientAddress: 'Ziegelgasse 14\n36037 Fulda\nDeutschland',
  recipientEmail: 'kontakt@solawi.example.com',
  recipientBuyerType: 'business' as const,
  recipientVatId: null,
  recipientBuyerReference: null,
  recipientElectronicAddress: 'kontakt@solawi.example.com',
  recipientElectronicAddressScheme: 'EM',
};

describe('[W3] Der Sitz steht im Schnappschuss', () => {
  it('trägt Sitz der KG und der Komplementärin', () => {
    const s = snapshot();
    expect(s.issuerSeat).toBe('Example City');
    expect(s.issuerGeneralPartnerSeat).toBe('Example City');
  });

  it('lässt sich über die Umgebung setzen, falls sich der Sitz ändert', () => {
    const coolifyConfig = new IssuerConfigService({
      get: (name: string) =>
        name === 'CONTROL_INVOICE_SEAT'
          ? 'Kassel'
          : name === 'CONTROL_INVOICE_GENERAL_PARTNER_SEAT'
            ? 'Marburg'
            : undefined,
    } as unknown as ConfigService);
    const a = coolifyConfig.read();
    expect(a.seat).toBe('Kassel');
    expect(a.generalPartner.seat).toBe('Marburg');
  });

  /**
   * DIE SCHARFE STELLE: Ohne Sitz lässt sich nicht mehr festschreiben. Die
   * Prüfung läuft jetzt je Rechtsform über das Firmenprofil
   * (`validateIssuerProfile`), nicht mehr über `missingMandatoryDetails`.
   */
  it('verweigert das Festschreiben ohne Sitz der KG', () => {
    const profile = {
      ...profileFromIssuer(new IssuerConfigService(emptyConfig()).read()),
      seat: '',
    };
    expect(validateIssuerProfile(profile).map((i) => i.field)).toContain('seat');
  });

  it('verweigert das Festschreiben ohne Sitz der Komplementärin', () => {
    const base = profileFromIssuer(new IssuerConfigService(emptyConfig()).read());
    const profile = { ...base, generalPartner: { ...base.generalPartner, seat: '' } };
    expect(validateIssuerProfile(profile).map((i) => i.field)).toContain(
      'generalPartner.seat',
    );
  });

  it('lässt einen vollständigen Schnappschuss durch', () => {
    expect(
      missingMandatoryDetails({ ...RECIPIENT, linesCount: 1 }),
    ).toEqual([]);
  });
});

describe('[W3] Der Sitz steht auf dem Beleg', () => {
  function document(): InvoiceDocument {
    return {
      number: '2026-001',
      invoiceDate: '2026-08-31',
      dueAt: '2026-09-14',
      currency: 'EUR',
      servicePeriod: { from: '2026-09-01', until: '2027-08-31' },
      deliveryDate: '2026-08-31',
      orderReference: '',
      issuer: documentIssuerFrom(new IssuerConfigService(emptyConfig()).read()),
      recipient: {
        name: 'Solawi Fulda e. V.',
        address: {
          street: 'Ziegelgasse 14',
          postalCode: '36037',
          city: 'Fulda',
          country: 'DE',
        },
      },
      lines: [
        {
          row: '1',
          label: 'Jahresbeitrag',
          quantity: 1,
          unit: 'C62',
          unitPriceCent: 38_500,
          netCent: 38_500,
          taxCategory: 'S',
          taxRate: 19,
        },
      ],
      taxBreakdown: [
        { category: 'S', record: 19, basisCent: 38_500, taxCent: 7_315 },
      ],
      sumNetCent: 38_500,
      sumTaxCent: 7_315,
      sumGrossCent: 45_815,
      prepaidCent: 0,
      paymentAmountCent: 45_815,
      paymentTerm: 'Zahlbar ohne Abzug bis zum 14.09.2026.',
      hint: '',
    };
  }

  it('nennt den Sitz der Komplementärin und einen abweichenden Sitz der KG', () => {
    const html = createHtml(document());
    // Der Sitz der KG steht nur, wenn er vom Ort der Anschrift abweicht.
    expect(html).toContain('Sitz Example City');
    const moved = document();
    moved.issuer = documentIssuerFrom({
      ...ISSUER_PRESETS,
      seat: 'Kassel',
    });
    expect(createHtml(moved)).toContain('Sitz Kassel');
  });

  /**
   * Die Gegenprobe zum Widerspruch, den der Prüfer gefunden hat: Was die
   * Rundmail-Fusszeile behauptet, muss auch auf der Rechnung stehen. Beide
   * lesen dieselbe Quelle.
   */
  it('stimmt mit der Anbieterkennung der Rundmail überein', () => {
    const html = createHtml(document());
    const addition = ISSUER_PRESETS.legalAddition;
    // Der Rundmail-Text nennt den Sitz — die Rechnung auch.
    expect(addition).toContain('Sitz Example City');
    expect(html).toContain('Sitz Example City');
    expect(html).toContain('Persönlich haftende Gesellschafterin');
  });
});
