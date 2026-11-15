import type { ConfigService } from '@nestjs/config';
import { AuditService } from '../audit/audit.service';
import type { MailService } from '../mail/mail.service';
import type { PrismaService } from '../prisma/prisma.service';
import {
  SUBSCRIPTION_MIN_DURATION_MS,
  ConsentService,
} from './consent.service';

/**
 * ===========================================================================
 * [W8] DIE EINTRAGUNG VERRÄT NICHT, OB EINE ADRESSE BEKANNT IST
 * ===========================================================================
 *
 * Gemessen wurde:
 * ```
 * UNBEKANNT (Mail geht raus)  Median 55,7 ms   min 51,5   max 62,4
 * BEKANNT   (keine Mail)      Median  4,9 ms   min  3,3   max  6,5
 * Überschneidung: keine
 * ```
 *
 * Die ANTWORT war immer dieselbe, die ANTWORTZEIT nicht — und mit einer
 * einzigen Anfrage liess sich damit prüfen, ob eine Adresse im Register steht.
 *
 * Diese Suite misst mit einem künstlich VERLANGSAMTEN Mailversand: Sie fällt
 * gegen die Fassung, die den Versand im Antwortpfad abwartete, weil die
 * Spreizung dann sofort wieder auftritt. Gemessen wird der Dienst selbst, ohne
 * Netz und ohne HTTP — was hier schon auseinanderläuft, läuft über die
 * Leitung erst recht auseinander.
 */

jest.setTimeout(60_000);

/** Wie lange die Mail-Attrappe „braucht". Deutlich über der Mindestdauer. */
const SEND_DURATION_MS = 400;

/** So viele Messungen je Zweig. */
const RUNS = 5;

interface Row {
  id: string;
  email: string;
  status: string;
  confirmationMailAt: Date | null;
  confirmationMailCount: number;
  companyId: string | null;
}

/**
 * Ein Datenbank-Doppel, das genau die Abfragen dieses Ablaufs kennt.
 *
 * Bewusst ohne echte Datenbank: Deren Schwankung läge in derselben
 * Grössenordnung wie der zu messende Unterschied und machte die Aussage
 * unbrauchbar.
 */
function buildDouble(present: Row | null): PrismaService {
  let row = present;
  const tx = {
    $executeRaw: async () => 0,
    $queryRaw: async () => [],
    consent: {
      findUnique: async () => row,
      findUniqueOrThrow: async () => {
        if (!row) throw new Error('nicht gefunden');
        return row;
      },
      update: async ({ data }: { data: Record<string, unknown> }) => {
        row = { ...(row as Row), ...(data as Partial<Row>) };
        return row;
      },
      create: async ({ data }: { data: Record<string, unknown> }) => {
        row = {
          ...(data as unknown as Row),
          id: 'incoming',
          companyId: null,
        };
        return row;
      },
    },
    company: { update: async () => ({}) },
    auditLog: { create: async () => ({}) },
  };
  return {
    $transaction: async (work: (t: unknown) => Promise<unknown>) => work(tx),
    auditLog: { create: async () => ({}) },
  } as unknown as PrismaService;
}

function buildService(present: Row | null): {
  service: ConsentService;
  sent: () => number;
} {
  const prisma = buildDouble(present);
  let sent = 0;
  const mail = {
    sendConsentConfirmation: async () => {
      sent += 1;
      // Der SMTP-Roundtrip, künstlich verlangsamt. Genau er hing vorher im
      // Antwortpfad und machte den Unterschied messbar.
      await new Promise((done) => setTimeout(done, SEND_DURATION_MS));
    },
  } as unknown as MailService;
  const config = {
    get: (_name: string, defaultValue?: string) => defaultValue,
  } as unknown as ConfigService;
  return {
    service: new ConsentService(prisma, new AuditService(prisma), mail, config),
    sent: () => sent,
  };
}

const INPUT = {
  email: 'wen-auch-immer@example.com',
  formText:
    'Ja, ich möchte die Beispielprodukt-Rundmail bekommen und kann widersprechen.',
};
const SOURCE = { ip: '203.0.113.5', userAgent: 'Zeitmessung' };

/** Median der Messreihe in Millisekunden. */
function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)]!;
}

async function measure(present: Row | null): Promise<number[]> {
  const times: number[] = [];
  for (let run = 0; run < RUNS; run += 1) {
    const { service } = buildService(
      present === null ? null : { ...present },
    );
    const start = process.hrtime.bigint();
    await service.subscribe({ ...INPUT }, SOURCE);
    times.push(Number(process.hrtime.bigint() - start) / 1_000_000);
  }
  return times;
}

/** Eine bereits bestätigte Zeile: der Zweig, der früh zurückkehrt. */
const CONFIRMED: Row = {
  id: 'e-1',
  email: INPUT.email,
  status: 'confirmed',
  confirmationMailAt: new Date(),
  confirmationMailCount: 1,
  companyId: null,
};

/** Eine Zeile, die das Kontingent gerade abweist — der schnellste Zweig. */
const IN_QUOTA: Row = {
  ...CONFIRMED,
  status: 'unconfirmed',
  confirmationMailAt: new Date(),
  confirmationMailCount: 3,
};

describe('[W8] Die Eintragung hat keinen Zeitkanal', () => {
  it('misst überhaupt etwas (sonst prüft der Test nichts)', async () => {
    const { service, sent } = buildService(null);
    await service.subscribe({ ...INPUT }, SOURCE);
    // Der Versand läuft nebenläufig weiter; kurz Zeit geben.
    await new Promise((done) => setTimeout(done, SEND_DURATION_MS + 50));
    expect(sent()).toBe(1);
  });

  it('antwortet für eine unbekannte Adresse nicht langsamer als für eine bekannte', async () => {
    const unknown = median(await measure(null));
    const known = median(await measure(CONFIRMED));
    const inQuota = median(await measure(IN_QUOTA));

    process.stdout.write(
      `\n  [W8] Mediane: unbekannt ${unknown.toFixed(1)} ms · ` +
        `bekannt ${known.toFixed(1)} ms · ` +
        `Kontingent ${inQuota.toFixed(1)} ms\n`,
    );

    // KEIN Zweig darf den Versand abwarten. Läge er im Antwortpfad, wäre der
    // erste Wert um VERSANDDAUER_MS grösser als die beiden anderen.
    for (const value of [unknown, known, inQuota]) {
      expect(value).toBeGreaterThanOrEqual(SUBSCRIPTION_MIN_DURATION_MS * 0.9);
      expect(value).toBeLessThan(SUBSCRIPTION_MIN_DURATION_MS + SEND_DURATION_MS * 0.5);
    }

    // Und die Zweige liegen dicht beieinander: höchstens ein Zehntel der
    // Mindestdauer auseinander.
    const spread = Math.max(unknown, known, inQuota) -
      Math.min(unknown, known, inQuota);
    expect(spread).toBeLessThan(SUBSCRIPTION_MIN_DURATION_MS * 0.25);
  });

  it('hält auch den Honeypot-Zweig auf derselben Dauer', async () => {
    const { service } = buildService(null);
    const start = process.hrtime.bigint();
    await service.subscribe(
      { ...INPUT, website: 'https://spam.example' },
      SOURCE,
    );
    const duration = Number(process.hrtime.bigint() - start) / 1_000_000;
    expect(duration).toBeGreaterThanOrEqual(SUBSCRIPTION_MIN_DURATION_MS * 0.9);
  });
});
