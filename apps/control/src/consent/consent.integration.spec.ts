import { randomUUID } from 'crypto';
import { consentEmailIndex } from '../crypto/field-crypto';
import type { ConfigService } from '@nestjs/config';
import { AUDIT_ACTION, AuditService } from '../audit/audit.service';
import type { MailService } from '../mail/mail.service';
import {
  prisma,
  cleanUpConsents,
  disconnect,
} from '../test-support/company-provisioning';
import type { ConsentStatus } from '.prisma/control-client';
import { ConsentCleanupService } from './cleanup.service';
import { BLOCK_RANK } from './block-rank';
import {
  CONFIRMATION_VALID_HOURS,
  ConsentService,
  BLOCK_WITHOUT_CONSENT,
  MAIL_BLOCK_PERIOD_MINUTES,
  MAX_CONFIRMATION_MAILS,
} from './consent.service';

/**
 * DAS DOUBLE-OPT-IN GEGEN EINE ECHTE POSTGRES-DATENBANK.
 *
 * Mit einer In-Memory-Attrappe wären zwei der wichtigsten Aussagen nicht zu
 * belegen: die Eindeutigkeit der Adresse (ein Eintrag je Adresse, sonst ist
 * die Sperrliste keine) und das bedingte Löschen im Aufräumlauf.
 *
 * Voraussetzung:
 *   docker compose --profile control up -d control-db
 *   pnpm --filter @saas-instant/control test:integration
 */

jest.setTimeout(120_000);

const PREFIX = `e5-einw-${randomUUID().slice(0, 8)}`;
const SOURCE = { ip: '203.0.113.9', userAgent: 'Jest-Integration' };
const FORM_TEXT =
  'Ja, ich möchte die Beispielprodukt-Rundmail bekommen. Ich kann die Einwilligung ' +
  'jederzeit mit einem Klick widerrufen.';

const CONFIG: Record<string, string> = {
  CONTROL_MAIL_BASE_URL: 'https://verwaltung.example',
};
const config = {
  get: (name: string, defaultValue?: string) => CONFIG[name] ?? defaultValue,
} as unknown as ConfigService;

/** Merkt sich jede „verschickte" Bestätigungsmail samt Link. */
const mailbox: { email: string; link: string; hours: number }[] = [];
let sendFails = false;
const mail = {
  sendConsentConfirmation: async (
    email: string,
    link: string,
    hours: number,
  ) => {
    if (sendFails) throw new Error('SMTP kaputt (Testfall).');
    mailbox.push({ email, link, hours });
  },
} as unknown as MailService;

const audit = new AuditService(prisma);
const service = new ConsentService(prisma, audit, mail, config);
const cleanup = new ConsentCleanupService(prisma, audit, config);

function newAddress(label: string): string {
  return `${PREFIX}-${label}@example.com`;
}

/** Trägt ein und gibt den Bestätigungstoken aus der Mail zurück. */
async function enter(email: string, origin = 'webseite-newsletter') {
  const before = mailbox.length;
  await service.subscribe(
    { email, formText: FORM_TEXT, origin },
    SOURCE,
  );
  const mailRow = mailbox[before];
  return {
    token: mailRow ? mailRow.link.split('/').pop()! : null,
    mailSent: mailbox.length > before,
  };
}

async function rowFrom(email: string) {
  return prisma.consent.findUnique({ where: { emailIdx: consentEmailIndex(email) } });
}

afterAll(async () => {
  await cleanUpConsents(PREFIX);
  await disconnect();
});

beforeEach(() => {
  mailbox.length = 0;
  sendFails = false;
});

describe('Double-Opt-in', () => {
  it('legt beim Eintragen NUR einen unbestätigten Eintrag an', async () => {
    const email = newAddress('incoming');
    const { token, mailSent } = await enter(email);

    const row = await rowFrom(email);
    expect(row?.status).toBe('unconfirmed');
    expect(row?.confirmedAt).toBeNull();
    // OHNE ABMELDETOKEN: Der entsteht erst mit der Bestätigung. Vorher gibt es
    // nichts abzumelden — und ohne ihn erteilt das Tor keine Freigabe.
    expect(row?.unsubscribeToken).toBeNull();
    expect(mailSent).toBe(true);
    expect(token).toBe(row?.confirmationToken);
  });

  it('macht erst der Klick im Postfach daraus eine Einwilligung', async () => {
    const email = newAddress('confirmed');
    const { token } = await enter(email);

    await service.confirm(token!, { ip: '198.51.100.4', userAgent: 'Firefox' });

    const row = await rowFrom(email);
    expect(row?.status).toBe('confirmed');
    expect(row?.confirmedAt).not.toBeNull();
    expect(row?.unsubscribeToken).not.toBeNull();
    expect(row?.ipAtConfirmation).toBe('198.51.100.4');
  });

  /**
   * „Das ist der eigentliche Wert — ohne ihn ist der Haken wertlos."
   *
   * Im Streitfall zählt nicht, DASS jemand zugestimmt hat, sondern dass sich
   * zeigen lässt, WOZU, WANN und von WO.
   */
  it('hält den Nachweis vollständig fest', async () => {
    const email = newAddress('evidence');
    const { token } = await enter(email, 'webseite-fuss');
    await service.confirm(token!, { ip: '198.51.100.7', userAgent: 'Safari' });

    const evidence = await service.evidence(email);
    expect(evidence).toMatchObject({
      email,
      status: 'confirmed',
      origin: 'webseite-fuss',
      // WÖRTLICH, nicht als Verweis auf eine Vorlage: die kann sich ändern.
      formText: FORM_TEXT,
      ipAtSubscription: SOURCE.ip,
      ipAtConfirmation: '198.51.100.7',
      confirmationTokenPresent: true,
      unsubscribeTokenPresent: true,
    });
    expect(evidence?.subscribedAt).not.toBeNull();
    expect(evidence?.confirmedAt).not.toBeNull();
  });

  it('gibt die Token selbst NICHT in den Nachweis', async () => {
    const email = newAddress('tokenfrei');
    const { token } = await enter(email);
    await service.confirm(token!, SOURCE);
    const evidence = await service.evidence(email);
    expect(JSON.stringify(evidence)).not.toContain(token!);
  });

  it('nimmt denselben Bestätigungslink ein zweites Mal ohne Fehler an', async () => {
    const email = newAddress('zweimal');
    const { token } = await enter(email);
    await service.confirm(token!, SOURCE);
    await expect(service.confirm(token!, SOURCE)).resolves.toBeDefined();
  });

  it('kennt einen erfundenen Bestätigungslink nicht', async () => {
    await expect(service.confirm('gibt-es-nicht', SOURCE)).rejects.toMatchObject(
      { errorCode: 'bestaetigung_unbekannt' },
    );
  });

  it('legt bei einer bereits bestätigten Adresse nichts nach', async () => {
    const email = newAddress('doppelt');
    const { token } = await enter(email);
    await service.confirm(token!, SOURCE);

    mailbox.length = 0;
    await enter(email);
    // KEINE zweite Bestätigungsmail: Sonst liesse sich über das Formular eine
    // fremde Adresse beliebig oft mit Post belegen.
    expect(mailbox).toHaveLength(0);
    expect((await rowFrom(email))?.status).toBe('confirmed');
  });

  it('verwirft eine Eintragung mit ausgefülltem Honeypot lautlos', async () => {
    const email = newAddress('bot');
    await service.subscribe(
      {
        email,
        formText: FORM_TEXT,
        website: 'https://spam.example',
      },
      SOURCE,
    );
    expect(await rowFrom(email)).toBeNull();
    expect(mailbox).toHaveLength(0);
  });

  /**
   * Der Nachweis ist schon erfasst, wenn die Mail hinausgeht. Scheitert der
   * Versand, darf das den Eintrag nicht rückgängig machen — und die Antwort
   * des Formulars muss dieselbe bleiben.
   */
  it('behält den Eintrag, auch wenn die Bestätigungsmail nicht hinausgeht', async () => {
    const email = newAddress('smtp-kaputt');
    sendFails = true;
    await expect(
      service.subscribe(
        { email, formText: FORM_TEXT },
        SOURCE,
      ),
    ).resolves.toBeUndefined();
    expect((await rowFrom(email))?.status).toBe('unconfirmed');
  });
});

describe('Ein-Klick-Abmeldung', () => {
  it('wirkt ohne Login und sofort', async () => {
    const email = newAddress('unsubscribe');
    const { token } = await enter(email);
    await service.confirm(token!, SOURCE);
    const unsubscribeToken = (await rowFrom(email))!.unsubscribeToken!;

    const before = Date.now();
    await service.unsubscribe(unsubscribeToken, SOURCE);

    const row = await rowFrom(email);
    expect(row?.status).toBe('unsubscribed');
    expect(row?.unsubscribedAt!.getTime()).toBeGreaterThanOrEqual(before - 1000);
  });

  /**
   * „Sonst wird die Person nach dem nächsten Import wieder angeschrieben."
   */
  it('lässt den Datensatz als SPERREINTRAG bestehen', async () => {
    const email = newAddress('sperreintrag');
    const { token } = await enter(email);
    await service.confirm(token!, SOURCE);
    await service.unsubscribe((await rowFrom(email))!.unsubscribeToken!, SOURCE);

    const row = await rowFrom(email);
    expect(row).not.toBeNull();
    expect(row?.status).toBe('unsubscribed');
    // Der Nachweis bleibt lesbar: Er belegt, dass es je eine Einwilligung gab.
    expect(row?.formText).toBe(FORM_TEXT);
  });

  it('ist idempotent', async () => {
    const email = newAddress('abmeldung-zweimal');
    const { token } = await enter(email);
    await service.confirm(token!, SOURCE);
    const unsubscribeToken = (await rowFrom(email))!.unsubscribeToken!;
    await service.unsubscribe(unsubscribeToken, SOURCE);
    await expect(service.unsubscribe(unsubscribeToken, SOURCE)).resolves.toMatchObject(
      { abortedMails: 0 },
    );
  });

  it('kennt einen erfundenen Abmeldelink nicht', async () => {
    await expect(service.unsubscribe('gibt-es-nicht', SOURCE)).rejects.toMatchObject(
      { errorCode: 'abmeldung_unbekannt' },
    );
  });

  it('erlaubt nach einer Abmeldung eine neue, eigene Eintragung', async () => {
    const email = newAddress('rueckkehr');
    const { token } = await enter(email);
    await service.confirm(token!, SOURCE);
    await service.unsubscribe((await rowFrom(email))!.unsubscribeToken!, SOURCE);

    const second = await enter(email);
    expect(second.mailSent).toBe(true);
    const row = await rowFrom(email);
    // Zurück auf Anfang: unbestätigt, ohne Abmeldezeitpunkt, ohne alten Token.
    expect(row?.status).toBe('unconfirmed');
    expect(row?.unsubscribedAt).toBeNull();
    expect(row?.unsubscribeToken).toBeNull();
  });

  /**
   * Eine Beschwerde ist endgültig. Wer den Spam-Knopf gedrückt hat, wird nicht
   * dadurch wieder anschreibbar, dass jemand die Adresse erneut einträgt.
   */
  it('lässt eine als Spam gemeldete Adresse NICHT zurückkehren', async () => {
    const email = newAddress('beschwerde');
    await enter(email);
    const row = await rowFrom(email);
    await service.deactivate(prisma, row!.id, 'spam_reported', 'Testfall');

    mailbox.length = 0;
    await enter(email);
    expect(mailbox).toHaveLength(0);
    expect((await rowFrom(email))?.status).toBe('spam_reported');
  });
});

describe('Die einzige automatische Löschung: 72 Stunden', () => {
  /** Verschiebt den Anmeldezeitpunkt um die angegebenen Stunden zurück. */
  async function age(email: string, hours: number): Promise<void> {
    await prisma.consent.update({
      where: { emailIdx: consentEmailIndex(email) },
      data: { subscribedAt: new Date(Date.now() - hours * 60 * 60 * 1000) },
    });
  }

  it('löscht einen unbestätigten Eintrag nach 72 Stunden vollständig', async () => {
    const email = newAddress('expired');
    await enter(email);
    await age(email, CONFIRMATION_VALID_HOURS + 1);

    const result = await cleanup.execute('test');
    expect(result.deleted).toBeGreaterThanOrEqual(1);
    expect(await rowFrom(email)).toBeNull();
  });

  it('lässt einen BESTÄTIGTEN Eintrag unangetastet, auch nach Jahren', async () => {
    const email = newAddress('alt-bestaetigt');
    const { token } = await enter(email);
    await service.confirm(token!, SOURCE);
    await age(email, 24 * 365);

    await cleanup.execute('test');
    expect((await rowFrom(email))?.status).toBe('confirmed');
  });

  it('lässt einen SPERREINTRAG unangetastet', async () => {
    const email = newAddress('alt-abgemeldet');
    const { token } = await enter(email);
    await service.confirm(token!, SOURCE);
    await service.unsubscribe((await rowFrom(email))!.unsubscribeToken!, SOURCE);
    await age(email, 24 * 365);

    await cleanup.execute('test');
    expect((await rowFrom(email))?.status).toBe('unsubscribed');
  });

  it('lässt einen frischen unbestätigten Eintrag stehen', async () => {
    const email = newAddress('frisch');
    await enter(email);
    await age(email, CONFIRMATION_VALID_HOURS - 1);

    await cleanup.execute('test');
    expect((await rowFrom(email))?.status).toBe('unconfirmed');
  });

  /**
   * Eine automatische Löschung ohne Spur wäre nicht zu verantworten — sie ist
   * die Ausnahme von R4 und muss deshalb sichtbar sein.
   */
  it('hinterlässt für jede Löschung einen Audit-Eintrag', async () => {
    const email = newAddress('nachweisbar');
    await enter(email);
    const id = (await rowFrom(email))!.id;
    await age(email, CONFIRMATION_VALID_HOURS + 5);

    await cleanup.execute('test');

    const entries = await prisma.auditLog.findMany({
      where: {
        objectId: id,
        action: AUDIT_ACTION.consentUnconfirmedDeleted,
      },
    });
    expect(entries).toHaveLength(1);
    // KEINE ADRESSE IM NACHWEIS: Das Audit-Log hat keinen Löschweg.
    expect(JSON.stringify(entries[0])).not.toContain(email);
  });

  /**
   * DER FALL, DER OHNE SPERRE DURCHRUTSCHT: Wer in der Sekunde vor dem
   * Löschen bestätigt, darf nicht gelöscht werden.
   *
   * Deshalb löscht der Lauf BEDINGT (`status = unbestaetigt`) und die
   * Bestätigung schreibt ebenfalls bedingt. Der Test lässt beide Vorgänge
   * WIRKLICH gleichzeitig laufen — mit einem einfachen „erst lesen, dann
   * schreiben" auf beiden Seiten wäre der Ausgang Zufall.
   *
   * Geprüft wird die Invariante, nicht der Ausgang: Wenn die Bestätigung
   * gelungen ist, MUSS die Zeile bestätigt dastehen. Eine bestätigte
   * Einwilligung, die anschliessend verschwunden ist, wäre der Fehler.
   */
  it('verliert unter Nebenläufigkeit keine bestätigte Einwilligung', async () => {
    const count = 12;
    const addresses: { email: string; token: string }[] = [];
    for (let number = 0; number < count; number += 1) {
      const email = newAddress(`rennen-${number}`);
      const { token } = await enter(email);
      await age(email, CONFIRMATION_VALID_HOURS + 1);
      addresses.push({ email, token: token! });
    }

    const confirmations = addresses.map(async (entry) => {
      try {
        // Die Fristprüfung des Dienstes würde hier greifen; geprüft werden
        // soll aber das Zusammentreffen der SCHREIBVORGÄNGE. Deshalb der
        // direkte, bedingte Schreibvorgang — genau wie ihn der Dienst macht.
        const { count } = await prisma.consent.updateMany({
          where: { emailIdx: consentEmailIndex(entry.email), status: 'unconfirmed' },
          data: {
            status: 'confirmed',
            confirmedAt: new Date(),
            unsubscribeToken: `${entry.token}-ab`,
          },
        });
        return count === 1;
      } catch {
        return false;
      }
    });

    const [successful] = await Promise.all([
      Promise.all(confirmations),
      cleanup.execute('test'),
      cleanup.execute('test'),
    ]);

    for (const [number, entry] of addresses.entries()) {
      const row = await rowFrom(entry.email);
      if (successful[number]) {
        // Bestätigt heisst: die Zeile steht noch, und sie steht auf bestätigt.
        expect(row).not.toBeNull();
        expect(row?.status).toBe('confirmed');
      } else {
        // Nicht bestätigt heisst: gelöscht oder unverändert — nie „bestätigt".
        expect(row?.status ?? 'deleted').not.toBe('confirmed');
      }
    }
  });

  it('löscht eine bereits bestätigte Zeile auch nach Ablauf nicht', async () => {
    const email = newAddress('short');
    const { token } = await enter(email);
    await service.confirm(token!, SOURCE);
    await age(email, CONFIRMATION_VALID_HOURS + 1);

    await cleanup.execute('test');
    expect((await rowFrom(email))?.status).toBe('confirmed');
  });

  it('weist einen abgelaufenen Bestätigungslink ab, bevor der Lauf greift', async () => {
    const email = newAddress('link-abgelaufen');
    const { token } = await enter(email);
    await age(email, CONFIRMATION_VALID_HOURS + 2);
    await expect(service.confirm(token!, SOURCE)).rejects.toMatchObject({
      errorCode: 'bestaetigung_unbekannt',
    });
    expect((await rowFrom(email))?.status).toBe('unconfirmed');
  });
});

describe('Je Adresse genau ein Eintrag', () => {
  it('legt bei zwei gleichzeitigen Eintragungen keine zweite Zeile an', async () => {
    const email = newAddress('gleichzeitig');
    await Promise.all([enter(email), enter(email), enter(email)]);
    const all = await prisma.consent.findMany({
      where: { emailIdx: consentEmailIndex(email) },
    });
    expect(all).toHaveLength(1);
  });

  it('behandelt Gross- und Kleinschreibung als DIESELBE Adresse', async () => {
    const email = newAddress('schreibweise');
    await enter(email);
    await enter(email.toUpperCase());
    // E-Mail ist verschlüsselt: im Speicher filtern.
    const all = (await prisma.consent.findMany()).filter((c) =>
      c.email.includes('schreibweise'),
    );
    expect(all).toHaveLength(1);
  });
});

/**
 * ===========================================================================
 * [K2] — KONTINGENT JE ADRESSE
 * ===========================================================================
 *
 * Gemessen wurde: zwölf Eintragungen für DIESELBE fremde Adresse, je eigene
 * Quell-IP, zwölfmal `200`, zwölf Bestätigungsmails im Postfach des Opfers.
 * Das globale Rate-Limit zählt gegen den Absender und greift dabei nicht.
 *
 * Jeder Test hier fällt gegen die Fassung ohne Kontingent.
 */
describe('[K2] Eine fremde Adresse lässt sich nicht mit Post belegen', () => {
  /** Datiert die letzte Bestätigungsmail um die angegebenen Minuten zurück. */
  async function mailBackdate(
    email: string,
    minutes: number,
  ): Promise<void> {
    await prisma.consent.update({
      where: { emailIdx: consentEmailIndex(email) },
      data: {
        confirmationMailAt: new Date(Date.now() - minutes * 60 * 1000),
      },
    });
  }

  it('verschickt bei zwölf Eintragungen in Folge genau EINE Mail', async () => {
    const email = newAddress('k2-schwall');
    for (let attempt = 0; attempt < 12; attempt += 1) {
      await expect(enter(email)).resolves.toBeDefined();
    }
    expect(mailbox.filter((m) => m.email === email)).toHaveLength(1);
  });

  it('antwortet dabei jedes Mal gleich — der Aufzählungsschutz bleibt', async () => {
    const email = newAddress('k2-antwort');
    // Der Dienst gibt nichts zurück; „gleich" heisst hier: kein Fehler, kein
    // Unterschied zwischen erster und zwölfter Eintragung.
    for (let attempt = 0; attempt < 12; attempt += 1) {
      await expect(
        service.subscribe(
          { email, formText: FORM_TEXT },
          SOURCE,
        ),
      ).resolves.toBeUndefined();
    }
  });

  /**
   * DIE STELLE, AN DER EINE SCHLECHTE SPERRE ZUM ANGRIFF WIRD: Würde jede
   * abgelehnte Eintragung trotzdem einen neuen Token setzen, wäre der bereits
   * verschickte Link tot — und die Person, der die Adresse gehört, könnte gar
   * nicht mehr bestätigen. Die Sperre fasst die Zeile deshalb nicht an.
   */
  it('lässt den bereits verschickten Bestätigungslink gültig', async () => {
    const email = newAddress('k2-linkbleibt');
    const { token } = await enter(email);
    for (let attempt = 0; attempt < 8; attempt += 1) await enter(email);

    await expect(service.confirm(token!, SOURCE)).resolves.toBeDefined();
    expect((await rowFrom(email))?.status).toBe('confirmed');
  });

  it('lässt nach Ablauf der Sperrfrist eine zweite Mail zu — aber nicht beliebig viele', async () => {
    const email = newAddress('k2-nachlegen');
    await enter(email);
    expect(mailbox.filter((m) => m.email === email)).toHaveLength(1);

    // Zweite und dritte Mail: je nach Ablauf der Sperrfrist erlaubt.
    for (let round = 2; round <= MAX_CONFIRMATION_MAILS; round += 1) {
      await mailBackdate(email, MAIL_BLOCK_PERIOD_MINUTES + 1);
      await enter(email);
      expect(mailbox.filter((m) => m.email === email)).toHaveLength(round);
    }

    // Die vierte nicht mehr — auch nicht nach Ablauf der Sperrfrist.
    await mailBackdate(email, MAIL_BLOCK_PERIOD_MINUTES + 1);
    await enter(email);
    expect(mailbox.filter((m) => m.email === email)).toHaveLength(
      MAX_CONFIRMATION_MAILS,
    );
  });

  /**
   * Die Gegenprobe: Das Kontingent gilt JE VORGANG. Wer sich ein Jahr später
   * noch einmal einträgt, bekommt wieder eine Mail — sonst wäre die Sperre
   * eine dauerhafte Ausschliessung durch einen Fremden.
   */
  it('beginnt nach Ablauf des Bestätigungsvorgangs von vorn', async () => {
    const email = newAddress('k2-neuerversuch');
    for (let round = 0; round < MAX_CONFIRMATION_MAILS; round += 1) {
      await mailBackdate(email, MAIL_BLOCK_PERIOD_MINUTES + 1).catch(
        () => undefined,
      );
      await enter(email);
    }
    const before = mailbox.filter((m) => m.email === email).length;

    await mailBackdate(email, CONFIRMATION_VALID_HOURS * 60 + 60);
    await enter(email);
    expect(mailbox.filter((m) => m.email === email)).toHaveLength(before + 1);
  });
});

/**
 * ===========================================================================
 * [W4] — WIDERSPRUCH AUSSERHALB DES ABMELDELINKS
 * ===========================================================================
 *
 * Art. 21 Abs. 1 DSGVO und § 7 UWG binden die Wirksamkeit an keinen Kanal.
 * Vorher liess sich ein telefonischer Widerspruch technisch nicht umsetzen,
 * und `spam_gemeldet` wurde nirgends geschrieben.
 *
 * Alle Tests hier fallen gegen die Fassung ohne `sperreAdresse`.
 */
describe('[W4] Eine Adresse lässt sich von Hand sperren', () => {
  const CLERK = { userId: null, name: 'sam' };

  it('setzt einen bestätigten Eintrag auf abgemeldet', async () => {
    const email = newAddress('w4-widerspruch');
    const { token } = await enter(email);
    await service.confirm(token!, SOURCE);

    const result = await service.blockAddress(
      email,
      'unsubscribed',
      'Telefonischer Widerspruch am 30.08.2026',
      CLERK,
      SOURCE,
    );

    expect(result.created).toBe(false);
    const row = await rowFrom(email);
    expect(row?.status).toBe('unsubscribed');
    expect(row?.unsubscribedAt).not.toBeNull();
    // Der Nachweis der früheren Einwilligung bleibt lesbar.
    expect(row?.formText).toBe(FORM_TEXT);
  });

  /**
   * Der Fall, der ohne diese Route unlösbar war: Jemand widerspricht, der bei
   * uns gar nicht eingetragen ist. Ohne Sperreintrag schriebe ihn der nächste
   * Import wieder an.
   */
  it('legt zu einer unbekannten Adresse einen reinen Sperreintrag an', async () => {
    const email = newAddress('w4-unbekannt');
    expect(await rowFrom(email)).toBeNull();

    const result = await service.blockAddress(
      email,
      'unsubscribed',
      'Widerspruch per Brief, eingegangen am 29.08.2026',
      CLERK,
      SOURCE,
    );

    expect(result.created).toBe(true);
    const row = await rowFrom(email);
    expect(row?.status).toBe('unsubscribed');
    // KEIN Einwilligungsnachweis — der Vermerk sagt das ausdrücklich.
    expect(row?.formText).toBe(BLOCK_WITHOUT_CONSENT);
    expect(row?.confirmedAt).toBeNull();
  });

  it('kann eine Beschwerde als spam_gemeldet festhalten', async () => {
    const email = newAddress('w4-beschwerde');
    await service.blockAddress(
      email,
      'spam_reported',
      'Beschwerde über den Postfachanbieter eingegangen',
      CLERK,
      SOURCE,
    );
    const row = await rowFrom(email);
    expect(row?.status).toBe('spam_reported');
    expect(row?.deactivatedAt).not.toBeNull();
  });

  /**
   * Die Sperre wirkt SOFORT, nicht erst ab der nächsten Rundmail: Was schon in
   * der Warteschlange steht, wird abgebrochen.
   */
  it('bricht bereits eingestellte Mails ab', async () => {
    const email = newAddress('w4-warteschlange');
    const { token } = await enter(email);
    await service.confirm(token!, SOURCE);
    const row = await rowFrom(email);

    await prisma.mailDelivery.create({
      data: {
        consentId: row!.id,
        recipientAddress: email,
        channel: 'marketing',
        subject: 'Steht schon in der Warteschlange',
        contentSnapshot: 'Text',
        deliveryStatus: 'queued',
      },
    });

    const result = await service.blockAddress(
      email,
      'unsubscribed',
      'Widerspruch am Telefon, sofort umzusetzen',
      CLERK,
      SOURCE,
    );
    expect(result.abortedMails).toBe(1);
    const send = await prisma.mailDelivery.findFirstOrThrow({
      where: { consentId: row!.id },
    });
    expect(send.deliveryStatus).toBe('rejected');
  });

  it('nennt im Audit-Log weder Adresse noch Begründungstext', async () => {
    const email = newAddress('w4-audit');
    const justification = 'Widerspruch von Frau Muster, telefonisch am 30.08.';
    const result = await service.blockAddress(
      email,
      'unsubscribed',
      justification,
      CLERK,
      SOURCE,
    );
    const entries = await prisma.auditLog.findMany({
      where: { objectId: result.consentId },
    });
    const raw = JSON.stringify(entries);
    expect(raw).not.toContain(email);
    expect(raw).not.toContain('Frau Muster');
    expect(raw).toContain('justificationLength');
  });
});

/**
 * ===========================================================================
 * [K4] — DIE ÜBERGANGSMATRIX, GEGEN DIE DATENBANK
 * ===========================================================================
 *
 * Der Befund kam durch, obwohl der Quelltext dreimal das Gegenteil versprach:
 * Der absichernde Test prüfte die ROUTENLISTE auf Namen wie „entsperren" und
 * konnte gar nicht sehen, dass die Sperrroute selbst abschwächt. Er gab
 * falsche Sicherheit.
 *
 * Dieser Test prüft deshalb, was zählt: JEDEN Ausgangszustand gegen JEDEN
 * Sperrgrund, am echten Dienst, mit echter Datenbank. Er fällt gegen die
 * Fassung ohne Rangprüfung.
 */
describe('[K4] Eine Sperre lässt sich nicht abschwächen', () => {
  const CLERK = { userId: null, name: 'sam' };
  const BLOCK = ['unsubscribed', 'hard_bounced', 'spam_reported'] as const;
  const OUTCOME = [
    'kein_eintrag',
    'unconfirmed',
    'confirmed',
    'unsubscribed',
    'hard_bounced',
    'spam_reported',
  ] as const;

  /** Stellt den Ausgangszustand her und gibt die Adresse zurück. */
  async function withState(
    label: string,
    outcome: (typeof OUTCOME)[number],
  ): Promise<string> {
    const email = newAddress(label);
    if (outcome === 'kein_eintrag') return email;

    const { token } = await enter(email);
    if (outcome === 'unconfirmed') return email;

    await service.confirm(token!, SOURCE);
    if (outcome === 'confirmed') return email;

    // Die drei Sperrzustände direkt setzen — der Weg dorthin ist hier nicht
    // der Gegenstand, der ÜBERGANG von dort ist es.
    await prisma.consent.update({
      where: { emailIdx: consentEmailIndex(email) },
      data: { status: outcome as ConsentStatus },
    });
    return email;
  }

  it.each(
    OUTCOME.flatMap((outcome) =>
      BLOCK.map((block) => [outcome, block] as const),
    ),
  )('von %s auf %s: der Rang sinkt nie', async (outcome, block) => {
    const short = `${outcome}-${block}`.replace(/_/g, '');
    const email = await withState(`k4-${short}`, outcome);
    const before =
      outcome === 'kein_eintrag' ? null : ((await rowFrom(email))!.status);

    const result = await service.blockAddress(
      email,
      block,
      `Prüfung des Übergangs ${outcome} → ${block}`,
      CLERK,
      SOURCE,
    );

    const after = (await rowFrom(email))!.status;
    // DIE EINE AUSSAGE, AUF DIE ES ANKOMMT.
    if (before !== null) {
      expect(BLOCK_RANK[after]).toBeGreaterThanOrEqual(BLOCK_RANK[before]);
    }
    // Und die Antwort nennt den GELTENDEN Zustand, nicht den gemeldeten.
    expect(result.status).toBe(after);
    expect(result.weakenedRefused).toBe(
      before !== null && BLOCK_RANK[block] <= BLOCK_RANK[before],
    );
  });

  /**
   * DER GEMESSENE ANGRIFF, Schritt für Schritt. Er endete vorher damit, dass
   * eine als Spam meldende Adresse eine zweite Bestätigungsmail bekam — der
   * Vorgang, der die Blocklistung der Domäne auslöst.
   */
  it('macht eine als Spam gemeldete Adresse nicht über den Umweg wieder anschreibbar', async () => {
    const email = newAddress('k4-angriff');

    // 1. Eintragen — eine Bestätigungsmail.
    await enter(email);
    expect(mailbox.filter((m) => m.email === email)).toHaveLength(1);

    // 2. Beschwerde über den Feedback-Loop.
    await service.blockAddress(
      email,
      'spam_reported',
      'Beschwerde über den Postfachanbieter eingegangen',
      CLERK,
      SOURCE,
    );
    expect((await rowFrom(email))?.status).toBe('spam_reported');

    // 3. Formular: richtig, es geht nichts hinaus.
    await enter(email);
    expect((await rowFrom(email))?.status).toBe('spam_reported');

    // 4. DER SCHRITT, DER VORHER DURCHKAM: Herabstufung auf `abgemeldet`.
    const weakening = await service.blockAddress(
      email,
      'unsubscribed',
      'Angeblicher Widerspruch, in Wahrheit eine Abschwächung',
      CLERK,
      SOURCE,
    );
    expect(weakening.weakenedRefused).toBe(true);
    expect((await rowFrom(email))?.status).toBe('spam_reported');

    // 5. Und deshalb geht auch danach keine zweite Bestätigungsmail hinaus.
    await enter(email);
    expect((await rowFrom(email))?.status).toBe('spam_reported');
    expect(mailbox.filter((m) => m.email === email)).toHaveLength(1);
  });

  it('hält die abgewiesene Abschwächung im Nachweis fest', async () => {
    const email = newAddress('k4-nachweis');
    await service.blockAddress(
      email,
      'spam_reported',
      'Beschwerde eingegangen, endgültig',
      CLERK,
      SOURCE,
    );
    const result = await service.blockAddress(
      email,
      'unsubscribed',
      'Versuch der Herabstufung, muss abgewiesen werden',
      CLERK,
      SOURCE,
    );

    const entries = await prisma.auditLog.findMany({
      where: { objectId: result.consentId },
      orderBy: { timestamp: 'asc' },
    });
    const last = JSON.stringify(entries[entries.length - 1]);
    // Der Eintrag darf NICHT aussehen wie eine gelungene Herabstufung.
    expect(last).toContain('"weakenedRefused":true');
    expect(last).toContain('"status":"spam_reported"');
    expect(last).toContain('"reported":"unsubscribed"');
  });

  /**
   * Die Gegenprobe: Eine VERSCHÄRFUNG muss weiterhin durchgehen — sonst hätte
   * die Reparatur die Route unbrauchbar gemacht statt sie zu berichtigen.
   */
  it('lässt die Verschärfung von abgemeldet auf spam_gemeldet zu', async () => {
    const email = newAddress('k4-verschaerfung');
    await service.blockAddress(
      email,
      'unsubscribed',
      'Widerspruch am Telefon, sofort umzusetzen',
      CLERK,
      SOURCE,
    );
    const result = await service.blockAddress(
      email,
      'spam_reported',
      'Danach ging zusätzlich eine Beschwerde ein',
      CLERK,
      SOURCE,
    );
    expect(result.weakenedRefused).toBe(false);
    expect((await rowFrom(email))?.status).toBe('spam_reported');
  });
});

/**
 * DER ANLASS — die Pflichtangabe, die nirgends ankam.
 *
 * `AdresseSperrenDto.begruendung` ist Pflicht, verlangt mindestens zehn
 * Zeichen und trägt seit jeher den Kommentar: „Eine Sperre ohne
 * festgehaltenen Anlass lässt sich später nicht mehr belegen." Der Wortlaut
 * wurde entgegengenommen, geprüft — und dann ausschliesslich als LÄNGE ins
 * Audit-Log geschrieben. Der Kommentar daneben behauptete, er stehe „am
 * Eintrag selbst". Es gab keine Spalte.
 *
 * Damit war die strengste Validierung des Moduls eine Formalie: Wer später
 * fragte, warum er keine Post mehr bekommt, hätte „es wurden 39 Zeichen
 * erfasst" zur Antwort bekommen.
 */
describe('Der Anlass einer Sperre steht am Eintrag', () => {
  const CLERK = { userId: null, name: 'sam' };

  it('HÄLT DEN WORTLAUT FEST, nicht seine Länge', async () => {
    const email = newAddress('anlass-wortlaut');
    const reason = 'Telefonischer Widerspruch am 30.08.2026, Frau Reit';

    await service.blockAddress(
      email,
      'unsubscribed',
      reason,
      CLERK,
      SOURCE,
    );

    expect((await rowFrom(email))?.blockReason).toBe(reason);
  });

  it('hält ihn auch an einem Eintrag fest, den es vorher nicht gab', async () => {
    const email = newAddress('anlass-neu');
    await service.blockAddress(
      email,
      'spam_reported',
      'Beschwerde über den Postfachanbieter, 31.08.2026',
      CLERK,
      SOURCE,
    );

    expect((await rowFrom(email))?.blockReason).toBe(
      'Beschwerde über den Postfachanbieter, 31.08.2026',
    );
  });

  it('ERSETZT IHN, wenn eine stärkere Sperre den Zustand ersetzt', async () => {
    const email = newAddress('anlass-staerker');
    await service.blockAddress(
      email,
      'unsubscribed',
      'Widerspruch per Brief, 20.08.2026',
      CLERK,
      SOURCE,
    );
    await service.blockAddress(
      email,
      'spam_reported',
      'Als Spam gemeldet, Rückmeldung Provider 25.08.2026',
      CLERK,
      SOURCE,
    );

    const row = await rowFrom(email);
    expect(row?.status).toBe('spam_reported');
    // Der Anlass gehört zum ZUSTAND. Bliebe der alte stehen, stünde neben
    // „spam_gemeldet" die Begründung einer Abmeldung.
    expect(row?.blockReason).toBe(
      'Als Spam gemeldet, Rückmeldung Provider 25.08.2026',
    );
  });

  it('LÄSST IHN STEHEN, wenn die Meldung abgeschwächt abgewiesen wird [K4]', async () => {
    const email = newAddress('anlass-schwaecher');
    await service.blockAddress(
      email,
      'spam_reported',
      'Als Spam gemeldet, Rückmeldung Provider 25.08.2026',
      CLERK,
      SOURCE,
    );
    const result = await service.blockAddress(
      email,
      'unsubscribed',
      'Anruf, will nur den Newsletter nicht mehr',
      CLERK,
      SOURCE,
    );

    expect(result.weakenedRefused).toBe(true);
    const row = await rowFrom(email);
    expect(row?.status).toBe('spam_reported');
    // Der Zustand bleibt — und sein Anlass mit ihm. Den schwächeren Anlass
    // zu schreiben hiesse, den geltenden Zustand falsch zu begründen.
    expect(row?.blockReason).toBe(
      'Als Spam gemeldet, Rückmeldung Provider 25.08.2026',
    );
  });

  it('SCHREIBT DEN WORTLAUT NICHT INS AUDIT-LOG, nur seine Länge', async () => {
    // Das Audit-Log hat keinen Löschweg (R6). Ein Freitext über eine Person
    // gehört dorthin, wo er mit ihr verschwinden kann.
    const email = newAddress('anlass-nicht-im-log');
    const reason = 'Telefonat mit Frau Reit, will keine Post mehr';
    await service.blockAddress(
      email,
      'unsubscribed',
      reason,
      CLERK,
      SOURCE,
    );

    const entries = await prisma.auditLog.findMany({
      where: { action: 'consent.blocked_manually' },
      orderBy: { timestamp: 'desc' },
      take: 5,
    });
    const asText = JSON.stringify(entries);
    expect(asText).not.toContain('Frau Reit');
    expect(asText).not.toContain(email);
  });
});

describe('Die Sperrliste', () => {
  const CLERK = { userId: null, name: 'sam' };

  it('zeigt jede gesperrte Adresse mit Grund, Anlass und Zeitpunkt', async () => {
    const email = newAddress('liste-eintrag');
    await service.blockAddress(
      email,
      'hard_bounced',
      'Fünfmal hart abgewiesen, Postfach existiert nicht',
      CLERK,
      SOURCE,
    );

    const list = await service.blocklist();
    const row = list.find((z) => z.email === email);
    expect(row).toBeDefined();
    expect(row!.status).toBe('hard_bounced');
    expect(row!.reason).toBe('Fünfmal hart abgewiesen, Postfach existiert nicht');
    expect(row!.registeredAt).not.toBeNull();
  });

  it('NIMMT AUCH DIE SELBSTABMELDUNGEN AUF — ohne Anlass', async () => {
    // Die Liste beantwortet „wer bekommt nichts mehr". Nur die eigenen
    // Einträge zu zeigen beantwortete eine andere Frage.
    const email = newAddress('liste-selbst');
    const { token } = await enter(email);
    await service.confirm(token!, SOURCE);
    const rowBefore = await rowFrom(email);
    await service.unsubscribe(rowBefore!.unsubscribeToken!, SOURCE);

    const row = (await service.blocklist()).find((z) => z.email === email);
    expect(row).toBeDefined();
    expect(row!.status).toBe('unsubscribed');
    // Wer sich selbst abmeldet, nennt keinen Anlass. Einen zu erfinden wäre
    // eine Behauptung über eine fremde Handlung.
    expect(row!.reason).toBeNull();
  });

  it('lässt bestätigte Adressen heraus', async () => {
    const email = newAddress('liste-bestaetigt');
    const { token } = await enter(email);
    await service.confirm(token!, SOURCE);

    expect((await service.blocklist()).some((z) => z.email === email)).toBe(false);
  });
});
