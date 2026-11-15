import { randomUUID } from 'crypto';
import type { ConfigService } from '@nestjs/config';
import { AuditService } from '../audit/audit.service';
import { EmergencyService } from '../auth/emergency.service';
import { prisma } from '../test-support/company-provisioning';
import {
  OwnAccountError,
  AccountAlreadyHasAccessError,
  LastAccountError,
} from './user.errors';
import { UserService } from './user.service';
import { truncateAuditLog } from '../test-support/gobd-cleanup';

/**
 * ===========================================================================
 * DIE DREI REGELN DER NUTZERVERWALTUNG — gegen eine echte Datenbank
 * ===========================================================================
 *
 * Mit einer Attrappe wären zwei davon nicht zu belegen: die Sperre auf den
 * letzten Administrator läuft über `SELECT … FOR UPDATE` in einer
 * Transaktion, und die Ableitung des Zustands „eingeladen" hängt an einer
 * Zählung über eine Relation.
 *
 * Voraussetzung:
 *   docker compose --profile control up -d control-db
 *   pnpm --filter @saas-instant/control test:integration
 */

jest.setTimeout(120_000);

const PREFIX = `e8-nutzer-${randomUUID().slice(0, 8)}`;
const SOURCE = { ip: '203.0.113.7', userAgent: 'Jest-Integration' };

const config = {
  get: (_name: string, preset?: string) =>
    preset ?? 'https://verwaltung.example',
} as unknown as ConfigService;

const audit = new AuditService(prisma);
const emergency = new EmergencyService(
  prisma,
  config,
  audit,
  // Der Einladungsweg benutzt von `NotfallService` ausschliesslich
  // `erzeugeLink`. Geräte und Sitzungen kommen darin nicht vor.
  {} as never,
  {} as never,
);
const service = new UserService(prisma, audit, config, emergency);

const ACTOR = { userId: '', name: 'sam' };

/** Ein Konto mit gesetztem Passworthash — also eines, das „aktiv" ist. */
async function account(identifier: string) {
  return prisma.user.create({
    data: {
      name: `Test ${identifier}`,
      username: `${PREFIX}-${identifier}`,
      email: `${PREFIX}-${identifier}@example.com`,
      role: 'administrator',
      passwordHash: '$argon2id$attrappe',
      // OHNE ZWEITEN FAKTOR WAERE DIESES KONTO NICHT ANMELDEFAEHIG: Die
      // Anmeldung verlangt nach dem Passwort einen Faktor und boete eine leere
      // Auswahl an. Die Pruefung auf das letzte Konto zaehlt seit A.9 nur noch
      // Konten, die sich wirklich anmelden koennen — eine Attrappe ohne Faktor
      // haette dort nichts zu suchen.
      loginCodeEnabled: true,
    },
    select: { id: true, sessionGeneration: true },
  });
}

beforeAll(async () => {
  const owner = await prisma.user.create({
    data: {
      name: 'Sam Inhaberin',
      username: `${PREFIX}-inhaber`,
      email: `${PREFIX}-inhaber@example.com`,
      role: 'owner',
      passwordHash: '$argon2id$attrappe',
    },
    select: { id: true },
  });
  ACTOR.userId = owner.id;
});

afterAll(async () => {
  await prisma.emergencyEnrollment.deleteMany({
    where: { user: { username: { startsWith: PREFIX } } },
  });
  await truncateAuditLog(prisma);
  await prisma.user.deleteMany({
    where: { username: { startsWith: PREFIX } },
  });
});

describe('Eintragen legt ein Konto OHNE Zugang an', () => {
  it('erzeugt Konto und Zugangslink; das Konto hat noch keinen Weg hinein', async () => {
    const result = await service.register(
      {
        name: 'Neue Kollegin',
        email: `${PREFIX}-neu@example.com`,
      },
      ACTOR,
      SOURCE,
    );

    expect(result.user.state).toBe('without_access');
    expect(result.link).toContain('/emergency-password?token=');

    const line = await prisma.user.findUniqueOrThrow({
      where: { id: result.user.id },
      select: { passwordHash: true, role: true, deactivatedAt: true },
    });
    // OHNE PASSWORT UND OHNE FAKTOR — es gibt keinen Weg hinein.
    expect(line.passwordHash).toBeNull();
    // ALLE KONTEN KÖNNEN DASSELBE. Die Rolle unterscheidet keine Rechte —
    // sie hält nur fest, welches Konto am Anfang stand.
    expect(line.role).toBe('administrator');
    expect(line.deactivatedAt).toBeNull();
  });

  it('SPEICHERT DEN TOKEN NUR ALS HASH', async () => {
    const result = await service.register(
      {
        name: 'Zweite',
        email: `${PREFIX}-hash@example.com`,
      },
      ACTOR,
      SOURCE,
    );
    const token = result.link.split('token=')[1]!;

    const entries = await prisma.emergencyEnrollment.findMany({
      where: { userId: result.user.id },
      select: { tokenHash: true },
    });
    expect(entries).toHaveLength(1);
    // Wer die Datenbank liest, hat den Link damit NICHT.
    expect(entries[0]!.tokenHash).not.toBe(token);
    expect(entries[0]!.tokenHash).toHaveLength(64);
  });

  it('gibt einem Konto MIT Zugang keinen neuen Zugangslink', async () => {
    // Das wäre ein Passwort-Zurücksetzen durch die Administration — ein
    // anderer Vorgang mit anderen Folgen, und einer, den es hier nicht gibt.
    const withAccess = await account('mit-zugang');
    await expect(
      service.newAccessLink(withAccess.id, ACTOR, SOURCE),
    ).rejects.toBeInstanceOf(AccountAlreadyHasAccessError);
  });
});

describe('Das letzte aktive Konto bleibt', () => {
  it('WEIST DEN ENTZUG DES LETZTEN ZUGANGS AB', async () => {
    // DIE VORAUSSETZUNG WIRD HERGESTELLT, NICHT ANGENOMMEN.
    //
    // Der erste Entwurf dieses Tests stieg still aus, wenn die Datenbank
    // mehr als ein Administrationskonto enthielt — er wäre grün gewesen,
    // ohne irgendetwas zu prüfen. Ein Test, der sich selbst überspringt, ist
    // schlimmer als keiner.
    //
    // Stattdessen werden fremde Konten für die Dauer des Tests stillgelegt
    // und danach wieder eingeschaltet. Über `scripts/integrationslauf.mjs`
    // gibt es ohnehin keine.
    // Der Handelnde muss ein ECHTES Konto sein: Die Ablehnung wird
    // protokolliert, und das Audit-Log hat einen Fremdschlüssel auf den
    // Benutzer. Eine erfundene Kennung schlüge dort als Prisma-Fehler durch
    // — und der Test prüfte dann den falschen Fehler.
    const actor = await account('handelnd');
    const asActor = { ...ACTOR, userId: actor.id };

    const foreign = await prisma.user.findMany({
      where: {
        deactivatedAt: null,
        id: { notIn: [ACTOR.userId, actor.id] },
      },
      select: { id: true },
    });
    await prisma.user.updateMany({
      where: {
        id: { in: [...foreign.map((f) => f.id), actor.id] },
      },
      data: { deactivatedAt: new Date() },
    });

    try {
      await expect(
        service.setAccess(ACTOR.userId, false, asActor, SOURCE),
      ).rejects.toBeInstanceOf(LastAccountError);

      // DIE ABLEHNUNG STEHT IM NACHWEIS. Dass jemand es vorhatte, ist selbst
      // eine Auskunft — dieselbe Begründung wie bei
      // `faktor.entfernen_abgelehnt`.
      const rejected = await prisma.auditLog.count({
        where: {
          objectId: ACTOR.userId,
          action: 'user.last_account_rejected',
        },
      });
      expect(rejected).toBe(1);
    } finally {
      await prisma.user.updateMany({
        where: { id: { in: foreign.map((f) => f.id) } },
        data: { deactivatedAt: null },
      });
    }
  });

  it('lässt den Entzug zu, solange ein zweites Konto Zugang behält', async () => {
    const one = await account('konto-a');
    await account('konto-b');

    const after = await service.setAccess(one.id, false, ACTOR, SOURCE);
    expect(after.state).toBe('locked');
  });

});

describe('Das eigene Konto schaltet man hier nicht ab', () => {
  it('weist den Zugangsentzug am eigenen Konto ab', async () => {
    await expect(
      service.setAccess(ACTOR.userId, false, ACTOR, SOURCE),
    ).rejects.toBeInstanceOf(OwnAccountError);
  });
});

describe('Zugang entziehen heisst nicht löschen (R4)', () => {
  it('LÄSST DAS KONTO STEHEN und beendet die laufenden Sitzungen', async () => {
    const wer = await account('entzug');

    const after = await service.setAccess(wer.id, false, ACTOR, SOURCE);
    expect(after.state).toBe('locked');

    const line = await prisma.user.findUniqueOrThrow({
      where: { id: wer.id },
      select: { deactivatedAt: true, sessionGeneration: true },
    });
    // DAS KONTO IST NOCH DA — sonst verlöre das Audit-Log seine Zuordnung.
    expect(line.deactivatedAt).not.toBeNull();
    // UND DIE SITZUNGEN SIND TOT. Ohne das bliebe ein entzogener Zugang bis
    // zu dreissig Tage bestehen.
    expect(line.sessionGeneration).toBeGreaterThan(wer.sessionGeneration);
  });

  it('erteilt den Zugang wieder — und beendet auch dabei die Sitzungen', async () => {
    const wer = await account('rueckkehr');
    await service.setAccess(wer.id, false, ACTOR, SOURCE);
    const after = await service.setAccess(wer.id, true, ACTOR, SOURCE);

    expect(after.state).toBe('active');
    const line = await prisma.user.findUniqueOrThrow({
      where: { id: wer.id },
      select: { deactivatedAt: true, sessionGeneration: true },
    });
    expect(line.deactivatedAt).toBeNull();
    expect(line.sessionGeneration).toBe(wer.sessionGeneration + 2);
  });
});

describe('Der abgeleitete Zustand', () => {
  it('unterscheidet eingeladen, aktiv und gesperrt', async () => {
    const invited = await service.register(
      {
        name: 'Zustand',
        email: `${PREFIX}-zustand@example.com`,
      },
      ACTOR,
      SOURCE,
    );
    const active = await account('zustand-aktiv');
    const locked = await account('zustand-gesperrt');
    await service.setAccess(locked.id, false, ACTOR, SOURCE);

    const list = await service.overview(ACTOR.userId);
    const nach = (id: string) => list.find((z) => z.id === id)?.state;

    expect(nach(invited.user.id)).toBe('without_access');
    expect(nach(active.id)).toBe('active');
    // GESPERRT SCHLÄGT ALLES: Ein deaktiviertes Konto ohne Passwort ist
    // gesperrt, nicht „eingeladen" — ein Link, den niemand einlösen kann,
    // ist keine Einladung.
    expect(nach(locked.id)).toBe('locked');
  });

  it('markiert die eigene Zeile', async () => {
    const list = await service.overview(ACTOR.userId);
    expect(list.find((z) => z.id === ACTOR.userId)?.self).toBe(true);
    expect(list.filter((z) => z.self)).toHaveLength(1);
  });
});

/**
 * [Review B5] Die Sperre auf das letzte Konto zaehlt nur ANMELDEFAEHIGE Konten.
 * Hier jede Kontoform einzeln, statt sie nur zu behaupten: Konto A ist voll
 * anmeldefaehig; Konto B hat die jeweilige Form. A den Zugang zu entziehen
 * darf genau dann gelingen, wenn B allein hineinkaeme.
 */
describe('Die Letztes-Konto-Sperre kennt jede Kontoform', () => {
  type Form = {
    name: string;
    loginCapable: boolean;
    data: Record<string, unknown>;
    passkey?: boolean;
  };
  const forms: Form[] = [
    { name: 'Passwort + E-Mail-Code', loginCapable: true, data: { passwordHash: 'h', loginCodeEnabled: true } },
    { name: 'Passwort + TOTP', loginCapable: true, data: { passwordHash: 'h', totpSecret: 'g' } },
    { name: 'nur Passkey, kein Passwort', loginCapable: true, data: {}, passkey: true },
    { name: 'Stummel ohne alles', loginCapable: false, data: {} },
    { name: 'Passwort ohne Faktor', loginCapable: false, data: { passwordHash: 'h' } },
    { name: 'nur vorlaeufiges TOTP', loginCapable: false, data: { passwordHash: 'h', totpSecretPending: 'g' } },
    { name: 'Passkey, aber deaktiviert', loginCapable: false, data: { deactivatedAt: new Date() }, passkey: true },
  ];

  it.each(forms)('$name', async (form) => {
    // Alle uebrigen Konten des Praefix aus dem Weg: Nur A und B sollen zaehlen.
    await prisma.user.updateMany({
      where: { username: { startsWith: PREFIX } },
      data: { deactivatedAt: new Date() },
    });
    const a = await account(`form-a-${randomUUID().slice(0, 6)}`);
    const identifier = `form-b-${randomUUID().slice(0, 6)}`;
    const b = await prisma.user.create({
      data: {
        name: `Test ${identifier}`,
        username: `${PREFIX}-${identifier}`,
        email: `${PREFIX}-${identifier}@example.com`,
        role: 'administrator',
        ...form.data,
      },
      select: { id: true },
    });
    if (form.passkey) {
      await prisma.passkeyCredential.create({
        data: {
          userId: b.id,
          credentialId: `cred-${identifier}`,
          publicKey: 'pk',
          counter: 0,
          label: 'Stick',
        },
      });
    }

    const attempt = service.setAccess(a.id, false, ACTOR, SOURCE);
    if (form.loginCapable) {
      await expect(attempt).resolves.toMatchObject({ state: 'locked' });
    } else {
      await expect(attempt).rejects.toBeInstanceOf(LastAccountError);
    }

    await prisma.passkeyCredential.deleteMany({ where: { userId: b.id } });
  });
});
