import { randomUUID } from 'crypto';
import type { ConfigService } from '@nestjs/config';
import * as nodemailer from 'nodemailer';
import { AUDIT_ACTION, AuditService } from '../audit/audit.service';
import { ConsentService } from '../consent/consent.service';
import type { MailService } from '../mail/mail.service';
import { setTestBrand } from '../mail/layout/test-brand';
import {
  createCompany,
  newPrefix,
  prisma,
  cleanUp,
  cleanUpConsents,
  cleanUpTemplates,
  disconnect,
} from '../test-support/company-provisioning';
import { TemplateService } from './template.service';
import { MAX_ATTEMPTS, QueueService } from './queue.service';
import { MarketingMailService } from './marketing-mail.service';

beforeAll(() => setTestBrand());

jest.mock('nodemailer', () => ({ createTransport: jest.fn() }));

/**
 * ===========================================================================
 * R3 GEGEN EINE ECHTE DATENBANK — „auch nicht durch Fehlbedienung"
 * ===========================================================================
 *
 * Die Aussagen dieser Suite sind die, an denen die ganze Etappe hängt:
 *
 * - Eine werbliche Mail an eine Adresse OHNE bestätigtes Opt-in geht nicht
 *   hinaus. Auch dann nicht, wenn jemand die Warteschlangenzeile von Hand
 *   anlegt — das ist der direkteste denkbare Aufruf, direkter als über die
 *   API.
 * - Wer zwischen Auswahl und Versand widerruft, bekommt nichts.
 * - Nie mehr als eine Adresse in einer Mail.
 * - Drei erfolglose Zustellungen in Folge legen die Adresse still, ein Erfolg
 *   dazwischen setzt zurück.
 *
 * Voraussetzung:
 *   docker compose --profile control up -d control-db
 *   pnpm --filter @saas-instant/control test:integration
 */

jest.setTimeout(120_000);

const PREFIX = newPrefix('e5-rundmail');
const ADDRESS_PREFIX = `e5-rm-${randomUUID().slice(0, 8)}`;
const SOURCE = { ip: '203.0.113.11', userAgent: 'Jest-Integration' };
const ACTOR = { userId: null, name: 'sam' };
const FORM_TEXT =
  'Ja, ich möchte die Beispielprodukt-Rundmail bekommen. Ich kann jederzeit ' +
  'widersprechen.';

const CONFIG: Record<string, string> = {
  CONTROL_MAIL_BASE_URL: 'https://verwaltung.example',
  SMTP_HOST: 'localhost',
  SMTP_PORT: '1025',
};
const config = {
  get: (name: string, defaultValue?: string) => CONFIG[name] ?? defaultValue,
} as unknown as ConfigService;

const mailMock = {
  sendConsentConfirmation: async () => undefined,
} as unknown as MailService;

const audit = new AuditService(prisma);
const consents = new ConsentService(prisma, audit, mailMock, config);
const marketingMail = new MarketingMailService(config);
const templates = new TemplateService(prisma, audit, marketingMail);
const queue = new QueueService(
  prisma,
  audit,
  config,
  templates,
  marketingMail,
  consents,
);

const createTransport = nodemailer.createTransport as unknown as jest.Mock;

/** Alles, was der Postausgang zu sehen bekommen hat. */
let mailbox: Record<string, unknown>[] = [];
/** Fehler, den der nächste Versand wirft (einmalig oder dauerhaft). */
let errorOutcome: (Error | null)[] = [];

function stelleTransportAuf(): void {
  createTransport.mockReturnValue({
    sendMail: async (message: Record<string, unknown>) => {
      const error = errorOutcome.length > 0 ? errorOutcome.shift() : null;
      if (error) throw error;
      mailbox.push(message);
      return {};
    },
  });
}

/**
 * Eine NACHGEWIESENE Empfängerabsage, so wie nodemailer sie baut: Code
 * `EENVELOPE`, Befehl `RCPT TO`, die abgewiesene Adresse in `rejected`.
 * Genau daran — und nur daran — erkennt der Klassifizierer sie ([K1]).
 */
function refusal(): Error {
  const error = new Error(
    "Can't send mail - all recipients were rejected: 550 5.1.1 unknown recipient",
  );
  Object.assign(error, {
    code: 'EENVELOPE',
    command: 'RCPT TO',
    rejected: ['unbekannt@example.com'],
  });
  return error;
}

function connectionError(): Error {
  const error = new Error('connect ECONNREFUSED');
  (error as unknown as { code: string }).code = 'ECONNECTION';
  return error;
}

/** Der gemessene Fall aus [K1]: der Postausgangsname löst nicht auf. */
function nameResolutionBroken(): Error {
  const error = new Error(
    'getaddrinfo ENOTFOUND kein-solcher-postausgang.invalid',
  );
  Object.assign(error, { code: 'EDNS', command: 'CONN' });
  return error;
}

/** Ein Fehler, den niemand einordnen kann. Auffangwert `unbekannt`. */
function puzzlingError(): Error {
  return new Error('irgendetwas ganz anderes ist schiefgegangen');
}

/** Der Gegenüber lehnt UNSERE Absenderadresse ab (`MAIL FROM`). */
function senderRefused(): Error {
  const error = new Error(
    'Mail command failed: 550 5.7.1 Sender address rejected',
  );
  Object.assign(error, { code: 'EENVELOPE', command: 'MAIL FROM' });
  return error;
}

/**
 * Lässt eine Zeile beim NÄCHSTEN Versuch endgültig scheitern.
 *
 * Wiederholbare Klassen werden bis zu dreimal versucht; für die Frage, ob ein
 * ENDGÜLTIGER Fehlschlag gegen die Adresse zählt, ist der Weg dorthin egal.
 */
async function lastAttempt(deliveryId: string): Promise<void> {
  await prisma.mailDelivery.update({
    where: { id: deliveryId },
    data: {
      errorCount: MAX_ATTEMPTS - 1,
      deliveryStatus: 'queued',
      nextAttemptFrom: null,
    },
  });
}

/** Legt eine bestätigte Einwilligung an und gibt sie zurück. */
async function confirmedAddress(
  label: string,
  companyId?: string,
): Promise<{ id: string; email: string }> {
  const email = `${ADDRESS_PREFIX}-${label}@example.com`;
  await consents.subscribe(
    { email, formText: FORM_TEXT, companyId },
    SOURCE,
  );
  const row = await prisma.consent.findUniqueOrThrow({ where: { email } });
  await consents.confirm(row.confirmationToken!, SOURCE);
  return { id: row.id, email };
}

async function unconfirmedAddress(
  label: string,
): Promise<{ id: string; email: string }> {
  const email = `${ADDRESS_PREFIX}-${label}@example.com`;
  await consents.subscribe(
    { email, formText: FORM_TEXT },
    SOURCE,
  );
  const row = await prisma.consent.findUniqueOrThrow({ where: { email } });
  return { id: row.id, email };
}

/** Eine werbliche Vorlage dieser Suite. */
async function marketingTemplate(label: string, text?: string) {
  return templates.create(
    {
      name: `${PREFIX} ${label}`,
      channel: 'marketing',
      subject: 'Neues aus Beispielprodukt',
      contentText:
        text ??
        'Hallo {{organisation}},\n\nes gibt Neues in Beispielprodukt. Wir haben den ' +
          'Export überarbeitet.',
    },
    ACTOR,
    SOURCE,
  );
}

/**
 * Stellt eine Warteschlangenzeile VON HAND ein — der direkteste denkbare
 * Aufruf, an der Redaktion und an der Empfängerauswahl vorbei.
 *
 * Der Schnappschuss trägt den ECHTEN Abmeldelink der Einwilligung: Sonst
 * scheiterte der Versand schon an der Fusszeilenprüfung, und die Tests
 * belegten nicht mehr das, was sie belegen sollen.
 */
async function rowManual(
  consentId: string,
  email: string,
  templateId: string,
): Promise<string> {
  const entry = await prisma.consent.findUniqueOrThrow({
    where: { id: consentId },
    select: { unsubscribeToken: true },
  });
  const link = consents.unsubscribeLink(entry.unsubscribeToken ?? 'ohne-token');
  const wording = marketingMail.wording(
    {
      subject: 'Von Hand eingestellt',
      html: '<p>Text von Hand.</p>',
      text: 'Text von Hand.',
    },
    link,
  );
  const row = await prisma.mailDelivery.create({
    data: {
      consentId,
      templateId,
      recipientAddress: email,
      channel: 'marketing',
      subject: 'Von Hand eingestellt',
      contentSnapshot: wording.text,
      contentSnapshotHtml: wording.html,
      deliveryStatus: 'queued',
    },
    select: { id: true },
  });
  return row.id;
}

/**
 * Ein Konto für den Testversand.
 *
 * Nötig, weil der Audit-Eintrag des Testversands auf einen ECHTEN Benutzer
 * zeigt (`benutzerId`) — und der Fremdschlüssel darauf besteht. Genau so
 * soll es sein: Ein Testversand ist die Handlung eines Menschen und muss
 * einem Konto zuzuordnen sein.
 */
async function testAccount(): Promise<{ id: string; username: string }> {
  return prisma.user.create({
    data: {
      name: 'Testkonto Etappe 5',
      username: `${ADDRESS_PREFIX}-konto`,
      email: `${ADDRESS_PREFIX}-konto@example.com`,
    },
    select: { id: true, username: true },
  });
}

function toMyAddresses(): Record<string, unknown>[] {
  return mailbox.filter((mail) =>
    String(mail['to'] ?? '').startsWith(ADDRESS_PREFIX),
  );
}

beforeEach(() => {
  mailbox = [];
  errorOutcome = [];
  stelleTransportAuf();
});

afterAll(async () => {
  await cleanUpTemplates(PREFIX);
  await cleanUpConsents(ADDRESS_PREFIX);
  await cleanUp(PREFIX);
  // Das Testkonto und alles, was daran hängt. Das Audit-Log hängt bewusst an
  // keinem Fremdschlüssel mit Kaskade — es wird über den Akteur geräumt.
  const accounts = await prisma.user.findMany({
    where: { username: { startsWith: ADDRESS_PREFIX } },
    select: { id: true },
  });
  if (accounts.length > 0) {
    await prisma.auditLog.deleteMany({
      where: { userId: { in: accounts.map((k) => k.id) } },
    });
    await prisma.user.deleteMany({
      where: { id: { in: accounts.map((k) => k.id) } },
    });
  }
  await disconnect();
});

describe('R3 — ohne bestätigtes Opt-in geht nichts hinaus', () => {
  it('stellt eine unbestätigte Adresse gar nicht erst ein', async () => {
    const template = await marketingTemplate('nicht-eingestellt');
    const open = await unconfirmedAddress('unbestaetigt-1');
    // Eine bestätigte Adresse muss es geben, sonst lehnt das Einstellen ab,
    // bevor es zur Auswahl kommt — geprüft werden soll die AUSWAHL.
    const confirmed = await confirmedAddress('daneben-1');

    const result = await queue.enqueue(template.id, ACTOR, SOURCE);
    expect(result.enqueued).toBeGreaterThanOrEqual(1);
    expect(
      await prisma.mailDelivery.count({ where: { consentId: confirmed.id } }),
    ).toBe(1);

    const rows = await prisma.mailDelivery.findMany({
      where: { consentId: open.id },
    });
    expect(rows).toHaveLength(0);
  });

  /**
   * DER DIREKTESTE DENKBARE AUFRUF: die Warteschlangenzeile von Hand anlegen
   * und den Versand darauf ansetzen. Wer über die API einbricht, kommt
   * bestenfalls hierhin — und auch hier geht nichts hinaus.
   */
  it('weist eine von Hand eingestellte Zeile ohne Opt-in beim Versand ab', async () => {
    const template = await marketingTemplate('von-hand');
    const open = await unconfirmedAddress('unbestaetigt-2');
    const deliveryId = await rowManual(open.id, open.email, template.id);

    const outcome = await queue.sendOne(deliveryId);

    expect(outcome).toBe('rejected');
    expect(toMyAddresses()).toHaveLength(0);
    const row = await prisma.mailDelivery.findUniqueOrThrow({
      where: { id: deliveryId },
    });
    expect(row.deliveryStatus).toBe('rejected');
    expect(row.lastErrorClass).toBe('nicht_bestaetigt');
    expect(row.sentAt).toBeNull();

    const evidence = await prisma.auditLog.findMany({
      where: { objectId: deliveryId, action: AUDIT_ACTION.broadcastRefused },
    });
    expect(evidence).toHaveLength(1);
  });

  it.each([
    ['unsubscribed', 'unsubscribed'],
    ['hard_bounced', 'hard_bounced'],
    ['spam_reported', 'spam_reported'],
  ] as const)(
    'weist eine Zeile an einer %s-Adresse beim Versand ab',
    async (status, reason) => {
      const template = await marketingTemplate(`gesperrt-${status}`);
      const address = await confirmedAddress(`gesperrt-${status}`);
      const deliveryId = await rowManual(address.id, address.email, template.id);
      await prisma.consent.update({
        where: { id: address.id },
        data: { status },
      });

      expect(await queue.sendOne(deliveryId)).toBe('rejected');
      expect(toMyAddresses()).toHaveLength(0);
      const row = await prisma.mailDelivery.findUniqueOrThrow({
        where: { id: deliveryId },
      });
      expect(row.lastErrorClass).toBe(reason);
    },
  );

  /**
   * DER FALL AUS DEM AUFTRAG: „ein Empfänger, der zwischen Auswahl und Versand
   * widerruft".
   */
  it('verschickt nichts an jemanden, der nach dem Einstellen widerruft', async () => {
    const template = await marketingTemplate('widerruf');
    const address = await confirmedAddress('widerruf');
    await queue.enqueue(template.id, ACTOR, SOURCE);

    const unsubscribeToken = (
      await prisma.consent.findUniqueOrThrow({ where: { id: address.id } })
    ).unsubscribeToken!;
    const unsubscribe = await consents.unsubscribe(unsubscribeToken, SOURCE);
    expect(unsubscribe.abortedMails).toBeGreaterThanOrEqual(1);

    await queue.executeSendRun(100, 0);

    expect(
      mailbox.filter((mail) => mail['to'] === address.email),
    ).toHaveLength(0);
    const rows = await prisma.mailDelivery.findMany({
      where: { consentId: address.id },
    });
    expect(rows.every((row) => row.deliveryStatus === 'rejected')).toBe(
      true,
    );
  });

  /**
   * Und selbst wenn die Abmeldung die eingestellte Zeile NICHT mehr erwischt
   * hätte — hier von Hand zurückgesetzt —, weist das Tor sie beim Übernehmen
   * ab. Zwei Sperren, nicht eine.
   */
  it('weist die Zeile auch dann ab, wenn sie nach dem Widerruf wieder in der Warteschlange steht', async () => {
    const template = await marketingTemplate('widerruf-zweite-linie');
    const address = await confirmedAddress('widerruf-zweite-linie');
    await queue.enqueue(template.id, ACTOR, SOURCE);
    const unsubscribeToken = (
      await prisma.consent.findUniqueOrThrow({ where: { id: address.id } })
    ).unsubscribeToken!;
    await consents.unsubscribe(unsubscribeToken, SOURCE);

    await prisma.mailDelivery.updateMany({
      where: { consentId: address.id },
      data: { deliveryStatus: 'queued' },
    });

    await queue.executeSendRun(100, 0);
    expect(
      mailbox.filter((mail) => mail['to'] === address.email),
    ).toHaveLength(0);
  });

  /**
   * NEBENLÄUFIG: Abmeldung und Versand treffen gleichzeitig ein.
   *
   * Geprüft wird die Invariante, nicht der Ausgang. Jede Zeile landet in genau
   * EINEM Endzustand, und eine gesendete Mail gibt es nur zu einer Zeile, die
   * auch als gesendet dasteht. Ein „check-then-act" ohne Sperre produziert
   * hier eine Zeile, die als abgewiesen vermerkt ist und trotzdem im
   * Postausgang steht.
   */
  it('entscheidet zwischen Abmeldung und Versand eindeutig', async () => {
    const template = await marketingTemplate('rennen');
    const count = 10;
    const addresses: { id: string; email: string; token: string }[] = [];
    for (let number = 0; number < count; number += 1) {
      const address = await confirmedAddress(`rennen-${number}`);
      const row = await prisma.consent.findUniqueOrThrow({
        where: { id: address.id },
      });
      addresses.push({ ...address, token: row.unsubscribeToken! });
    }

    const deliveryIds: string[] = [];
    for (const address of addresses) {
      deliveryIds.push(await rowManual(address.id, address.email, template.id));
    }

    await Promise.all([
      ...deliveryIds.map((id) => queue.sendOne(id)),
      ...addresses.map((address) =>
        consents.unsubscribe(address.token, SOURCE),
      ),
    ]);

    const rows = await prisma.mailDelivery.findMany({
      where: { id: { in: deliveryIds } },
      select: { id: true, deliveryStatus: true, recipientAddress: true },
    });
    for (const row of rows) {
      expect(['sent', 'rejected']).toContain(row.deliveryStatus);
      const beyond = mailbox.filter(
        (mail) => mail['to'] === row.recipientAddress,
      ).length;
      // Keine Mail zu einer abgewiesenen Zeile, genau eine zu einer gesendeten.
      expect(beyond).toBe(row.deliveryStatus === 'sent' ? 1 : 0);
    }
  });
});

describe('Nie mehrere Adressen in einer Mail', () => {
  it('schickt je Empfänger genau eine Mail mit genau einer Adresse', async () => {
    const template = await marketingTemplate('einzeln');
    const one = await confirmedAddress('einzeln-1');
    const two = await confirmedAddress('einzeln-2');

    await queue.enqueue(template.id, ACTOR, SOURCE);
    await queue.executeSendRun(200, 0);

    const my = toMyAddresses();
    expect(my.length).toBeGreaterThanOrEqual(2);
    for (const mail of my) {
      expect(typeof mail['to']).toBe('string');
      expect(mail['bcc']).toBeUndefined();
      expect(mail['cc']).toBeUndefined();
      const envelope = mail['envelope'] as { to: string[] };
      expect(envelope.to).toHaveLength(1);
    }
    const recipient = my.map((mail) => mail['to']);
    expect(recipient).toContain(one.email);
    expect(recipient).toContain(two.email);
  });

  it('gibt jeder Mail einen EIGENEN Abmeldelink', async () => {
    const my = toMyAddresses();
    const links = new Set(
      my.map(
        (mail) =>
          (mail['headers'] as Record<string, string>)['List-Unsubscribe'],
      ),
    );
    expect(links.size).toBe(my.length);
  });
});

describe('Bounce — drei erfolglose Zustellungen in Folge', () => {
  it('legt die Adresse nach dem dritten Fehlversuch still', async () => {
    const template = await marketingTemplate('bounce');
    const address = await confirmedAddress('bounce');

    for (let attempt = 0; attempt < 3; attempt += 1) {
      const deliveryId = await rowManual(address.id, address.email, template.id);
      errorOutcome = [refusal()];
      expect(await queue.sendOne(deliveryId)).toBe('failed');
    }

    const row = await prisma.consent.findUniqueOrThrow({
      where: { id: address.id },
    });
    expect(row.status).toBe('hard_bounced');
    expect(row.deactivatedAt).not.toBeNull();
  });

  it('legt nach ZWEI Fehlversuchen noch nichts still', async () => {
    const template = await marketingTemplate('bounce-zwei');
    const address = await confirmedAddress('bounce-zwei');

    for (let attempt = 0; attempt < 2; attempt += 1) {
      const deliveryId = await rowManual(address.id, address.email, template.id);
      errorOutcome = [refusal()];
      await queue.sendOne(deliveryId);
    }

    const row = await prisma.consent.findUniqueOrThrow({
      where: { id: address.id },
    });
    expect(row.status).toBe('confirmed');
  });

  it('setzt der Zähler durch einen Erfolg dazwischen zurück', async () => {
    const template = await marketingTemplate('bounce-reset');
    const address = await confirmedAddress('bounce-reset');

    // zwei Fehlversuche
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const deliveryId = await rowManual(address.id, address.email, template.id);
      errorOutcome = [refusal()];
      await queue.sendOne(deliveryId);
    }
    // ein Erfolg
    const successId = await rowManual(address.id, address.email, template.id);
    expect(await queue.sendOne(successId)).toBe('sent');
    // und noch zwei Fehlversuche — in Folge sind es damit nur zwei
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const deliveryId = await rowManual(address.id, address.email, template.id);
      errorOutcome = [refusal()];
      await queue.sendOne(deliveryId);
    }

    const row = await prisma.consent.findUniqueOrThrow({
      where: { id: address.id },
    });
    expect(row.status).toBe('confirmed');
  });

  /**
   * ===========================================================================
   * [K1] — DER GEMESSENE SCHADEN
   * ===========================================================================
   *
   * `SMTP_HOST=kein-solcher-postausgang.invalid` erzeugte drei Zeilen
   * `fehlgeschlagen | unbekannt` und eine Einwilligung `hart_abgewiesen`.
   * Ursache: `unbekannt` war zugleich Auffangwert und galt als
   * empfängerbezogen.
   *
   * Beide Tests fallen gegen die alte Fassung.
   */
  it.each([
    ['nicht auflösender Postausgang (EDNS)', nameResolutionBroken],
    ['nicht einzuordnender Fehler (unbekannt)', puzzlingError],
    ['abgewiesene ABSENDERadresse (MAIL FROM)', senderRefused],
  ])(
    'legt bei %s auch nach drei endgültigen Fehlschlägen keine Adresse still',
    async (label, error) => {
      const short = label.replace(/[^a-z]/gi, '').slice(0, 12).toLowerCase();
      const template = await marketingTemplate(`k1-${short}`);
      const address = await confirmedAddress(`k1-${short}`);

      for (let round = 0; round < 3; round += 1) {
        const deliveryId = await rowManual(address.id, address.email, template.id);
        await lastAttempt(deliveryId);
        errorOutcome = [error()];
        expect(await queue.sendOne(deliveryId)).toBe('failed');
      }

      const row = await prisma.consent.findUniqueOrThrow({
        where: { id: address.id },
      });
      expect(row.status).toBe('confirmed');
      expect(row.deactivatedAt).toBeNull();
    },
  );

  /**
   * Die Gegenprobe: Eine nachgewiesene EMPFÄNGERabsage zählt weiterhin — sonst
   * hätte die Reparatur die Regel abgeschafft statt sie zu berichtigen.
   */
  it('legt bei drei nachgewiesenen Empfängerabsagen weiterhin still', async () => {
    const template = await marketingTemplate('k1-gegenprobe');
    const address = await confirmedAddress('k1-gegenprobe');
    for (let round = 0; round < 3; round += 1) {
      const deliveryId = await rowManual(address.id, address.email, template.id);
      errorOutcome = [refusal()];
      await queue.sendOne(deliveryId);
    }
    expect(
      (await prisma.consent.findUniqueOrThrow({ where: { id: address.id } }))
        .status,
    ).toBe('hard_bounced');
  });

  /**
   * DER FEHLER, DEN MAN NICHT MACHEN DARF: Ein kaputter eigener Postausgang
   * darf keine einzige Empfängeradresse stilllegen. Sonst legt ein falsches
   * SMTP-Passwort in einem Lauf den gesamten Verteiler still — unumkehrbar
   * ohne Eingriff in die Datenbank.
   */
  it('legt bei einem Fehler des EIGENEN Postausgangs keine Adresse still', async () => {
    const template = await marketingTemplate('betriebsfehler');
    const address = await confirmedAddress('betriebsfehler');

    const deliveryId = await rowManual(address.id, address.email, template.id);
    // Drei Versuche derselben Zeile, alle mit Verbindungsfehler.
    for (let attempt = 0; attempt < 3; attempt += 1) {
      errorOutcome = [connectionError()];
      await prisma.mailDelivery.update({
        where: { id: deliveryId },
        data: { deliveryStatus: 'queued', nextAttemptFrom: null },
      });
      await queue.sendOne(deliveryId);
    }

    const row = await prisma.consent.findUniqueOrThrow({
      where: { id: address.id },
    });
    expect(row.status).toBe('confirmed');
  });

  it('wiederholt einen zeitweiligen Fehler und gibt nach drei Versuchen auf', async () => {
    const template = await marketingTemplate('retry');
    const address = await confirmedAddress('retry');
    const deliveryId = await rowManual(address.id, address.email, template.id);

    errorOutcome = [connectionError()];
    expect(await queue.sendOne(deliveryId)).toBe('retry');
    const afterFirst = await prisma.mailDelivery.findUniqueOrThrow({
      where: { id: deliveryId },
    });
    expect(afterFirst.deliveryStatus).toBe('queued');
    expect(afterFirst.errorCount).toBe(1);
    expect(afterFirst.nextAttemptFrom).not.toBeNull();

    for (let attempt = 0; attempt < 2; attempt += 1) {
      await prisma.mailDelivery.update({
        where: { id: deliveryId },
        data: { nextAttemptFrom: null, deliveryStatus: 'queued' },
      });
      errorOutcome = [connectionError()];
      await queue.sendOne(deliveryId);
    }
    const last = await prisma.mailDelivery.findUniqueOrThrow({
      where: { id: deliveryId },
    });
    expect(last.deliveryStatus).toBe('failed');
    expect(last.errorCount).toBe(3);
  });

  it('wiederholt eine harte Abweisung NICHT', async () => {
    const template = await marketingTemplate('keine-wiederholung');
    const address = await confirmedAddress('keine-wiederholung');
    const deliveryId = await rowManual(address.id, address.email, template.id);

    errorOutcome = [refusal()];
    expect(await queue.sendOne(deliveryId)).toBe('failed');
    const row = await prisma.mailDelivery.findUniqueOrThrow({
      where: { id: deliveryId },
    });
    expect(row.errorCount).toBe(1);
    expect(row.nextAttemptFrom).toBeNull();
  });
});

describe('Redaktion', () => {
  it('verweigert eine Vorlage mit unbekanntem Platzhalter', async () => {
    await expect(
      templates.create(
        {
          name: `${PREFIX} kaputt`,
          channel: 'marketing',
          subject: 'Hallo {{vorname}}',
          contentText: 'Ein hinreichend langer Text mit {{vorname}}.',
        },
        ACTOR,
        SOURCE,
      ),
    ).rejects.toMatchObject({ errorCode: 'unknown_placeholders' });
  });

  it('lässt eine Transaktionsvorlage nicht als Rundmail hinaus', async () => {
    const template = await templates.create(
      {
        name: `${PREFIX} transaktional`,
        channel: 'transactional',
        subject: 'Deine Rechnung',
        contentText: 'Ein hinreichend langer Text für eine Transaktionsmail.',
      },
      ACTOR,
      SOURCE,
    );
    await expect(
      queue.enqueue(template.id, ACTOR, SOURCE),
    ).rejects.toMatchObject({ errorCode: 'vorlage_falscher_kanal' });
  });

  it('lässt eine stillgelegte Vorlage nicht hinaus', async () => {
    const template = await marketingTemplate('stillgelegt');
    await templates.change(template.id, { active: false }, ACTOR, SOURCE);
    await expect(
      queue.enqueue(template.id, ACTOR, SOURCE),
    ).rejects.toMatchObject({ errorCode: 'vorlage_nicht_aktiv' });
  });

  it('setzt in der Vorschau erkennbare Beispielwerte ein und verschickt nichts', async () => {
    const template = await marketingTemplate('preview');
    const preview = await templates.preview(template.id);
    expect(preview.body).toContain('Beispielorganisation');
    expect(mailbox).toHaveLength(0);
  });

  it('lehnt einen Testversand ohne eigene Einwilligung ab', async () => {
    const template = await marketingTemplate('test-ohne');
    const account = await testAccount();
    await expect(
      queue.testSend(
        template.id,
        {
          id: account.id,
          username: account.username,
          email: `${ADDRESS_PREFIX}-ohne-opt-in@example.com`,
        },
        SOURCE,
      ),
    ).rejects.toMatchObject({ errorCode: 'keine_werbefreigabe' });
    expect(toMyAddresses()).toHaveLength(0);
  });

  it('lehnt einen Testversand ohne hinterlegte Adresse ab', async () => {
    const template = await marketingTemplate('test-ohne-adresse');
    await expect(
      queue.testSend(
        template.id,
        { id: 'egal', username: 'sam', email: null },
        SOURCE,
      ),
    ).rejects.toMatchObject({ errorCode: 'testversand_ohne_adresse' });
  });

  it('schickt einen Testversand an die eigene, bestätigte Adresse', async () => {
    const template = await marketingTemplate('test-mit');
    const address = await confirmedAddress('testempfaenger');
    const account = await prisma.user.findUniqueOrThrow({
      where: { username: `${ADDRESS_PREFIX}-konto` },
      select: { id: true, username: true },
    });

    const result = await queue.testSend(
      template.id,
      { id: account.id, username: account.username, email: address.email },
      SOURCE,
    );

    expect(result.sent).toBe(true);
    const mail = mailbox.find((entry) => entry['to'] === address.email);
    expect(String(mail?.['subject'])).toContain('[Testversand]');
  });
});

describe('Verlauf und Nachweis', () => {
  it('schreibt jede versendete Rundmail in den Verlauf der Organisation', async () => {
    const company = await createCompany(PREFIX);
    const template = await marketingTemplate('verlauf');
    const address = await confirmedAddress('verlauf', company.id);

    const deliveryId = await rowManual(address.id, address.email, template.id);
    expect(await queue.sendOne(deliveryId)).toBe('sent');

    const notes = await prisma.note.findMany({
      where: { companyId: company.id, bySystem: true },
    });
    expect(notes.some((note) => note.text.startsWith('Rundmail versendet'))).toBe(
      true,
    );
  });

  it('hält den Wortlaut jeder Mail als Schnappschuss fest', async () => {
    const template = await marketingTemplate('snapshot');
    const address = await confirmedAddress('snapshot');
    await queue.enqueue(template.id, ACTOR, SOURCE);

    const row = await prisma.mailDelivery.findFirstOrThrow({
      where: { consentId: address.id, templateId: template.id },
    });
    expect(row.contentSnapshot).toContain('es gibt Neues in Beispielprodukt');
    // Fusszeile mit Abmeldelink und Anbieterkennung — sie gehört zum Wortlaut.
    expect(row.contentSnapshot).toContain('/api/consent/unsubscribe/');
    expect(row.contentSnapshot).toContain('Beispiel GmbH');
  });

  it('nennt im Audit-Log keine Empfängeradresse', async () => {
    const template = await marketingTemplate('audit');
    const address = await confirmedAddress('audit');
    const deliveryId = await rowManual(address.id, address.email, template.id);
    await queue.sendOne(deliveryId);

    const entries = await prisma.auditLog.findMany({
      where: { objectId: deliveryId },
    });
    expect(entries.length).toBeGreaterThanOrEqual(1);
    expect(JSON.stringify(entries)).not.toContain(address.email);
  });
});

/**
 * ===========================================================================
 * DER FORTSCHRITT — Zählwerte, sonst nichts
 * ===========================================================================
 *
 * Zwei Aussagen tragen diesen Block:
 *
 * 1. Die vier Zahlen stimmen und werden GETRENNT geführt. `abgewiesen` ist
 *    kein Fehlschlag, sondern die Prüfung beim Versand, die gegriffen hat.
 * 2. Es kommt keine Adresse heraus. Das ist der Grund, warum die Abfrage ohne
 *    zweiten Faktor auskommt — sie muss also auch dann nichts verraten, wenn
 *    jemand sie im Sekundentakt abruft.
 */
describe('Fortschritt eines Versands', () => {
  it('meldet eine unbekannte Vorlage als Fehler statt als vier Nullen', async () => {
    await expect(queue.progress(randomUUID())).rejects.toMatchObject({
      errorCode: 'vorlage_nicht_gefunden',
    });
  });

  it('zählt eine Vorlage ohne eingestellte Zeilen auf null', async () => {
    const template = await marketingTemplate('fortschritt-leer');

    expect(await queue.progress(template.id)).toEqual({
      templateId: template.id,
      total: 0,
      sent: 0,
      open: 0,
      failed: 0,
      refused: 0,
    });
  });

  it('führt versendet, offen, fehlgeschlagen und abgewiesen getrennt', async () => {
    const template = await marketingTemplate('fortschritt-gemischt');
    const address = await confirmedAddress('fortschritt-1');

    const states = [
      'sent',
      'queued',
      'sending',
      'failed',
      'rejected',
    ] as const;
    for (const state of states) {
      const id = await rowManual(address.id, address.email, template.id);
      await prisma.mailDelivery.update({
        where: { id },
        data: { deliveryStatus: state },
      });
    }

    expect(await queue.progress(template.id)).toEqual({
      templateId: template.id,
      total: 5,
      sent: 1,
      // `in_warteschlange` UND `in_zustellung`: Beides ist für die Betreiberin
      // dasselbe — es steht noch aus.
      open: 2,
      failed: 1,
      refused: 1,
    });
  });

  it('geht am echten Weg von „alles offen" auf „alles versendet"', async () => {
    const template = await marketingTemplate('fortschritt-lauf');
    await confirmedAddress('fortschritt-lauf-1');

    await queue.enqueue(template.id, ACTOR, SOURCE);
    const queued = await queue.progress(template.id);
    expect(queued.total).toBeGreaterThan(0);
    expect(queued.open).toBe(queued.total);
    expect(queued.sent).toBe(0);

    await queue.executeSendRun(200, 0);
    const afterwards = await queue.progress(template.id);
    expect(afterwards.total).toBe(queued.total);
    expect(afterwards.open).toBe(0);
    expect(afterwards.sent).toBe(queued.total);
  });

  it('gibt keine Adresse und keine Kennung einer Empfängerin heraus', async () => {
    const template = await marketingTemplate('fortschritt-still');
    const address = await confirmedAddress('fortschritt-still-1');
    await rowManual(address.id, address.email, template.id);

    const state = await queue.progress(template.id);
    expect(Object.keys(state).sort()).toEqual([
      'rejected',
      'failed',
      'total',
      'open',
      'sent',
      'templateId',
    ]);
    const raw = JSON.stringify(state);
    expect(raw).not.toContain('@');
    expect(raw).not.toContain(ADDRESS_PREFIX);
    expect(raw).not.toContain(address.id);
  });
});
