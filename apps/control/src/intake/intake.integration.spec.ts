import type { ConfigService } from '@nestjs/config';
import { AuditService } from '../audit/audit.service';
import { IssuerConfigService } from '../invoices/document/issuer.config';
import { IntakeService } from './intake.service';
import type { IntakeSendService } from './intake-send.service';
import { IntakeAccessService } from './intake-access.service';
import { mandateText } from './mandate-text';
import {
  createCompany,
  newPrefix,
  notesFrom,
  prisma,
  cleanUp,
  statusFrom,
  disconnect,
} from '../test-support/company-provisioning';

jest.setTimeout(60_000);

const Prefix = newPrefix('intake');
const Source = { ip: '203.0.113.42', userAgent: 'Jest-Integration' };
const audit = new AuditService(prisma);
const accesses = new IntakeAccessService(prisma, audit);
const config = { get: (_n: string, v?: string) => v } as unknown as ConfigService;
/**
 * Der Postausgang wird MITGESCHRIEBEN, nicht bedient.
 *
 * Die Eingangsmeldung an die Betreiberin ist der dritte Weg, auf dem sie vom
 * Formular erfährt; hier zählt, DASS sie ausgelöst wird und mit welcher
 * Mandatsreferenz — nicht, was der SMTP-Server damit tut.
 */
const reported: { companyId: string; name: string; reference: string | null }[] =
  [];
const send = {
  reportReceipt: (companyId: string, name: string, reference: string | null) => {
    reported.push({ companyId, name, reference });
    return Promise.resolve();
  },
} as unknown as IntakeSendService;

const service = new IntakeService(
  prisma,
  audit,
  accesses,
  new IssuerConfigService(config),
  send,
);

/** Ein vollständig ausgefülltes Formular ohne Lastschrift. */
const BankTransfer = {
  name: 'Solawi Beispiel eG',
  legalForm: 'eingetragene Genossenschaft',
  street: 'Hauptstraße',
  houseNumber: '4',
  postalCode: '79576',
  city: 'Weil am Rhein',
  contactName: 'Lena Brandt',
  contactEmail: 'lena@example.com',
  contactPhone: '+49 7621 123456',
  paymentInterval: 'yearly',
  paymentMethod: 'bank_transfer',
};

const DirectDebit = {
  ...BankTransfer,
  paymentInterval: 'monthly',
  paymentMethod: 'direct_debit',
  accountHolder: 'Solawi Beispiel eG',
  iban: 'DE02120300000000202051',
  mandate: 'ja',
};

async function withAccess() {
  const org = await createCompany(Prefix, { status: 'pilot_approved' });
  const { token } = await accesses.create(org.id, 'test', null);
  return { org, token };
}

afterAll(async () => {
  await cleanUp(Prefix);
  await disconnect();
});

describe('Das Absenden des Aufnahmeformulars', () => {
  it('schreibt alle Angaben und setzt die Quittung', async () => {
    const { org, token } = await withAccess();
    expect(await service.save(token, BankTransfer, Source)).toEqual({
      kind: 'saved',
    });

    const after = await prisma.company.findUniqueOrThrow({
      where: { id: org.id },
    });
    expect(after.legalForm).toBe('eingetragene Genossenschaft');
    expect(after.postalCode).toBe('79576');
    expect(after.contactEmail).toBe('lena@example.com');
    expect(after.intakeCompletedAt).not.toBeNull();
    // Ohne Lastschrift KEINE Bankdaten — auch kein leeres Mandat.
    expect(after.iban).toBeNull();
    expect(after.sepaMandateReference).toBeNull();
  });

  it('verbraucht den Zugang — ein zweites Absenden aendert nichts mehr', async () => {
    const { org, token } = await withAccess();
    await service.save(token, BankTransfer, Source);

    // Zweites Absenden mit ANDEREN Angaben: Es darf nichts ueberschreiben.
    const second = await service.save(
      token,
      { ...BankTransfer, city: 'Ganz woanders' },
      Source,
    );
    expect(second).toEqual({ kind: 'already_there' });

    const after = await prisma.company.findUniqueOrThrow({
      where: { id: org.id },
    });
    expect(after.city).toBe('Weil am Rhein');
  });

  it('schreibt NICHTS und verbraucht NICHTS, wenn Angaben fehlen', async () => {
    const { org, token } = await withAccess();
    const result = await service.save(
      token,
      { ...BankTransfer, city: '' },
      Source,
    );

    expect(result.kind).toBe('incomplete');
    if (result.kind === 'incomplete') {
      expect(result.error.map((f) => f.field)).toEqual(['city']);
    }

    // Der Datensatz ist unberuehrt …
    const after = await prisma.company.findUniqueOrThrow({
      where: { id: org.id },
    });
    expect(after.legalForm).toBeNull();
    expect(after.intakeCompletedAt).toBeNull();
    // … und der Link gilt weiter. Ein Tippfehler darf ihn nicht verbrennen.
    expect(await accesses.check(token)).not.toBeNull();
  });

  /** F11: `javascript:` aus dem öffentlichen Formular darf nie in `company.website` landen. */
  it('weist eine Website ohne http(s) ab und schreibt nichts', async () => {
    const { org, token } = await withAccess();
    const result = await service.save(
      token,
      { ...BankTransfer, website: 'javascript:alert(document.cookie)' },
      Source,
    );
    expect(result.kind).toBe('invalid');
    const after = await prisma.company.findUniqueOrThrow({ where: { id: org.id } });
    expect(after.website).toBeNull();
    expect(await accesses.check(token)).not.toBeNull();
  });

  /**
   * `required` im Markup blockt den Browser, nicht einen direkten POST
   * (Regel 2 der Projektkonventionen).
   */
  it('weist Lastschrift OHNE gesetztes Haekchen serverseitig ab', async () => {
    const { token } = await withAccess();
    const result = await service.save(
      token,
      { ...DirectDebit, mandate: '' },
      Source,
    );
    expect(result.kind).toBe('incomplete');
    if (result.kind === 'incomplete') {
      expect(result.error.map((f) => f.field)).toContain('sepaMandateGrantedAt');
    }
  });
});

describe('Das SEPA-Mandat', () => {
  it('vergibt eine Referenz und speichert den Wortlaut des SERVERS', async () => {
    const { org, token } = await withAccess();
    await service.save(token, DirectDebit, Source);

    const after = await prisma.company.findUniqueOrThrow({
      where: { id: org.id },
    });
    expect(after.sepaMandateReference).toMatch(/^SOZ-\d{4}-\d{4,}$/);
    expect(after.iban).toBe('DE02120300000000202051');
    expect(after.sepaMandateGrantedAt).not.toBeNull();
    expect(after.sepaMandateIp).toBe('203.0.113.42');

    // DER GESPEICHERTE WORTLAUT IST DER, DEN DER SERVER BAUT — Wort fuer Wort.
    // Ein Nachweis, dessen Text der Absender mitschickt, belegt nur, was der
    // Absender behauptet gelesen zu haben.
    const a = new IssuerConfigService(config).read();
    expect(after.sepaMandateText).toBe(
      mandateText({
        creditor: a.name,
        creditorId: a.creditorId,
        mandateReference: after.sepaMandateReference!,
        accountHolder: 'Solawi Beispiel eG',
        company: 'Solawi Beispiel eG',
      }),
    );
    // Und er nennt die Glaeubiger-ID und die Widerrufsfrist.
    expect(after.sepaMandateText).toContain(a.creditorId);
    expect(after.sepaMandateText).toContain('acht Wochen');
  });

  it('nimmt den Wortlaut NICHT aus dem Formular entgegen', async () => {
    const { org, token } = await withAccess();
    await service.save(
      token,
      {
        ...DirectDebit,
        // Ein untergeschobener Wortlaut — er darf nirgends landen.
        sepaMandateText: 'Ich ermaechtige zu allem und jederzeit.',
      },
      Source,
    );
    const after = await prisma.company.findUniqueOrThrow({
      where: { id: org.id },
    });
    expect(after.sepaMandateText).not.toContain('allem und jederzeit');
  });

  it('vergibt zwei Mandaten NIE dieselbe Referenz', async () => {
    const a = await withAccess();
    const b = await withAccess();
    await Promise.all([
      service.save(a.token, DirectDebit, Source),
      service.save(b.token, DirectDebit, Source),
    ]);
    const both = await prisma.company.findMany({
      where: { id: { in: [a.org.id, b.org.id] } },
      select: { sepaMandateReference: true },
    });
    const references = both.map((o) => o.sepaMandateReference);
    expect(new Set(references).size).toBe(2);
  });
});

describe('Der Nachweis', () => {
  it('schreibt eine Systemnotiz OHNE Fremdtext', async () => {
    const { org, token } = await withAccess();
    await service.save(
      token,
      { ...BankTransfer, name: 'Angreifer <script>' },
      Source,
    );
    const system = (await notesFrom(org.id)).filter((n) => n.bySystem);
    // Zwei: der Eingang und der Statuswechsel. Beide sind systemerzeugt und
    // damit unveraenderlich — in KEINER darf ein fremdes Wort stehen ([K1]).
    expect(system).toHaveLength(2);
    for (const note of system) {
      expect(note.text).not.toContain('Angreifer');
      expect(note.text).not.toContain('script');
    }
    expect(system.map((n) => n.text).join(' ')).toContain('Aufnahmeangaben');
  });

  it('schreibt die IBAN NIEMALS ins Audit-Log', async () => {
    const { org, token } = await withAccess();
    await service.save(token, DirectDebit, Source);

    const entries = await prisma.auditLog.findMany({
      where: { objectId: org.id, action: 'intake.received' },
    });
    expect(entries).toHaveLength(1);
    const raw = JSON.stringify(entries[0]);
    expect(raw).not.toContain('DE02120300000000202051');
    expect(raw).toContain('SOZ-');

    // DER WERT MUSS LESBAR SEIN, nicht bloss der Schluessel vorhanden.
    //
    // Vorher stand hier `expect(roh).toContain('ibanGesetzt')` — und das war
    // gruen, obwohl der Saeuberer des Audit-Logs den WERT durch «entfernt»
    // ersetzt hatte: Er vergleicht Feldnamen als Teilzeichenkette, und
    // `ibanGesetzt` enthaelt „iban". Der Schluessel blieb stehen, die Angabe
    // war weg, und `true` sah aus wie `false`. Ein Test, der nur den
    // Schluessel prueft, kann genau das nicht bemerken.
    const after = entries[0].afterValue as Record<string, unknown>;
    expect(after['bankDetailsStored']).toBe(true);
  });
});

describe('Die Rechnungsadresse', () => {
  it('bleibt leer, wenn „wie oben" angehakt ist', async () => {
    const { org, token } = await withAccess();
    await service.save(
      token,
      { ...BankTransfer, billingSameAsAbove: 'ja', billingCity: 'Wird ignoriert' },
      Source,
    );
    const after = await prisma.company.findUniqueOrThrow({
      where: { id: org.id },
    });
    // Bewusst KEINE Kopie der Anschrift: Ein leeres Feld heisst „wie oben"
    // und bleibt richtig, wenn die Organisation umzieht.
    expect(after.billingCity).toBeNull();
    expect(after.city).toBe('Weil am Rhein');
  });

  it('uebernimmt eine abweichende Adresse', async () => {
    const { org, token } = await withAccess();
    await service.save(
      token,
      { ...BankTransfer, billingName: 'Trägerverein e. V.', billingCity: 'Freiburg' },
      Source,
    );
    const after = await prisma.company.findUniqueOrThrow({
      where: { id: org.id },
    });
    expect(after.billingName).toBe('Trägerverein e. V.');
    expect(after.billingCity).toBe('Freiburg');
  });
});

describe('Der Statuswechsel nach dem Absenden', () => {
  it('wechselt von pilot_beschlossen auf pilot_laufend', async () => {
    const { org, token } = await withAccess();
    await service.save(token, BankTransfer, Source);
    expect(await statusFrom(org.id)).toBe('pilot_running');
  });

  /**
   * Steht die Organisation woanders, hat jemand von Hand eingegriffen — ein
   * automatischer Wechsel waere eine Entscheidung ueber einen Fall, den das
   * System nicht kennt. Das bedingte UPDATE trifft dann keine Zeile.
   */
  it('greift NICHT ein, wenn die Organisation woanders steht', async () => {
    const org = await createCompany(Prefix, { status: 'paying' });
    const { token } = await accesses.create(org.id, 'test', null);
    await service.save(token, BankTransfer, Source);
    expect(await statusFrom(org.id)).toBe('paying');
  });

  it('schreibt genau EINE Systemnotiz zum Wechsel', async () => {
    const { org, token } = await withAccess();
    await service.save(token, BankTransfer, Source);
    const change = (await notesFrom(org.id)).filter((n) =>
      n.text.startsWith('Status automatisch gewechselt'),
    );
    expect(change).toHaveLength(1);
  });
});

/**
 * Die Betreiberin erfaehrt vom Eingang auf DREI Wegen: Systemnotiz,
 * Statuswechsel und diese Meldung. Die ersten beiden sieht nur, wer ins CRM
 * schaut; die dritte kommt ins Postfach — dieselbe Redundanz wie bei der
 * Anfrage-Benachrichtigung.
 */
describe('Die Eingangsmeldung an die Betreiberin', () => {
  it('geht bei jedem angenommenen Formular hinaus', async () => {
    reported.length = 0;
    const { org, token } = await withAccess();
    await service.save(token, BankTransfer, Source);

    expect(reported).toEqual([
      { companyId: org.id, name: BankTransfer.name, reference: null },
    ]);
  });

  it('nennt die Mandatsreferenz, wenn ein Mandat erteilt wurde', async () => {
    reported.length = 0;
    const { token } = await withAccess();
    await service.save(token, DirectDebit, Source);

    expect(reported).toHaveLength(1);
    expect(reported[0].reference).toMatch(/^SOZ-\d{4}-\d{4}$/);
  });

  it('geht NICHT hinaus, wenn der Zugang schon verbraucht war', async () => {
    const { token } = await withAccess();
    await service.save(token, BankTransfer, Source);
    reported.length = 0;

    await service.save(token, BankTransfer, Source);
    expect(reported).toEqual([]);
  });
});
