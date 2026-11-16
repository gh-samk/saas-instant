import 'reflect-metadata';
import { join } from 'node:path';
import { GUARDS_METADATA } from '@nestjs/common/constants';
import type { ConfigService } from '@nestjs/config';
import { AUDIT_ACTION, AuditService } from '../audit/audit.service';
import { WITHOUT_SECOND_FACTOR } from '../common/decorators/without-second-factor.decorator';
import { SecondFactorGuard } from '../common/guards/second-factor.guard';
import { RoleGuard } from '../common/guards/role.guard';
import { SessionGuard } from '../common/guards/session.guard';
import { loadManifest } from '../manifest/manifest.loader';
import type { ManifestService } from '../manifest/manifest.service';
import { PRICE_PRESETS, PricingConfigService } from '../invoices/pricing.config';
import { tierFor } from '../invoices/pricing.tier';
import { prisma, disconnect } from '../test-support/company-provisioning';
import { truncateAuditLog } from '../test-support/gobd-cleanup';
import type { PricesUpdateDto } from './dto/prices.dto';
import { PriceSettingsService, PricesInvalidError } from './price-settings.service';
import { PricesController } from './prices.controller';

/**
 * Preise als Admin gegen eine ECHTE Datenbank: Seed aus dem Manifest, Vorrang
 * der DB, Speichern mit Prüfung und Audit-Eintrag.
 */

jest.setTimeout(60_000);

const EXAMPLE = join(
  __dirname,
  '..', '..', '..', '..',
  'saas-instant.manifest.example.yaml',
);
const emptyEnvironment = { get: () => undefined } as unknown as ConfigService;
const Source = { ip: '203.0.113.7', userAgent: 'Jest-Integration' };
const Identifier = `preise-test-${Date.now()}`;
let Actor = { id: '', username: Identifier };

function manifestService(): ManifestService {
  return {
    billing: loadManifest(EXAMPLE).manifest.billing,
  } as unknown as ManifestService;
}

async function clear(): Promise<void> {
  await prisma.priceTier.deleteMany();
  await prisma.priceList.deleteMany();
  await truncateAuditLog(prisma);
}

function update(over: Partial<PricesUpdateDto> = {}): PricesUpdateDto {
  return {
    taxRatePercent: 19,
    paymentTermDays: 21,
    averageDays: 60,
    tiers: [
      { key: 'klein', label: 'Klein', maxPersons: 10, monthlyCent: 1000, halfYearlyCent: 5500, yearlyCent: 11000, setupCent: 5000 },
      { key: 'gross', label: 'Groß', maxPersons: null, monthlyCent: 3000, halfYearlyCent: 16500, yearlyCent: 33000, setupCent: 5000 },
    ],
    ...over,
  };
}

describe('Preise als Admin (Integration)', () => {
  let config: PricingConfigService;
  let service: PriceSettingsService;

  beforeAll(async () => {
    const account = await prisma.user.create({
      data: { name: 'Preise-Test', username: Identifier, email: `${Identifier}@example.com` },
    });
    Actor = { id: account.id, username: Identifier };
  });

  beforeEach(async () => {
    await clear();
    config = new PricingConfigService(emptyEnvironment, manifestService(), prisma);
    service = new PriceSettingsService(prisma, new AuditService(prisma), config);
  });

  afterAll(async () => {
    await clear();
    await prisma.user.deleteMany({ where: { username: Identifier } });
    await disconnect();
  });

  it('befüllt eine leere Datenbank einmalig aus dem Manifest', async () => {
    await config.onModuleInit();
    const billing = manifestService().billing;

    const rows = await prisma.priceTier.findMany({ orderBy: { sortOrder: 'asc' } });
    expect(rows.map((r) => r.key)).toEqual(billing.tiers.map((t) => t.key));
    expect(rows.map((r) => r.monthlyCent)).toEqual(
      billing.tiers.map((t) => t.monthlyCents ?? t.priceCents),
    );
    expect(config.read().tiers.map((t) => t.key)).toEqual(
      billing.tiers.map((t) => t.key),
    );
    expect(await prisma.priceList.count()).toBe(1);
  });

  it('fällt ohne Manifest auf die Vorgaben zurück und seedet damit', async () => {
    const bare = new PricingConfigService(emptyEnvironment, undefined, prisma);
    await bare.onModuleInit();
    expect(bare.read().tiers.map((t) => t.key)).toEqual(
      PRICE_PRESETS.tiers.map((t) => t.key),
    );
  });

  it('lässt der DB den Vorrang: ein Neustart überschreibt nichts', async () => {
    await config.onModuleInit();
    await service.update(update(), Actor, Source);

    // „Neustart" mit anderem Manifest: die DB gilt weiter.
    const restarted = new PricingConfigService(emptyEnvironment, manifestService(), prisma);
    await restarted.onModuleInit();
    expect(restarted.read().tiers.map((t) => t.key)).toEqual(['klein', 'gross']);
    expect(restarted.read().paymentDueDays).toBe(21);
    expect(restarted.read().averageDays).toBe(60);
    // Die Stufenzuordnung rechnet mit der DB-Tafel.
    expect(tierFor(11, restarted.read().tiers)?.key).toBe('gross');
  });

  it('speichert, schreibt price.updated mit Vorher/Nachher und aktualisiert read()', async () => {
    await config.onModuleInit();
    const result = await service.update(update(), Actor, Source);

    expect(result.paymentTermDays).toBe(21);
    expect(config.read().tiers).toHaveLength(2);

    const evidence = await prisma.auditLog.findMany({
      where: { actor: Identifier, action: AUDIT_ACTION.priceUpdated },
    });
    expect(evidence).toHaveLength(1);
    const e = evidence[0]!;
    expect(e).toMatchObject({ objectType: 'PriceList', ip: Source.ip, userId: Actor.id });
    const before = e.beforeValue as { tiers: { key: string }[]; paymentTermDays: number };
    const after = e.afterValue as { tiers: { key: string }[]; paymentTermDays: number };
    expect(before.tiers.length).toBe(manifestService().billing.tiers.length);
    expect(after.tiers.map((s) => s.key)).toEqual(['klein', 'gross', ...before.tiers.map((s) => s.key).filter((k) => k !== 'klein' && k !== 'gross')]);
    expect(after.paymentTermDays).toBe(21);
    // Keine Zugangsdaten im Nachweis.
    expect(JSON.stringify(e.afterValue)).not.toMatch(/password|totp/i);
  });

  it('archiviert fehlende und markierte Stufen, löscht aber nie', async () => {
    await config.onModuleInit();
    await service.update(update(), Actor, Source);

    const archivedRows = await prisma.priceTier.findMany({ where: { archivedAt: { not: null } } });
    expect(archivedRows.length).toBeGreaterThan(0);

    const keyOld = archivedRows[0]!.key;
    expect(config.isActive(keyOld)).toBe(false);
    // Altwerte bleiben nachschlagbar (Rechnungsposten, Organisationen).
    expect(config.tier(keyOld)?.key).toBe(keyOld);

    // Archivieren per Markierung
    const marked = update({
      tiers: [
        { ...update().tiers[0]!, archived: true },
        ...update().tiers.slice(1),
      ],
    });
    await service.update(marked, Actor, Source);
    expect(config.isActive('klein')).toBe(false);
    expect(config.tier('klein')?.label).toBe('Klein');
    expect(await prisma.priceTier.count({ where: { key: 'klein' } })).toBe(1);
  });

  it('weist eine unstimmige Liste ab: nichts gespeichert, kein Nachweis', async () => {
    await config.onModuleInit();
    const before = await prisma.priceTier.findMany({ orderBy: { key: 'asc' } });

    const gaps = update({
      tiers: [
        { key: 'a', label: 'A', maxPersons: 10, monthlyCent: 1, halfYearlyCent: 1, yearlyCent: 1, setupCent: 0 },
        { key: 'b', label: 'B', maxPersons: 5, monthlyCent: 1, halfYearlyCent: 1, yearlyCent: 1, setupCent: 0 },
      ],
    });
    await expect(service.update(gaps, Actor, Source)).rejects.toBeInstanceOf(PricesInvalidError);

    const duplicate = update({
      tiers: [
        { key: 'a', label: 'A', maxPersons: null, monthlyCent: 1, halfYearlyCent: 1, yearlyCent: 1, setupCent: 0 },
        { key: 'a', label: 'A2', maxPersons: null, monthlyCent: 1, halfYearlyCent: 1, yearlyCent: 1, setupCent: 0 },
      ],
    });
    await expect(service.update(duplicate, Actor, Source)).rejects.toBeInstanceOf(PricesInvalidError);

    expect(await prisma.priceTier.findMany({ orderBy: { key: 'asc' } })).toEqual(before);
    expect(
      await prisma.auditLog.count({ where: { action: AUDIT_ACTION.priceUpdated } }),
    ).toBe(0);
  });

  it('GET liefert auch ohne Start-Seed die Liste (einmalig befüllt)', async () => {
    const list = await service.get();
    expect(list.tiers.length).toBeGreaterThan(0);
    expect(list.tiers.every((s) => s.archived === false)).toBe(true);
  });

  it('Controller: speichern über die Route; Schreiben hängt am zweiten Faktor, Lesen nicht', async () => {
    const controller = new PricesController(service);
    await controller.get();
    const result = await controller.update(
      { id: Actor.id, username: Identifier } as never,
      update(),
      { ip: Source.ip, headers: { 'user-agent': Source.userAgent } } as never,
    );
    expect(result.tiers.map((s) => s.key).slice(0, 2)).toEqual(['klein', 'gross']);

    const guards = Reflect.getMetadata(GUARDS_METADATA, PricesController) as unknown[];
    // Dazwischen der RoleGuard: staff wird abgewiesen, ohne vorher nach einem Nachweis gefragt zu werden.
    expect(guards).toEqual([SessionGuard, RoleGuard, SecondFactorGuard]);
    const proto = PricesController.prototype as unknown as Record<string, object>;
    expect(Reflect.getMetadata(WITHOUT_SECOND_FACTOR, proto['get']!)).toBeTruthy();
    expect(Reflect.getMetadata(WITHOUT_SECOND_FACTOR, proto['update']!)).toBeUndefined();
  });
});
