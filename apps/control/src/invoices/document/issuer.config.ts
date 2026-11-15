import { Injectable, Optional } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ManifestService } from '../../manifest/manifest.service';
import {
  DEFAULT_RETENTION_YEARS,
  ISSUER_LEGAL_FORMS,
  type IssuerLegalForm,
  type IssuerManifest,
} from '../../manifest/sections/billing';

/**
 * DIE AUSSTELLERDATEN — Pflichtangaben nach § 14 UStG und § 125a HGB.
 *
 * Die Vorgaben im Quelltext sind NEUTRALE PLATZHALTER. Die echten Angaben
 * kommen aus dem Manifest (`billing.issuer`) oder aus der Umgebung.
 *
 * REIHENFOLGE: Umgebungsvariable vor Manifest vor neutraler Vorgabe.
 *
 * Die Angaben sind keine Zugangsdaten: Sie stehen auf jeder Rechnung und
 * im Handelsregister. Ein Platzhalter statt einer leeren Vorgabe sorgt dafür,
 * dass eine unvollständige Konfiguration nicht still eine Rechnung ohne
 * Bankverbindung erzeugt.
 *
 * § 125a HGB (i. V. m. § 177a HGB) verlangt auf Geschäftsbriefen einer
 * GmbH & Co KG: Rechtsform und Sitz der KG, Registergericht und HRA, dazu die
 * persönlich haftende Gesellschafterin mit eigener Rechtsform, Sitz,
 * Registergericht und HRB sowie deren Geschäftsführer. In EN 16931 gibt es
 * dafür kein eigenes Feld je Angabe; der Block steht als BT-33
 * (`ram:SellerTradeParty/ram:Description`), die HRA zusätzlich strukturiert
 * als BT-30.
 */
export interface Issuer {
  /**
   * Rechtsform für die Pflichtprüfung beim Festschreiben. `company` =
   * Handelsgesellschaft (Sitz/Register Pflicht), `sole_proprietor` und
   * `association` ohne Registerpflicht auf der Rechnung.
   */
  legalForm: IssuerLegalForm;
  name: string;
  address: { street: string; postalCode: string; city: string; country: string };
  /**
   * SITZ DER KG im Sinne des § 125a HGB.
   *
   * Nicht dasselbe wie die Geschäftsanschrift, auch wenn beide hier
   * zusammenfallen: Der Sitz ist eine Angabe aus dem Gesellschaftsvertrag, die
   * Anschrift eine Postadresse. Sie können auseinanderfallen, und dann ist der
   * Sitz die Pflichtangabe ([W3]).
   */
  seat: string;
  vatId: string;
  /**
   * Die Gläubiger-Identifikationsnummer für SEPA-Lastschriften.
   *
   * SIE STEHT IN DEN VORGABEN, wie IBAN, BIC und Umsatzsteuer-Identnummer —
   * und aus demselben Grund: Sie ist kein Geheimnis, sondern eine Angabe, die
   * auf jeder Vorabankündigung und jedem Mandat gedruckt wird. Wer sie
   * kennt, kann damit nichts abbuchen; einziehen kann nur, wer bei der Bank
   * als Gläubiger geführt wird.
   *
   * SIE WURDE NICHT ERFUNDEN, sondern von der Betreiberin genannt und
   * gegengerechnet: 18 Stellen, Prüfziffern nach ISO 7064 MOD 97-10 gültig
   * (`creditor-id.spec.ts` rechnet es bei jedem Lauf nach). Der einzige
   * erfundene Beleg in der ganzen Anbindung war einer zu viel ([W2]).
   *
   * Beantragt wird sie bei der Deutschen Bundesbank. Ein LEERER Wert bleibt
   * ein Fehler: Wer sie über die Umgebung überschreibt und dabei vertippt,
   * bekommt keinen Beleg, sondern eine Meldung.
   */
  creditorId: string;
  registerIdentifier: string;
  registerCourt: string;
  generalPartner: {
    name: string;
    /** Sitz der Komplementärin — von § 125a i. V. m. § 177a HGB verlangt. */
    seat: string;
    registerCourt: string;
    registerIdentifier: string;
    managingDirector: string[];
  };
  contact: { name: string; phone: string; email: string };
  bank: { institution: string; iban: string; bic: string };
  /** BT-33: der § 125a-HGB-Block als Fließtext. */
  legalAddition: string;
}

export const ISSUER_PRESETS: Issuer = {
  legalForm: 'company',
  name: 'Example Company GmbH & Co KG',
  address: {
    street: 'Example Street 1',
    postalCode: '12345',
    city: 'Example City',
    country: 'DE',
  },
  seat: 'Example City',
  vatId: 'DE123456789',
  // Rechnerisch gültiges Beispiel (ISO 7064 MOD 97-10), keine echte Kennung.
  creditorId: 'DE09ZZZ00000000001',
  // BT-30 ohne schemeID: Für das deutsche Handelsregister gibt es keine
  // Kennung in der von EN 16931 referenzierten ISO-6523-Liste. Ein erfundener
  // schemeID wäre schlimmer als keiner.
  registerIdentifier: 'HRA 00000',
  registerCourt: 'Amtsgericht Example City',
  generalPartner: {
    name: 'Example Management GmbH',
    seat: 'Example City',
    registerCourt: 'Amtsgericht Example City',
    registerIdentifier: 'HRB 00000',
    managingDirector: ['Erika Mustermann'],
  },
  contact: {
    name: 'Rechnungsstelle',
    phone: '+49 000 0000000',
    email: 'billing@example.com',
  },
  bank: {
    institution: 'Example Bank',
    iban: 'DE02120300000000202051',
    bic: 'BYLADEM1001',
  },
  legalAddition: [
    'Example Company GmbH & Co KG, Sitz Example City, Amtsgericht Example City HRA 00000.',
    'Persönlich haftende Gesellschafterin: Example Management GmbH,',
    'Sitz Example City, Amtsgericht Example City HRB 00000.',
    'Geschäftsführer: Erika Mustermann.',
  ].join(' '),
};

/**
 * Ist das noch der neutrale Platzhalter-Aussteller aus `ISSUER_PRESETS`?
 *
 * Eine Rechnung mit der Platzhalterfirma, der Beispiel-USt-IdNr. oder der
 * Beispiel-IBAN ist kein Beleg, sondern ein Muster — sie darf nicht
 * festgeschrieben werden. Geprüft wird auf die Platzhalterwerte selbst, nicht
 * auf „Example" irgendwo im Text.
 */
export function isPlaceholderIssuer(issuer: Issuer): boolean {
  return (
    /^Example Company\b/i.test(issuer.name.trim()) ||
    issuer.vatId.trim() === ISSUER_PRESETS.vatId ||
    issuer.bank.iban.replace(/\s+/g, '') === ISSUER_PRESETS.bank.iban
  );
}

/**
 * Die Manifest-Angaben als Teil-Aussteller. Strukturierte Felder haben
 * Vorrang; fehlen sie, werden Anschrift und Bankverbindung aus den
 * Freitextfeldern `address` und `bankDetails` abgeleitet, soweit sie sich
 * zerlegen lassen.
 */
export function issuerFromManifest(m: IssuerManifest): {
  legalForm?: IssuerLegalForm;
  name?: string;
  street?: string;
  postalCode?: string;
  city?: string;
  country?: string;
  seat?: string;
  vatId?: string;
  creditorId?: string;
  registerCourt?: string;
  registerIdentifier?: string;
  contactName?: string;
  phone?: string;
  email?: string;
  institution?: string;
  iban?: string;
  bic?: string;
  legalAddition?: string;
  generalPartnerName?: string;
  generalPartnerSeat?: string;
  generalPartnerRegisterCourt?: string;
  generalPartnerRegisterIdentifier?: string;
  managingDirector?: string[];
} {
  // „Straße 1, 12345 Ort" → Straße / PLZ / Ort
  const address = /^(.+?),\s*(\d{4,5})\s+(.+)$/.exec(m.address.trim());
  const ibanFromText = /IBAN\s+([A-Z]{2}[0-9A-Z ]+?)(?:,|;|\s+BIC\b|$)/i.exec(
    m.bankDetails ?? '',
  )?.[1];
  const bicFromText = /BIC\s+([A-Z0-9]{8,11})/i.exec(m.bankDetails ?? '')?.[1];
  const institutionFromText = /^(.+?)\s*,\s*IBAN\b/i.exec(m.bankDetails ?? '')?.[1];
  const withoutEmpty = (w: string | null | undefined): string | undefined =>
    w && w.trim() !== '' ? w.trim() : undefined;
  return {
    legalForm: m.legalForm ?? undefined,
    name: withoutEmpty(m.name),
    street: withoutEmpty(m.street) ?? withoutEmpty(address?.[1]),
    postalCode: withoutEmpty(m.postalCode) ?? withoutEmpty(address?.[2]),
    city: withoutEmpty(m.city) ?? withoutEmpty(address?.[3]),
    country: withoutEmpty(m.country),
    seat: withoutEmpty(m.seat),
    vatId: withoutEmpty(m.taxId),
    creditorId: withoutEmpty(m.creditorId),
    registerCourt: withoutEmpty(m.registerCourt),
    registerIdentifier: withoutEmpty(m.registerNumber),
    contactName: withoutEmpty(m.contactName),
    phone: withoutEmpty(m.phone),
    email: withoutEmpty(m.email),
    institution: withoutEmpty(m.bankName) ?? withoutEmpty(institutionFromText),
    iban: withoutEmpty(m.iban) ?? withoutEmpty(ibanFromText?.replace(/\s+/g, '')),
    bic: withoutEmpty(m.bic) ?? withoutEmpty(bicFromText),
    legalAddition: withoutEmpty(m.legalNotice),
    generalPartnerName: withoutEmpty(m.generalPartnerName),
    generalPartnerSeat: withoutEmpty(m.generalPartnerSeat),
    generalPartnerRegisterCourt: withoutEmpty(m.generalPartnerRegisterCourt),
    generalPartnerRegisterIdentifier: withoutEmpty(m.generalPartnerRegisterNumber),
    managingDirector: (m.managingDirectors ?? '')
      .split(',')
      .map((entry) => entry.trim())
      .filter((entry) => entry !== ''),
  };
}

/** Keine persönlich haftende Gesellschafterin: nichts wird gedruckt oder verlangt. */
const NO_GENERAL_PARTNER: Issuer['generalPartner'] = {
  name: '',
  seat: '',
  registerCourt: '',
  registerIdentifier: '',
  managingDirector: [],
};

@Injectable()
export class IssuerConfigService {
  constructor(
    private readonly config: ConfigService,
    @Optional() private readonly manifest?: ManifestService,
  ) {}

  private value(name: string, preset: string): string {
    return this.config.get<string>(name)?.trim() || preset;
  }

  read(): Issuer {
    const preset = ISSUER_PRESETS;
    const m = this.manifest
      ? issuerFromManifest(this.manifest.billing.issuer)
      : {};
    // Vorgaben, die das Manifest überlagert: Umgebung > Manifest > neutral.
    const v: Issuer = {
      ...preset,
      legalForm: m.legalForm ?? preset.legalForm,
      name: m.name ?? preset.name,
      address: {
        street: m.street ?? preset.address.street,
        postalCode: m.postalCode ?? preset.address.postalCode,
        city: m.city ?? preset.address.city,
        country: m.country ?? preset.address.country,
      },
      seat: m.seat ?? m.city ?? preset.seat,
      vatId: m.vatId ?? preset.vatId,
      creditorId: m.creditorId ?? preset.creditorId,
      registerIdentifier: m.registerIdentifier ?? preset.registerIdentifier,
      registerCourt: m.registerCourt ?? preset.registerCourt,
      // MIT MANIFEST kommt die Gesellschafterin ausschließlich von dort: Was
      // nicht gesetzt ist, bleibt leer und wird nicht gedruckt (kein
      // erfundener Platzhalter). Ohne Manifest (nur Tests) gilt der Platzhalter.
      generalPartner: this.manifest
        ? {
            name: m.generalPartnerName ?? '',
            seat: m.generalPartnerSeat ?? '',
            registerCourt: m.generalPartnerRegisterCourt ?? '',
            registerIdentifier: m.generalPartnerRegisterIdentifier ?? '',
            managingDirector: m.managingDirector ?? [],
          }
        : preset.generalPartner,
      contact: {
        name: m.contactName ?? preset.contact.name,
        phone: m.phone ?? preset.contact.phone,
        email: m.email ?? preset.contact.email,
      },
      bank: {
        institution: m.institution ?? preset.bank.institution,
        iban: m.iban ?? preset.bank.iban,
        bic: m.bic ?? preset.bank.bic,
      },
      legalAddition:
        m.legalAddition ??
        // Hat das Manifest einen eigenen Namen, darf der Zusatz nicht noch die
        // Platzhalterfirma nennen: dann aus den Manifest-Angaben ableiten.
        (m.name
          ? [
              `${m.name}, Sitz ${m.seat ?? m.city ?? preset.seat}`,
              m.registerCourt && m.registerIdentifier
                ? `${m.registerCourt} ${m.registerIdentifier}`
                : null,
            ]
              .filter((t): t is string => t !== null)
              .join(', ') +
            (m.generalPartnerName
              ? `. Persönlich haftende Gesellschafterin: ${m.generalPartnerName}` +
                (m.generalPartnerSeat ? `, Sitz ${m.generalPartnerSeat}` : '') +
                (m.generalPartnerRegisterCourt && m.generalPartnerRegisterIdentifier
                  ? `, ${m.generalPartnerRegisterCourt} ${m.generalPartnerRegisterIdentifier}`
                  : '') +
                ((m.managingDirector ?? []).length > 0
                  ? `. Geschäftsführer: ${(m.managingDirector ?? []).join(', ')}`
                  : '') +
                '.'
              : '.')
          : preset.legalAddition),
    };
    const managingDirector = this.config
      .get<string>('CONTROL_INVOICE_MANAGING_DIRECTOR')
      ?.split(',')
      .map((entry) => entry.trim())
      .filter((entry) => entry !== '');

    const legalFormEnv = this.config
      .get<string>('CONTROL_INVOICE_LEGAL_FORM')
      ?.trim();
    const legalForm = (ISSUER_LEGAL_FORMS as readonly string[]).includes(
      legalFormEnv ?? '',
    )
      ? (legalFormEnv as IssuerLegalForm)
      : v.legalForm;

    return {
      legalForm,
      name: this.value('CONTROL_INVOICE_ISSUER', v.name),
      address: {
        street: this.value('CONTROL_INVOICE_STREET', v.address.street),
        postalCode: this.value('CONTROL_INVOICE_POSTAL_CODE', v.address.postalCode),
        city: this.value('CONTROL_INVOICE_CITY', v.address.city),
        country: this.value('CONTROL_INVOICE_COUNTRY', v.address.country),
      },
      seat: this.value('CONTROL_INVOICE_SEAT', v.seat),
      vatId: this.value('CONTROL_INVOICE_USTIDNR', v.vatId),
      creditorId: this.value('CONTROL_INVOICE_CREDITOR_ID', v.creditorId),
      registerIdentifier: this.value('CONTROL_INVOICE_COMMERCIAL_REGISTER_A', v.registerIdentifier),
      registerCourt: this.value(
        'CONTROL_INVOICE_REGISTER_COURT',
        v.registerCourt,
      ),
      generalPartner: {
        name: this.value('CONTROL_INVOICE_GENERAL_PARTNER', v.generalPartner.name),
        seat: this.value(
          'CONTROL_INVOICE_GENERAL_PARTNER_SEAT',
          v.generalPartner.seat,
        ),
        registerCourt: this.value(
          'CONTROL_INVOICE_GENERAL_PARTNER_GERICHT',
          v.generalPartner.registerCourt,
        ),
        registerIdentifier: this.value(
          'CONTROL_INVOICE_COMMERCIAL_REGISTER_B',
          v.generalPartner.registerIdentifier,
        ),
        managingDirector:
          managingDirector && managingDirector.length > 0
            ? managingDirector
            : v.generalPartner.managingDirector,
      },
      contact: {
        name: this.value('CONTROL_INVOICE_CONTACT_NAME', v.contact.name),
        phone: this.value('CONTROL_INVOICE_PHONE', v.contact.phone),
        email: this.value('CONTROL_INVOICE_EMAIL', v.contact.email),
      },
      bank: {
        institution: this.value('CONTROL_INVOICE_BANK', v.bank.institution),
        iban: this.value('CONTROL_INVOICE_IBAN', v.bank.iban),
        bic: this.value('CONTROL_INVOICE_BIC', v.bank.bic),
      },
      legalAddition: this.value(
        'CONTROL_INVOICE_LEGAL_ADDITION',
        v.legalAddition,
      ),
    };
  }

  /**
   * Aufbewahrungsfrist in Jahren (Manifest `billing.retentionYears`,
   * Vorgabe 8). Die Dauer klärt der Betreiber mit der Steuerberatung.
   */
  retentionYears(): number {
    return this.manifest?.billing.retentionYears ?? DEFAULT_RETENTION_YEARS;
  }
}
