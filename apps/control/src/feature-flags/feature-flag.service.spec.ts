import { AuditService, AUDIT_ACTION } from '../audit/audit.service';
import type { PrismaService } from '../prisma/prisma.service';
import {
  FeatureFlagService,
  FeatureFlagUnknownError,
} from './feature-flag.service';

interface Row {
  key: string;
  enabled: boolean;
  changedAt: Date;
  changedById: string | null;
}

/** Nur die Aufrufe, die der Dienst wirklich macht. */
function buildDouble() {
  const rows = new Map<string, Row>();
  const audit: Record<string, unknown>[] = [];
  let readAccesses = 0;
  const db = {
    featureFlag: {
      findMany: async () => {
        readAccesses++;
        return [...rows.values()];
      },
      findUnique: async ({ where }: { where: { key: string } }) =>
        rows.get(where.key) ?? null,
      upsert: async ({
        where,
        create,
        update,
      }: {
        where: { key: string };
        create: Omit<Row, 'changedAt'>;
        update: Partial<Row>;
      }) => {
        const old = rows.get(where.key);
        const newValue = old
          ? { ...old, ...update, changedAt: new Date() }
          : { ...create, changedAt: new Date() };
        rows.set(where.key, newValue as Row);
        return newValue;
      },
    },
    auditLog: {
      create: async ({ data }: { data: Record<string, unknown> }) => {
        audit.push(data);
        return data;
      },
    },
    $transaction: async <T>(fn: (tx: unknown) => Promise<T>) => fn(db),
  };
  const prisma = db as unknown as PrismaService;
  const service = new FeatureFlagService(prisma, new AuditService(prisma));
  return { service, rows, audit, readAccesses: () => readAccesses };
}

const User = { id: 'b1', username: 'betreiberin' };
const Source = { ip: '203.0.113.5', userAgent: 'Jest' };

describe('FunktionsschalterService', () => {
  it('liefert ohne Zeile die Vorgabe — Feedback ist in der Pilotphase an', async () => {
    const { service } = buildDouble();
    const [feedback] = await service.all();
    expect(feedback).toMatchObject({
      key: 'feedback',
      enabled: true,
      defaultValue: true,
      changedAt: null,
    });
    expect(await service.publicState()).toEqual({ feedback: true });
  });

  it('schaltet aus und protokolliert vorher/nachher mit Herkunft', async () => {
    const { service, audit } = buildDouble();
    const entry = await service.set('feedback', false, User, Source);

    expect(entry.enabled).toBe(false);
    expect(entry.changedAt).not.toBeNull();
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({
      userId: 'b1',
      actor: 'betreiberin',
      action: AUDIT_ACTION.featureFlagChanged,
      objectType: 'FeatureFlag',
      objectId: 'feedback',
      beforeValue: { enabled: true },
      afterValue: { enabled: false },
      ip: '203.0.113.5',
    });
  });

  it('schreibt nichts und protokolliert nichts, wenn sich nichts ändert', async () => {
    const { service, audit, rows } = buildDouble();
    // Vorgabe ist „an" — nochmals „an" setzen ist keine Änderung.
    const entry = await service.set('feedback', true, User, Source);
    expect(entry.enabled).toBe(true);
    expect(audit).toHaveLength(0);
    expect(rows.size).toBe(0);

    await service.set('feedback', false, User, Source);
    await service.set('feedback', false, User, Source);
    expect(audit).toHaveLength(1);
  });

  it('lehnt einen unbekannten Schlüssel ab und schreibt nichts', async () => {
    const { service, audit, rows } = buildDouble();
    await expect(
      service.set('gibtesnicht', true, User, Source),
    ).rejects.toBeInstanceOf(FeatureFlagUnknownError);
    // Auch nicht über die Prototypkette.
    await expect(
      service.set('toString', true, User, Source),
    ).rejects.toBeInstanceOf(FeatureFlagUnknownError);
    expect(audit).toHaveLength(0);
    expect(rows.size).toBe(0);
  });

  it('hält den öffentlichen Stand kurz vor und leert ihn beim Umschalten', async () => {
    const { service, readAccesses } = buildDouble();
    let clock = 1_000_000;
    service.now = () => clock;

    await service.publicState();
    await service.publicState();
    expect(readAccesses()).toBe(1);

    // Umschalten wirkt sofort, nicht erst nach Ablauf.
    await service.set('feedback', false, User, Source);
    expect(await service.publicState()).toEqual({ feedback: false });

    // Nach Ablauf wird neu gelesen.
    const before = readAccesses();
    clock += 31_000;
    await service.publicState();
    expect(readAccesses()).toBe(before + 1);
  });

  it('gibt öffentlich nur die Wahrheitswerte heraus', async () => {
    const { service } = buildDouble();
    await service.set('feedback', false, User, Source);
    expect(Object.keys(await service.publicState())).toEqual(['feedback']);
  });
});
