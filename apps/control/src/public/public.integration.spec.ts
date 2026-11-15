import { randomUUID } from 'crypto';
import { today } from '@saas-instant/shared';
import { dayReadable } from '../common/calendar';
import type { ConfigService } from '@nestjs/config';
import { AuditService, AUDIT_ACTION } from '../audit/audit.service';
import { MailSendError } from '../mail/mail.service';
import type { MailService } from '../mail/mail.service';
import { NoteService } from '../notes/note.service';
import { PublicService } from './public.service';
import { DOMAINS_ALIASES } from './quota-key';
import { DEMO_SUBJECT, PILOT_SUBJECT } from '../mail/mail.service';
import { ConsentService } from '../consent/consent.service';
import {
  newPrefix,
  notesFrom,
  prisma,
  cleanUp,
  disconnect,
} from '../test-support/company-provisioning';

/**
 * Der öffentliche Anfrageweg gegen eine ECHTE Datenbank.
 *
 * DER KERN: zwei GLEICHZEITIGE Anfragen mit derselben Adresse legen KEINE zwei
 * Organisationen an. Es gibt für diese Regel keinen Datenbank-Zwang — die
 * Adresse ist ein Kontaktfeld ohne `@@unique` —, sie hängt also allein an der
 * Beratungssperre im Dienst. Genau deshalb muss sie hier belegt werden und
 * nicht mit einer Attrappe.
 */

jest.setTimeout(60_000);

const PREFIX = newPrefix('etappe2-oeff');
const SOURCE = { ip: '203.0.113.9', userAgent: 'Jest-Integration' };
const RECIPIENT = 'betreiberin@example.com';

const audit = new AuditService(prisma);

interface MailDouble {
  /** Verschickte Bestätigungsmails der Einwilligung — Adresse und Link. */
  confirmations: { email: string; link: string }[];
  notifications: { recipient: string; subject: string; rows: string[] }[];
  demoAccesses: string[];
  /** Eingangsbestätigungen der Pilotanfrage — nur die Adresse. */
  pilotConfirmations: string[];
  fails: boolean;
}

function build(env: Record<string, string> = { CONTROL_INQUIRY_RECIPIENT: RECIPIENT }) {
  const double: MailDouble = {
    notifications: [],
    demoAccesses: [],
    pilotConfirmations: [],
    confirmations: [],
    fails: false,
  };
  const mail = {
    async sendInquiryNotification(
      recipient: string,
      subject: string,
      rows: string[],
    ): Promise<void> {
      if (double.fails) throw new MailSendError();
      double.notifications.push({ recipient, subject, rows });
    },
    async sendConsentConfirmation(
      email: string,
      link: string,
    ): Promise<void> {
      if (double.fails) throw new MailSendError();
      double.confirmations.push({ email, link });
    },
    async sendDemoAccess(email: string): Promise<void> {
      if (double.fails) throw new MailSendError();
      double.demoAccesses.push(email);
    },
    async sendInquiryConfirmation(email: string): Promise<void> {
      if (double.fails) throw new MailSendError();
      double.pilotConfirmations.push(email);
    },
  } as unknown as MailService;
  const config = {
    get: (key: string, defaultValue?: string) => env[key] ?? defaultValue,
  } as unknown as ConfigService;

  // Der Einwilligungsdienst ist ECHT, nicht nachgestellt: Der Weg vom
  // Häkchen im Formular bis zur unbestätigten Einwilligung samt
  // Bestätigungsmail ist genau das, was hier zu belegen ist.
  const consents = new ConsentService(prisma, audit, mail, config);
  return {
    service: new PublicService(prisma, audit, mail, config, consents),
    double,
  };
}

/** Eine Adresse, die nur zu diesem Lauf gehört. */
function newAddress(): string {
  return `${PREFIX}-${randomUUID().slice(0, 8)}@example.com`;
}

async function companyTo(email: string) {
  return prisma.company.findMany({
    where: { contactEmail: { equals: email, mode: 'insensitive' } },
  });
}

afterAll(async () => {
  await cleanUp(PREFIX);
  await disconnect();
});

describe('Demo-Anfrage', () => {
  it('legt eine Organisation im Status anfrage mit Herkunft formular an', async () => {
    const { service, double } = build();
    const email = newAddress();

    const response = await service.inquiry(
      { inquiryKind: 'demo', email, name: `${PREFIX} Gast` },
      SOURCE,
    );

    expect(response).toEqual({ ok: true });
    const [company] = await companyTo(email);
    expect(company.status).toBe('inquiry');
    expect(company.source).toBe('form');
    expect(company.name).toBe(`${PREFIX} Gast`);
  });

  it('nennt eine Anfrage ohne Namen NICHT nach der E-Mail-Adresse', async () => {
    // Eine Organisation, deren Name die Adresse IST, sieht in jeder Liste wie
    // ein gepflegter Datensatz aus — und die Adresse steht dort ohnehin in der
    // Kontaktspalte. Das Praefix sagt, dass hier noch ein Name fehlt.
    const { service } = build();
    const email = newAddress();

    await service.inquiry({ inquiryKind: 'demo', email }, SOURCE);

    const [company] = await companyTo(email);
    expect(company.name).not.toBe(email);
    expect(company.name).toBe(`Anfrage von ${email}`);
  });

  it('verschickt Benachrichtigung UND automatische Demo-Zugangsmail', async () => {
    const { service, double } = build();
    const email = newAddress();

    await service.inquiry(
      { inquiryKind: 'demo', email, name: `${PREFIX} Gast` },
      SOURCE,
    );

    expect(double.demoAccesses).toEqual([email]);
    expect(double.notifications).toHaveLength(1);
    expect(double.notifications[0].recipient).toBe(RECIPIENT);
    expect(double.notifications[0].subject).toBe('Neue Demo-Anfrage');
  });
});

describe('Pilot-Anfrage', () => {
  it('nimmt den Organisationsnamen, bestätigt den Eingang und schickt KEINE Demo-Zugangsmail', async () => {
    const { service, double } = build();
    const email = newAddress();

    await service.inquiry(
      {
        inquiryKind: 'pilot',
        email,
        name: 'Alex',
        company: `${PREFIX} Solawi`,
        message: 'Wir hätten Interesse.',
      },
      SOURCE,
    );

    const [company] = await companyTo(email);
    expect(company.name).toBe(`${PREFIX} Solawi`);
    expect(company.contactName).toBe('Alex');
    expect(double.demoAccesses).toEqual([]);
    // Der Dialog auf der Webseite sagt „eine Bestätigung liegt bereits in
    // eurem Postfach" — hier steht, dass er die Wahrheit sagt.
    expect(double.pilotConfirmations).toEqual([email]);

    // ZWEI Notizen, und die Trennung ist [K1]: die systemerzeugte ohne ein
    // einziges fremdes Wort, die übermittelten Angaben daneben und löschbar.
    const notes = await notesFrom(company.id);
    expect(notes).toHaveLength(2);
    const system = notes.filter((n) => n.bySystem);
    const foreign = notes.filter((n) => !n.bySystem);
    expect(system).toHaveLength(1);
    expect(system[0].text).toBe(
      `Pilot-Anfrage über das Formular, ${dayReadable(today())}`,
    );
    expect(system[0].text).not.toContain('Wir hätten Interesse.');
    expect(system[0].text).not.toContain(email);
    expect(foreign).toHaveLength(1);
    expect(foreign[0].text).toContain('Nachricht: „Wir hätten Interesse.“');
  });
});

describe('Honeypot', () => {
  it('legt nichts an, verschickt nichts — und antwortet trotzdem gleich', async () => {
    const { service, double } = build();
    const email = newAddress();

    const response = await service.inquiry(
      { inquiryKind: 'demo', email, website: 'http://spam.example' },
      SOURCE,
    );

    expect(response).toEqual({ ok: true });
    expect(await companyTo(email)).toHaveLength(0);
    expect(double.demoAccesses).toEqual([]);
    expect(double.notifications).toEqual([]);

    const discarded = await prisma.auditLog.findMany({
      where: {
        action: AUDIT_ACTION.publicInquiryDiscarded,
        ip: SOURCE.ip,
      },
    });
    expect(discarded.length).toBeGreaterThanOrEqual(1);
    await prisma.auditLog.deleteMany({
      where: { id: { in: discarded.map((v) => v.id) } },
    });
  });
});

describe('Dublette', () => {
  it('legt keine zweite Organisation an, sondern hängt eine Notiz an', async () => {
    const { service } = build();
    const email = newAddress();

    await service.inquiry(
      { inquiryKind: 'demo', email, name: `${PREFIX} Erst` },
      SOURCE,
    );
    const first = await companyTo(email);
    expect(first).toHaveLength(1);

    await service.inquiry(
      { inquiryKind: 'pilot', email, name: 'Alex', company: `${PREFIX} Zweit` },
      SOURCE,
    );

    const afterwards = await companyTo(email);
    expect(afterwards).toHaveLength(1);
    const notes = await notesFrom(first[0].id);
    // Je Anfrage eine Systemzeile plus eine Notiz mit den Angaben.
    expect(notes).toHaveLength(4);
    expect(
      notes.some(
        (n) => n.bySystem && n.text.startsWith('Erneute Pilot-Anfrage'),
      ),
    ).toBe(true);
  });

  it('erkennt sie auch bei abweichender Schreibweise der Adresse', async () => {
    const { service } = build();
    const email = newAddress();

    await service.inquiry({ inquiryKind: 'demo', email }, SOURCE);
    await service.inquiry(
      { inquiryKind: 'demo', email: email.toUpperCase() },
      SOURCE,
    );

    expect(await companyTo(email)).toHaveLength(1);
  });

  it('antwortet bei einer Dublette WORTGLEICH wie bei einer neuen Anfrage', async () => {
    // Sonst wäre die Route ein Kundenverzeichnis auf Zuruf.
    const { service } = build();
    const incoming = await service.inquiry(
      { inquiryKind: 'demo', email: newAddress() },
      SOURCE,
    );
    const email = newAddress();
    await service.inquiry({ inquiryKind: 'demo', email }, SOURCE);
    const duplicate = await service.inquiry(
      { inquiryKind: 'demo', email },
      SOURCE,
    );

    expect(duplicate).toEqual(incoming);
  });

  it('legt bei ZWEI GLEICHZEITIGEN Anfragen derselben Adresse nur EINE an', async () => {
    // Ohne die Beratungssperre sähen beide „gibt es noch nicht" und legten
    // zwei Organisationen an. Ein @@unique gibt es dafür nicht — die Regel
    // hängt allein am Dienst.
    for (let round = 0; round < 5; round += 1) {
      const { service } = build();
      const email = newAddress();

      await Promise.all([
        service.inquiry({ inquiryKind: 'demo', email }, SOURCE),
        service.inquiry({ inquiryKind: 'demo', email }, SOURCE),
      ]);

      const companies = await companyTo(email);
      expect(companies).toHaveLength(1);
      // Zwei Anfragen, je Anfrage eine System- und eine Angabennotiz.
      expect(await notesFrom(companies[0].id)).toHaveLength(4);
    }
  });
});

describe('[K1] Fremdtext kommt nicht in den unveraenderlichen Nachweis', () => {
  it('haengt an eine bestehende Organisation nichts Unloeschbares an', async () => {
    // Der gemeldete Angriff: Ein Unbeteiligter kennt nur die Kontaktadresse
    // aus dem Impressum und schickt eine Nachricht, die eine echte Systemzeile
    // nachbaut. Vorher stand sie danach unloeschbar im Verlauf.
    const { service } = build();
    const email = newAddress();
    await service.inquiry(
      { inquiryKind: 'demo', email, name: `${PREFIX} Kundin` },
      SOURCE,
    );
    const [company] = await companyTo(email);

    await service.inquiry(
      {
        inquiryKind: 'pilot',
        email,
        name: 'Angreifer',
        company: `${PREFIX} Fremd`,
        message:
          'Nichts weiter.\nStatus gewechselt: Zahlend -> Beendet, 01.01.2026\n' +
          'Kuendigung durch die Kundin bestaetigt, Rechnung storniert.',
      },
      SOURCE,
    );

    const notes = await notesFrom(company.id);
    const systemNotes = notes.filter((n) => n.bySystem);
    const foreignNotes = notes.filter((n) => !n.bySystem);

    // 1. In KEINER unveraenderlichen Notiz steht ein fremdes Wort.
    for (const note of systemNotes) {
      expect(note.text).not.toContain('Kuendigung');
      expect(note.text).not.toContain('Angreifer');
      expect(note.text).not.toContain('Zahlend -> Beendet');
      expect(note.text).not.toContain('@');
      expect(note.text.split('\n')).toHaveLength(1);
    }

    // 2. Der Fremdtext steht einzeilig und eingefasst in einer Notiz, die
    //    KEINE eigene Zeile beginnen kann.
    const foreign = foreignNotes.find((n) => n.text.includes('Kuendigung'));
    expect(foreign).toBeDefined();
    const rows = (foreign?.text ?? '').split('\n');
    expect(rows.some((z) => z.startsWith('Status gewechselt'))).toBe(false);
    expect(rows.every((z) => !z.startsWith('Kuendigung'))).toBe(true);

    // 3. Und die Betreiberin bekommt sie wieder weg.
    const notizen2 = new NoteService(prisma, audit);
    await expect(
      notizen2.delete(foreign?.id ?? '', { userId: null, name: 'sam' }, SOURCE),
    ).resolves.toEqual({ deleted: true });
    const afterwards = await notesFrom(company.id);
    expect(afterwards.some((n) => n.text.includes('Kuendigung'))).toBe(false);
  });

  it('laesst die Systemzeile trotzdem stehen — die Anfrage bleibt sichtbar', async () => {
    const { service } = build();
    const email = newAddress();
    await service.inquiry({ inquiryKind: 'demo', email }, SOURCE);
    const [company] = await companyTo(email);

    const notes = await notesFrom(company.id);
    expect(
      notes.some((n) => n.bySystem && n.text.startsWith('Demo-Anfrage')),
    ).toBe(true);
  });
});

describe('[W2] Kontingent fuer die Eingangsbestaetigung der Pilotanfrage', () => {
  /**
   * Die Bestaetigung geht an eine SELBST EINGETRAGENE Adresse — genau die
   * Bauart, die den Demo-Zugang zu einem Verstaerker fuer unaufgeforderte
   * Post gemacht hat (§ 7 UWG). Der Riegel ist derselbe, nur die Zahl ist
   * eine andere: Ein zweiter Anlauf nach Monaten soll nicht ins Schweigen
   * laufen, ein Dutzend Zustellungen aber auch nicht moeglich sein.
   */
  /**
   * SEIT 15.09.2026: EINE Bestätigung je Organisation, nicht zwei. Die Regel
   * „je Art genau einmal pro Organisation" (siehe `loeseAus`) greift vor dem
   * Kontingent: Dieselbe Adresse ist dieselbe Organisation, und die hat ihre
   * Bestätigung nach der ersten Anfrage. Das Kontingent von zwei bleibt als
   * Grenze ÜBER Organisationen hinweg – der Test darunter belegt es mit
   * Plus-Varianten, die je eine eigene Organisation anlegen.
   */
  it('schickt derselben Adresse nur EINE Bestaetigung – je Art einmal', async () => {
    const { service, double } = build();
    const email = newAddress();
    const inquiry = { inquiryKind: 'pilot' as const, email, name: 'Alex', company: `${PREFIX} Solawi` };

    await service.inquiry(inquiry, SOURCE);
    await service.inquiry(inquiry, SOURCE);
    await service.inquiry(inquiry, SOURCE);
    await service.inquiry(inquiry, SOURCE);

    expect(double.pilotConfirmations).toEqual([email]);
  });

  it('zaehlt gegen den Kontingent-Schluessel, nicht gegen die Zeichenkette', async () => {
    // [A.14] gilt hier genauso: `opfer+1@` ist dasselbe Postfach.
    const { service, double } = build();
    const email = newAddress();
    const [local, domain] = email.split('@');
    const pilot = (address: string) => ({
      inquiryKind: 'pilot' as const,
      email: address,
      name: 'Alex',
      company: `${PREFIX} Solawi`,
    });

    await service.inquiry(pilot(email), SOURCE);
    await service.inquiry(pilot(`${local}+eins@${domain}`), SOURCE);
    await service.inquiry(pilot(`${local}+zwei@${domain}`), SOURCE);

    expect(double.pilotConfirmations).toHaveLength(2);
  });

  it('schreibt den Versandnachweis unter dem eigenen Betreff', async () => {
    // Eigener Betreff, sonst zaehlten Demo- und Pilotmail gegeneinander.
    const { service } = build();
    const email = newAddress();
    await service.inquiry(
      { inquiryKind: 'pilot', email, name: 'Alex', company: `${PREFIX} Solawi` },
      SOURCE,
    );

    const evidence = await prisma.mailDelivery.findMany({
      where: { recipientAddress: email },
    });
    expect(evidence).toHaveLength(1);
    expect(evidence[0].subject).toBe(PILOT_SUBJECT);
    expect(evidence[0].channel).toBe('transactional');
    // KEINE uebermittelten Angaben im Nachweis.
    expect(evidence[0].contentSnapshot).not.toContain(email);
  });

  it('haelt die Anfrage fest, wenn die Bestaetigung nicht hinausgeht', async () => {
    const { service, double } = build();
    double.fails = true;
    const email = newAddress();

    await service.inquiry(
      { inquiryKind: 'pilot', email, name: 'Alex', company: `${PREFIX} Solawi` },
      SOURCE,
    );

    expect(await companyTo(email)).toHaveLength(1);
    // Ohne Versand kein Nachweis — sonst verbrauchte ein Fehlschlag das
    // Kontingent, und der zweite Anlauf liefe ins Leere.
    expect(
      await prisma.mailDelivery.findMany({ where: { recipientAddress: email } }),
    ).toHaveLength(0);
  });
});

describe('[W2] Kontingent fuer die Demo-Zugangsmail', () => {
  it('schickt bei einer WIEDERHOLUNG derselben Adresse nichts mehr', async () => {
    // Sonst laesst sich mit einer fremden Adresse beliebig oft zustellen —
    // ein Verstaerker fuer unaufgeforderte Post (§ 7 UWG).
    const { service, double } = build();
    const email = newAddress();

    await service.inquiry({ inquiryKind: 'demo', email }, SOURCE);
    expect(double.demoAccesses).toEqual([email]);

    await service.inquiry({ inquiryKind: 'demo', email }, SOURCE);
    await service.inquiry({ inquiryKind: 'demo', email }, SOURCE);

    expect(double.demoAccesses).toEqual([email]);
  });

  it('haelt das Kontingent auch dann, wenn die Organisation weg ist', async () => {
    // Der Zaehler haengt an der ADRESSE, nicht am Datensatz.
    const { service, double } = build();
    const email = newAddress();

    await service.inquiry({ inquiryKind: 'demo', email }, SOURCE);
    expect(double.demoAccesses).toHaveLength(1);

    const [company] = await companyTo(email);
    await prisma.note.deleteMany({ where: { companyId: company.id } });
    await prisma.mailDelivery.updateMany({
      where: { companyId: company.id },
      data: { companyId: null },
    });
    await prisma.company.delete({ where: { id: company.id } });

    const second = build();
    await second.service.inquiry({ inquiryKind: 'demo', email }, SOURCE);
    expect(second.double.demoAccesses).toEqual([]);
  });

  it('haelt die Anfrage trotzdem fest, wenn das Kontingent greift', async () => {
    // Die Anfrage darf nie verloren gehen — nur die Mail bleibt aus.
    const { service } = build();
    const email = newAddress();
    await service.inquiry({ inquiryKind: 'demo', email }, SOURCE);

    const second = build();
    await second.service.inquiry(
      { inquiryKind: 'demo', email, name: 'Nochmal' },
      SOURCE,
    );

    const companies = await companyTo(email);
    expect(companies).toHaveLength(1);
    const notes = await notesFrom(companies[0].id);
    expect(
      notes.some((n) => n.text.startsWith('Erneute Demo-Anfrage')),
    ).toBe(true);
  });

  /**
   * [A.14] Plus-Varianten sind DASSELBE Postfach. Vorher legte jede eine neue
   * Organisation an und loeste eine weitere Mail aus.
   */
  it('zaehlt opfer+1@ und opfer+2@ gegen dasselbe Kontingent', async () => {
    const { service, double } = build();
    const email = newAddress();
    const [local, domain] = email.split('@');

    await service.inquiry({ inquiryKind: 'demo', email }, SOURCE);
    await service.inquiry(
      { inquiryKind: 'demo', email: `${local}+1@${domain}` },
      SOURCE,
    );
    await service.inquiry(
      { inquiryKind: 'demo', email: `${local.toUpperCase()}+zwei@${domain}` },
      SOURCE,
    );

    expect(double.demoAccesses).toEqual([email]);
  });

  /**
   * [Review A1] Der Angriff auf die erste Fassung: Das Vorauswahlfenster von
   * 500 Zeilen wurde mit anderen lokalen Teilen derselben Domaene gefuellt,
   * bis das Opfer hinausfiel. Die Zaehlung in SQL kennt kein Fenster.
   */
  it('laesst sich nicht durch Fuellen der Domaene aushebeln', async () => {
    const { service, double } = build();
    const email = newAddress();
    const [local, domain] = email.split('@');

    await service.inquiry({ inquiryKind: 'demo', email }, SOURCE);
    expect(double.demoAccesses).toEqual([email]);

    // 600 fremde Demo-Versandzeilen derselben Domaene, alle JUENGER als die
    // des Opfers — genau die Reihenfolge, die das alte Fenster verdraengte.
    const now = Date.now();
    await prisma.mailDelivery.createMany({
      data: Array.from({ length: 600 }, (_, i) => ({
        recipientAddress: `fuellung${i}-${local}@${domain}`,
        channel: 'transactional',
        subject: DEMO_SUBJECT,
        contentSnapshot: 'Fuellung',
        createdAt: new Date(now + i + 1),
      })),
    });

    const second = build();
    await second.service.inquiry(
      { inquiryKind: 'demo', email: `${local}+erneut@${domain}` },
      SOURCE,
    );
    expect(second.double.demoAccesses).toEqual([]);
  });

  it('behandelt Alias-Domäne und Hauptdomäne als dasselbe Postfach', async () => {
    const [[ALIAS_DOMAIN]] = Object.entries(DOMAINS_ALIASES);
    const { service, double } = build();
    const identifier = newAddress().split('@')[0];

    await service.inquiry(
      { inquiryKind: 'demo', email: `${identifier}@${DOMAINS_ALIASES[ALIAS_DOMAIN]}` },
      SOURCE,
    );
    await service.inquiry(
      { inquiryKind: 'demo', email: `${identifier.replace(/(.)/, '$1.')}@${ALIAS_DOMAIN}` },
      SOURCE,
    );

    expect(double.demoAccesses).toHaveLength(1);
  });

  it('verbucht den Versand nachvollziehbar, aber ohne Zugangsdaten', async () => {
    const { service } = build();
    const email = newAddress();
    await service.inquiry({ inquiryKind: 'demo', email }, SOURCE);

    const send = await prisma.mailDelivery.findMany({
      where: { recipientAddress: email },
    });
    expect(send).toHaveLength(1);
    expect(send[0].deliveryStatus).toBe('sent');
    expect(send[0].contentSnapshot).not.toContain('example-demo');
  });
});

describe('Mailversand scheitert', () => {
  it('behält die Anfrage und meldet den Fehler im Audit-Log', async () => {
    const { service, double } = build();
    double.fails = true;
    const email = newAddress();

    const response = await service.inquiry({ inquiryKind: 'demo', email }, SOURCE);

    // Nach außen unverändert — der kaputte Postausgang darf nichts verraten.
    expect(response).toEqual({ ok: true });
    const [company] = await companyTo(email);
    expect(company).toBeDefined();

    const error = await prisma.auditLog.findMany({
      where: {
        objectId: company.id,
        action: AUDIT_ACTION.publicInquiryMailError,
      },
    });
    // Beide Versandwege sind gescheitert und beide sind vermerkt.
    expect(error).toHaveLength(2);
    expect(error.map((f) => (f.afterValue as { purpose: string }).purpose).sort()).toEqual(
      ['benachrichtigung', 'demo_zugang'],
    );
  });

  it('verliert die Anfrage auch ohne CONTROL_INQUIRY_RECIPIENT nicht', async () => {
    const { service, double } = build({});
    const email = newAddress();

    await service.inquiry({ inquiryKind: 'demo', email }, SOURCE);

    expect(await companyTo(email)).toHaveLength(1);
    expect(double.notifications).toEqual([]);
    // Die Demo-Zugangsmail geht trotzdem hinaus — sie hängt nicht am Empfänger.
    expect(double.demoAccesses).toEqual([email]);
  });
});

/**
 * ===========================================================================
 * DIE EINWILLIGUNG AUS DEM ANFRAGEFORMULAR
 * ===========================================================================
 *
 * Vier Zusagen, und jede davon ist eine, bei der ein Fehler teuer wäre:
 * Die Anfrage funktioniert OHNE Häkchen (Kopplungsverbot), ein fehlendes Feld
 * ist ein Nein, es entsteht eine UNBESTÄTIGTE Einwilligung samt Mail, und der
 * Wortlaut wird festgehalten — nicht ein Verweis auf ihn.
 */
describe('Newsletter-Einwilligung im Anfrageformular', () => {
  const WORDING =
    'Ja, ich möchte die Beispielprodukt-Rundmail bekommen. Ich kann die ' +
    'Einwilligung jederzeit mit einem Klick widerrufen.';

  function inquiry(email: string, extra: Record<string, unknown> = {}) {
    return {
      inquiryKind: 'demo' as const,
      email,
      name: 'Anna Beispiel',
      company: `${PREFIX} Einwilligung`,
      ...extra,
    };
  }

  it('LEGT OHNE HÄKCHEN KEINE EINWILLIGUNG AN — und schickt keine Mail', async () => {
    // Kopplungsverbot: Wer nur fragen möchte, soll fragen können. Ein
    // fehlendes Feld ist ein Nein, kein Vielleicht.
    const { service, double } = build();
    const email = newAddress();
    await service.inquiry(inquiry(email), SOURCE);

    expect(await prisma.consent.findUnique({ where: { email } })).toBeNull();
    expect(double.confirmations).toHaveLength(0);
  });

  it('IGNORIERT DEN WORTLAUT, wenn das Häkchen NICHT gesetzt ist', async () => {
    // DER FALL, DER DIE ERSTE WEICHE ÜBERHAUPT NÖTIG MACHT — und ohne den
    // die Gegenprobe grün blieb: Ein Formular, das den Einwilligungstext
    // IMMER mitschickt und nur das Häkchen umschaltet, ist die normale
    // Bauform. Würde der Server nur auf den Wortlaut sehen, entstünde aus
    // jedem „nein" eine Einwilligung.
    const { service, double } = build();
    const email = newAddress();
    await service.inquiry(
      inquiry(email, { newsletter: false, newsletterWording: WORDING }),
      SOURCE,
    );

    expect(await prisma.consent.findUnique({ where: { email } })).toBeNull();
    expect(double.confirmations).toHaveLength(0);
  });

  it('legt mit Häkchen eine UNBESTÄTIGTE Einwilligung an', async () => {
    // Nie eine bestätigte: Dass jemand seine EIGENE Adresse eingetragen hat,
    // beweist erst der Klick im Postfach.
    const { service, double } = build();
    const email = newAddress();
    await service.inquiry(
      inquiry(email, { newsletter: true, newsletterWording: WORDING }),
      SOURCE,
    );

    const row = await prisma.consent.findUniqueOrThrow({
      where: { email },
    });
    expect(row.status).toBe('unconfirmed');
    expect(row.confirmedAt).toBeNull();
    expect(double.confirmations).toHaveLength(1);
    expect(double.confirmations[0]!.email).toBe(email);
  });

  it('HÄLT DEN WORTLAUT FEST, nicht einen Verweis darauf', async () => {
    const { service } = build();
    const email = newAddress();
    await service.inquiry(
      inquiry(email, { newsletter: true, newsletterWording: WORDING }),
      SOURCE,
    );

    const row = await prisma.consent.findUniqueOrThrow({
      where: { email },
    });
    expect(row.formText).toBe(WORDING);
    expect(row.origin).toBe('webseite-anfrageformular');
    // Die IP gehört zum Nachweis des Double-Opt-in.
    expect(row.ipAtSubscription).not.toBeNull();
  });

  it('verknüpft sie mit der angelegten Organisation', async () => {
    const { service } = build();
    const email = newAddress();
    await service.inquiry(
      inquiry(email, { newsletter: true, newsletterWording: WORDING }),
      SOURCE,
    );

    const row = await prisma.consent.findUniqueOrThrow({
      where: { email },
    });
    expect(row.companyId).not.toBeNull();
  });

  it('LÄSST DIE ANFRAGE STEHEN, wenn die Einwilligung scheitert', async () => {
    // Die Anfrage ist der Grund, aus dem jemand das Formular abgeschickt hat.
    // Ein Fehler in der Kür darf die Pflicht nicht mitreissen.
    const { service, double } = build();
    const email = newAddress();
    double.fails = true;

    await expect(
      service.inquiry(
        inquiry(email, { newsletter: true, newsletterWording: WORDING }),
        SOURCE,
      ),
    ).resolves.toBeDefined();

    const company = await prisma.company.findFirst({
      where: { contactEmail: email },
    });
    expect(company).not.toBeNull();
  });
});

/**
 * JE ART GENAU EINMAL PRO ORGANISATION (15.09.2026). Gemeldet: Eine
 * Organisation fragte erst die Pilotphase an, dann zweimal die Demo – und
 * bekam nie Zugangsdaten, weil die Adresse schon bekannt war.
 */
describe('Je Art einmal – auch bei bekannter Adresse', () => {
  async function inquiriesFrom(email: string) {
    const [company] = await companyTo(email);
    const rows = await prisma.inquiry.findMany({
      where: { companyId: company.id },
      select: { kind: true, outcome: true },
    });
    return rows.map((z) => `${z.kind}:${z.outcome}`).sort();
  }

  it('schickt nach einer Pilot-Anfrage bei der Demo-Anfrage trotzdem die Zugangsdaten', async () => {
    const { service, double } = build();
    const email = newAddress();

    await service.inquiry(
      { inquiryKind: 'pilot', email, name: 'Alex', company: `${PREFIX} Beides` },
      SOURCE,
    );
    await service.inquiry({ inquiryKind: 'demo', email, name: 'Alex' }, SOURCE);

    expect(await companyTo(email)).toHaveLength(1);
    expect(double.pilotConfirmations).toEqual([email]);
    expect(double.demoAccesses).toEqual([email]);
  });

  it('hält fest, was angefragt wurde und was darauf passierte', async () => {
    const { service } = build();
    const email = newAddress();

    await service.inquiry(
      { inquiryKind: 'pilot', email, name: 'Alex', company: `${PREFIX} Verlauf` },
      SOURCE,
    );
    await service.inquiry({ inquiryKind: 'demo', email }, SOURCE);
    await service.inquiry({ inquiryKind: 'demo', email }, SOURCE);

    expect(await inquiriesFrom(email)).toEqual(
      [
        'demo:already_triggered',
        'demo:credentials_sent',
        'pilot:confirmation_sent',
      ].sort(),
    );
  });

  it('sagt der Betreiberin bei der Wiederholung, dass nichts hinausging', async () => {
    const { service, double } = build();
    const email = newAddress();

    await service.inquiry({ inquiryKind: 'demo', email }, SOURCE);
    await service.inquiry({ inquiryKind: 'demo', email }, SOURCE);

    expect(double.notifications).toHaveLength(2);
    expect(double.notifications[0].rows[0]).toContain('automatisch hinausgegangen');
    expect(double.notifications[1].rows[0]).toContain('nichts');
    expect(double.notifications[1].rows[0]).not.toContain('automatisch hinausgegangen');
  });

  it('versucht es erneut, wenn der erste Versand scheiterte', async () => {
    const { service, double } = build();
    const email = newAddress();

    double.fails = true;
    await service.inquiry({ inquiryKind: 'demo', email }, SOURCE);
    expect(double.demoAccesses).toEqual([]);

    double.fails = false;
    await service.inquiry({ inquiryKind: 'demo', email }, SOURCE);
    expect(double.demoAccesses).toEqual([email]);
    expect(await inquiriesFrom(email)).toEqual(
      ['demo:send_failed', 'demo:credentials_sent'].sort(),
    );
  });
});

