import { randomUUID } from 'crypto';
import { ConfigService } from '@nestjs/config';
import { AuditService } from '../audit/audit.service';
import { EmergencyService } from '../auth/emergency.service';
import { prisma } from '../test-support/company-provisioning';
import { FirstAccountService } from './first-account.service';
import { FirstAccountNotPossibleError } from './user.errors';

/**
 * Der Weg in eine LEERE Verwaltung. Ohne ihn war eine frisch ausgerollte
 * Instanz verschlossen: `emergency enrollment` verlangt ein bestehendes Konto,
 * und der Seed verweigert unter NODE_ENV=production den Dienst.
 */
jest.setTimeout(120_000);

const config = {
  get: (_n: string, preset?: string) => preset ?? 'https://verwaltung.example',
} as unknown as ConfigService;
const audit = new AuditService(prisma);
const emergency = new EmergencyService(prisma, config, audit, {} as never, {} as never);
const service = new FirstAccountService(prisma, audit, emergency);

/** Die Sperre haengt an der GESAMTEN Tabelle — der Test raeumt sie leer. */
async function emptyTable() {
  await prisma.emergencyEnrollment.deleteMany({});
  await prisma.auditLog.deleteMany({ where: { userId: { not: null } } });
  await prisma.passkeyCredential.deleteMany({});
  await prisma.user.deleteMany({});
}

describe('Das allererste Konto', () => {
  beforeEach(emptyTable);
  afterAll(emptyTable);

  it('legt in einer leeren Verwaltung ein Konto an und gibt einen Link', async () => {
    const email = `erst-${randomUUID().slice(0, 8)}@example.com`;
    const result = await service.create(email, 'Samuel Kuemmel', 'cli:test');

    expect(result.username).toBe(email);
    expect(result.url).toContain('http');
    expect(result.expiresAt.getTime()).toBeGreaterThan(Date.now());

    const account = await prisma.user.findUnique({ where: { email } });
    expect(account).not.toBeNull();
    // `inhaber` haelt im Nachweis fest, welches Konto am Anfang stand.
    expect(account!.role).toBe('owner');
    // Ohne zweiten Faktor waere das Konto nach dem Entfernen des Passkeys
    // eine Sackgasse — derselbe Fehler wie beim Eintragen (A.9).
    expect(account!.loginCodeEnabled).toBe(true);
    // Kein Passwort: Der Passkey ersetzt Passwort und zweiten Faktor zugleich.
    expect(account!.passwordHash).toBeNull();
  });

  it('der Link ist ein PASSKEY-Link — er kommt ohne Mailversand aus', async () => {
    const email = `erst-${randomUUID().slice(0, 8)}@example.com`;
    await service.create(email, 'Test', 'cli:test');

    const entry = await prisma.emergencyEnrollment.findFirst({
      orderBy: { expiresAt: 'desc' },
    });
    expect(entry?.kind).toBe('passkey');
  });

  /** DIE SPERRE — sonst waere das eine Hintertuer. */
  it('verweigert den Dienst, sobald EIN Konto existiert', async () => {
    const email = `erst-${randomUUID().slice(0, 8)}@example.com`;
    await service.create(email, 'Test', 'cli:test');

    await expect(
      service.create(`zweit-${randomUUID().slice(0, 8)}@example.com`, 'Zweiter', 'cli:test'),
    ).rejects.toBeInstanceOf(FirstAccountNotPossibleError);
  });

  it('zaehlt auch DEAKTIVIERTE Konten mit — dann ist entsperren der Weg', async () => {
    await prisma.user.create({
      data: {
        name: 'Gesperrt',
        username: `gesperrt-${randomUUID().slice(0, 8)}@example.com`,
        email: `gesperrt-${randomUUID().slice(0, 8)}@example.com`,
        role: 'administrator',
        deactivatedAt: new Date(),
      },
    });

    await expect(
      service.create(`neu-${randomUUID().slice(0, 8)}@example.com`, 'Neu', 'cli:test'),
    ).rejects.toBeInstanceOf(FirstAccountNotPossibleError);
  });

  it('lehnt unbrauchbare Eingaben ab, ohne etwas anzulegen', async () => {
    await expect(service.create('keine-adresse', 'Name', 'cli:test')).rejects.toBeInstanceOf(
      FirstAccountNotPossibleError,
    );
    await expect(
      service.create('gut@example.com', '   ', 'cli:test'),
    ).rejects.toBeInstanceOf(FirstAccountNotPossibleError);
    expect(await prisma.user.count()).toBe(0);
  });

  it('schreibt einen Nachweis OHNE die Adresse', async () => {
    const email = `erst-${randomUUID().slice(0, 8)}@example.com`;
    await service.create(email, 'Test', 'cli:test');

    const entry = await prisma.auditLog.findFirst({
      where: { actor: 'cli:test', objectType: 'User' },
      orderBy: { timestamp: 'desc' },
    });
    expect(entry).not.toBeNull();
    expect(JSON.stringify(entry!.afterValue)).not.toContain(email);
    expect(JSON.stringify(entry!.afterValue)).toContain('first-account');
  });
});
