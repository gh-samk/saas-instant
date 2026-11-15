import { AuditService } from '../audit/audit.service';
import { hashToken } from '../common/one-time-token';
import {
  IntakeAccessService,
  ACCESS_VALID_MS,
} from './intake-access.service';
import {
  createCompany,
  newPrefix,
  prisma,
  cleanUp,
  disconnect,
} from '../test-support/company-provisioning';

/**
 * Der Einmal-Zugang gegen eine ECHTE Datenbank.
 *
 * DER KERN ist die Nebenläufigkeit: Zwei gleichzeitige Einlösungen dürfen
 * nicht beide durchgehen. Dafür gibt es keinen Datenbank-Zwang — die
 * Invariante hängt allein am bedingten `updateMany` im Dienst, und in
 * JavaScript kann ein Rennen gar nicht entstehen. Eine Attrappe würde hier
 * also genau das nicht prüfen, worauf es ankommt.
 */

jest.setTimeout(60_000);

const Prefix = newPrefix('intake-access');
const audit = new AuditService(prisma);
const service = new IntakeAccessService(prisma, audit);

afterAll(async () => {
  await cleanUp(Prefix);
  await disconnect();
});

describe('Einen Zugang erzeugen', () => {
  it('speichert NUR den Hash, niemals den Klartext', async () => {
    const org = await createCompany(Prefix);
    const { token, accessId } = await service.create(org.id, 'test', null);

    const row = await prisma.intakeAccess.findUniqueOrThrow({
      where: { id: accessId },
    });
    expect(row.tokenHash).toBe(hashToken(token));
    // Der Klartext steht in KEINEM Feld der Zeile.
    expect(JSON.stringify(row)).not.toContain(token);
  });

  it('schreibt den Token auch nicht ins Audit-Log', async () => {
    const org = await createCompany(Prefix);
    const { token } = await service.create(org.id, 'test', null);

    const entries = await prisma.auditLog.findMany({
      where: { action: 'intake.access.generated' },
      orderBy: { timestamp: 'desc' },
      take: 5,
    });
    for (const entry of entries) {
      expect(JSON.stringify(entry)).not.toContain(token);
    }
  });

  it('zieht einen offenen Zugang zurueck, statt zwei gueltige zu haben', async () => {
    const org = await createCompany(Prefix);
    const first = await service.create(org.id, 'test', null);
    const second = await service.create(org.id, 'test', null);

    expect(await service.check(first.token)).toBeNull();
    expect(await service.check(second.token)).not.toBeNull();

    // ZURUECKGEZOGEN ist nicht EINGELOEST — der Unterschied bleibt lesbar.
    const old = await prisma.intakeAccess.findUniqueOrThrow({
      where: { id: first.accessId },
    });
    expect(old.revokedAt).not.toBeNull();
    expect(old.redeemedAt).toBeNull();
  });
});

describe('Einen Zugang pruefen', () => {
  it('nennt die Organisation, aber nur ihren Namen', async () => {
    const org = await createCompany(Prefix, {
      contactEmail: 'geheim@example.com',
      iban: 'DE02120300000000202051',
    });
    const { token } = await service.create(org.id, 'test', null);

    const checked = await service.check(token);
    expect(checked?.companyName).toBe(org.name);
    // Wer einen fremden Token abfaengt, soll nichts LESEN koennen, was er
    // nicht schon weiss.
    expect(JSON.stringify(checked)).not.toContain('geheim@example.com');
    expect(JSON.stringify(checked)).not.toContain('DE0212030000');
  });

  it('weist unbekannt, abgelaufen, eingeloest und zurueckgezogen gleich ab', async () => {
    const org = await createCompany(Prefix);

    // 1. unbekannt
    expect(await service.check('gibtesnicht')).toBeNull();

    // 2. abgelaufen
    const old = await service.create(
      org.id,
      'test',
      null,
      new Date(Date.now() - ACCESS_VALID_MS - 1000),
    );
    expect(await service.check(old.token)).toBeNull();

    // 3. eingeloest
    const used = await service.create(org.id, 'test', null);
    await service.resolveA(prisma, used.accessId);
    expect(await service.check(used.token)).toBeNull();

    // 4. zurueckgezogen — durch den naechsten erzeuge()-Aufruf
    const replaced = await service.create(org.id, 'test', null);
    await service.create(org.id, 'test', null);
    expect(await service.check(replaced.token)).toBeNull();
  });
});

describe('Einen Zugang einloesen', () => {
  /**
   * DER EIGENTLICHE GRUND FUER DIESE DATEI. Zwei gleichzeitige Absenden
   * duerfen nicht beide durchgehen — sonst entstuenden zwei Datensaetze aus
   * einem Formular, oder zwei Mandatsreferenzen fuer ein Mandat.
   */
  it('laesst bei ZWEI GLEICHZEITIGEN Aufrufen genau einen durch', async () => {
    const org = await createCompany(Prefix);
    const { accessId } = await service.create(org.id, 'test', null);

    const [a, b] = await Promise.all([
      service.resolveA(prisma, accessId),
      service.resolveA(prisma, accessId),
    ]);
    expect([a, b].filter(Boolean)).toHaveLength(1);
  });

  it('meldet einen zweiten Versuch als nicht eingeloest', async () => {
    const org = await createCompany(Prefix);
    const { accessId } = await service.create(org.id, 'test', null);
    expect(await service.resolveA(prisma, accessId)).toBe(true);
    expect(await service.resolveA(prisma, accessId)).toBe(false);
  });
});

describe('Der Zustand fuer die Verwaltung', () => {
  it('meldet einen fehlenden Zugang als nicht vorhanden', async () => {
    const org = await createCompany(Prefix);
    expect((await service.state(org.id)).present).toBe(false);
  });

  it('nennt Ablauf, Einloesung und Versandzaehler — aber keinen Token', async () => {
    const org = await createCompany(Prefix);
    const { token, accessId } = await service.create(org.id, 'test', null);
    await service.noteSend(accessId);
    await service.noteSend(accessId);

    const state = await service.state(org.id);
    expect(state.present).toBe(true);
    expect(state.sendCount).toBe(2);
    expect(state.lastSentAt).not.toBeNull();
    expect(state.redeemedAt).toBeNull();
    expect(state.expired).toBe(false);
    // Den Klartext gibt es genau einmal, beim Erzeugen.
    expect(JSON.stringify(state)).not.toContain(token);
  });

  it('erkennt einen abgelaufenen Zugang als abgelaufen', async () => {
    const org = await createCompany(Prefix);
    await service.create(
      org.id,
      'test',
      null,
      new Date(Date.now() - ACCESS_VALID_MS - 1000),
    );
    expect((await service.state(org.id)).expired).toBe(true);
  });
});
