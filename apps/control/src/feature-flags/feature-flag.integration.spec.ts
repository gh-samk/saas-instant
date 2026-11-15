import { AuditService, AUDIT_ACTION } from '../audit/audit.service';
import { prisma, disconnect } from '../test-support/company-provisioning';
import { FeatureFlagService } from './feature-flag.service';

/**
 * Funktionsschalter gegen eine ECHTE Datenbank: Stand und Audit-Eintrag
 * entstehen gemeinsam, und die öffentliche Antwort folgt dem Stand.
 */

jest.setTimeout(30_000);

const Identifier = `funktionsschalter-test-${Date.now()}`;
const Source = { ip: '203.0.113.7', userAgent: 'Jest-Integration' };

// Das Audit-Log verweist per Fremdschlüssel auf ein echtes Konto.
let Actor = { id: '', username: Identifier };

async function cleanUp(): Promise<void> {
  await prisma.featureFlag.deleteMany({ where: { key: 'feedback' } });
  await prisma.auditLog.deleteMany({ where: { actor: Identifier } });
}

describe('Funktionsschalter (Integration)', () => {
  const service = new FeatureFlagService(prisma, new AuditService(prisma));

  beforeAll(async () => {
    const account = await prisma.user.create({
      data: { name: 'Schalter-Test', username: Identifier, email: `${Identifier}@example.com` },
    });
    Actor = { id: account.id, username: Identifier };
  });
  beforeEach(cleanUp);
  afterAll(async () => {
    await cleanUp();
    await prisma.user.deleteMany({ where: { username: Identifier } });
    await disconnect();
  });

  it('gilt ohne Zeile als an und schreibt beim Umschalten Stand und Nachweis', async () => {
    expect(await service.publicState()).toEqual({ feedback: true });

    const from = await service.set('feedback', false, Actor, Source);
    expect(from.enabled).toBe(false);

    const row = await prisma.featureFlag.findUnique({
      where: { key: 'feedback' },
    });
    expect(row).toMatchObject({ enabled: false, changedById: Actor.id });

    const evidence = await prisma.auditLog.findMany({
      where: { actor: Actor.username, action: AUDIT_ACTION.featureFlagChanged },
    });
    expect(evidence).toHaveLength(1);
    expect(evidence[0]).toMatchObject({
      objectType: 'FeatureFlag',
      objectId: 'feedback',
      beforeValue: { enabled: true },
      afterValue: { enabled: false },
      ip: Source.ip,
    });

    // Umschalten leert den Zwischenspeicher sofort.
    expect(await service.publicState()).toEqual({ feedback: false });

    await service.set('feedback', true, Actor, Source);
    expect(await service.publicState()).toEqual({ feedback: true });
    expect(
      await prisma.auditLog.count({ where: { actor: Actor.username } }),
    ).toBe(2);
  });
});
