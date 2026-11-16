import { HttpException } from '@nestjs/common';
import type { AuditService } from '../audit/audit.service';
import { decryptField, encryptField, aadFor } from '../crypto/field-crypto';
import { keyring } from '../crypto/keyring';
import type { PrismaService } from '../prisma/prisma.service';
import { base32Decode, base32Encode, groupsOfEight } from './base32';
import { KDF_PARAMS, VaultService } from './vault.service';

type Row = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

/** Kleine In-Memory-Attrappe der Tresor-Tabelle (nur, was der Dienst benutzt). */
function fakePrisma() {
  const rows: Row[] = [];
  const vault = {
    count: async () => rows.length,
    findMany: async () => rows.map((r) => ({ ...r })),
    findUnique: async ({ where }: { where: { id: string } }) =>
      rows.find((r) => r.id === where.id) ?? null,
    create: async ({ data }: { data: Row }) => {
      rows.push({ ...data, createdAt: new Date() });
      return data;
    },
    createMany: async ({ data }: { data: Row[] }) => {
      for (const d of data) rows.push({ ...d, createdAt: new Date() });
    },
    delete: async ({ where }: { where: { id: string } }) => {
      rows.splice(rows.findIndex((r) => r.id === where.id), 1);
    },
    deleteMany: async ({ where }: { where: { kind: string } }) => {
      for (let i = rows.length - 1; i >= 0; i--) if (rows[i].kind === where.kind) rows.splice(i, 1);
    },
    groupBy: async () => {
      const kinds = [...new Set(rows.map((r) => r.kind))];
      return kinds.map((kind) => ({ kind, _count: { _all: rows.filter((r) => r.kind === kind).length } }));
    },
  };
  const prisma = {
    vault,
    $executeRaw: async () => 1,
    $transaction: async (arg: unknown) =>
      typeof arg === 'function' ? (arg as (tx: unknown) => unknown)(prisma) : Promise.all(arg as Promise<unknown>[]),
  };
  return { prisma: prisma as unknown as PrismaService, rows };
}

const ACTOR = { userId: null, actor: 'test' } as const;
const PASS = 'eine-lange-test-passphrase';
const CHEAP = { memoryKib: 8 * 1024, timeCost: 1, parallelism: 1 } as const;

function build() {
  const { prisma, rows } = fakePrisma();
  const entries: Row[] = [];
  const audit = { log: async (e: Row) => void entries.push(e) } as unknown as AuditService;
  const service = new VaultService(prisma, audit);
  service.useKdfParamsForTests(CHEAP);
  return { service, rows, entries };
}

async function statusOf(promise: Promise<unknown>): Promise<number> {
  try {
    await promise;
    return 200;
  } catch (e) {
    return (e as HttpException).getStatus();
  }
}

describe('VaultService', () => {
  afterEach(() => keyring.clear());

  it('Mindestparameter für die Produktion: argon2id m >= 64 MiB, t >= 3, p >= 1', () => {
    expect(KDF_PARAMS.memoryKib).toBeGreaterThanOrEqual(64 * 1024);
    expect(KDF_PARAMS.timeCost).toBeGreaterThanOrEqual(3);
    expect(KDF_PARAMS.parallelism).toBeGreaterThanOrEqual(1);
  });

  describe('Einrichten', () => {
    it('erzeugt zwei Einträge, entsperrt und gibt den Wiederherstellungsschlüssel einmalig in Achtergruppen zurück', async () => {
      const { service, rows, entries } = build();
      expect(await service.state()).toBe('uninitialized');

      const { recoveryKey } = await service.initialize(PASS, ACTOR);

      expect(recoveryKey).toMatch(/^([A-Z2-7]{8}-){6}[A-Z2-7]{4}$/);
      expect(base32Decode(recoveryKey)?.length).toBe(32);
      expect(rows.map((r) => r.kind).sort()).toEqual(['passphrase', 'recovery']);
      expect(rows[0]).toMatchObject({ kdf: 'argon2id', kdfMemoryKib: CHEAP.memoryKib });
      expect(await service.state()).toBe('unlocked');
      expect(service.isUnlocked()).toBe(true);
      expect(entries.map((e) => e.action)).toEqual(['vault.initialized']);
    });

    it('speichert weder DEK noch Passphrase noch Wiederherstellungsschlüssel im Klartext', async () => {
      const { service, rows } = build();
      const { recoveryKey } = await service.initialize(PASS, ACTOR);
      const dump = JSON.stringify(rows.map((r) => Object.fromEntries(Object.entries(r).map(([k, v]) => [k, Buffer.isBuffer(v) ? v.toString('hex') : v]))));
      expect(dump).not.toContain(PASS);
      expect(dump).not.toContain(recoveryKey.replace(/-/g, ''));
    });

    it('lehnt eine zu kurze Passphrase ab und richtet nichts ein', async () => {
      const { service, rows } = build();
      expect(await statusOf(service.initialize('kurz', ACTOR))).toBe(400);
      expect(rows).toHaveLength(0);
    });

    it('ein zweites Einrichten scheitert (409) und ändert nichts', async () => {
      const { service, rows } = build();
      await service.initialize(PASS, ACTOR);
      expect(await statusOf(service.initialize('noch-eine-lange-passphrase', ACTOR))).toBe(409);
      expect(rows).toHaveLength(2);
    });
  });

  describe('Entsperren', () => {
    it('Passphrase: nach lock() gesperrt, nach unlock() derselbe Schlüssel (Daten bleiben lesbar)', async () => {
      const { service } = build();
      await service.initialize(PASS, ACTOR);
      const aad = aadFor('Company', 'name', 'id');
      const stored = encryptField('Muster', aad);

      await service.lock();
      expect(service.isUnlocked()).toBe(false);
      expect(await service.state()).toBe('locked');
      expect(() => decryptField(stored, aad)).toThrow();

      await service.unlock(PASS, ACTOR);
      expect(service.isUnlocked()).toBe(true);
      expect(decryptField(stored, aad)).toBe('Muster');
    });

    it('Wiederherstellungsschlüssel (mit Trennzeichen, Kleinschreibung, Leerzeichen) entsperrt ebenfalls', async () => {
      const { service } = build();
      const { recoveryKey } = await service.initialize(PASS, ACTOR);
      const aad = aadFor('Note', 'text', 'n');
      const stored = encryptField('Notiz', aad);
      await service.lock();

      await service.unlock(` ${recoveryKey.toLowerCase().replace(/-/g, ' ')} `, ACTOR);
      expect(decryptField(stored, aad)).toBe('Notiz');
    });

    it('falsches Geheimnis: 401, bleibt gesperrt, Audit ohne Geheimnis', async () => {
      const { service, entries } = build();
      await service.initialize(PASS, ACTOR);
      await service.lock();
      entries.length = 0;

      expect(await statusOf(service.unlock('falsche-passphrase-123', ACTOR))).toBe(401);
      expect(service.isUnlocked()).toBe(false);
      expect(entries).toHaveLength(1);
      expect(entries[0].action).toBe('vault.unlock.failure');
      expect(JSON.stringify(entries)).not.toContain('falsche-passphrase');
    });

    it('ein falscher, aber wohlgeformter Wiederherstellungsschlüssel scheitert ebenfalls', async () => {
      const { service } = build();
      await service.initialize(PASS, ACTOR);
      await service.lock();
      const wrong = groupsOfEight(base32Encode(Buffer.alloc(32, 7)));
      expect(await statusOf(service.unlock(wrong, ACTOR))).toBe(401);
    });

    it('Rate-Limit: nach fünf Fehlversuchen 429, auch mit richtigem Geheimnis; andere Quelle unberührt', async () => {
      const { service } = build();
      await service.initialize(PASS, ACTOR);
      await service.lock();
      for (let i = 0; i < 5; i++) {
        expect(await statusOf(service.unlock('falsch-falsch-falsch', ACTOR, 'ip-a'))).toBe(401);
      }
      expect(await statusOf(service.unlock(PASS, ACTOR, 'ip-a'))).toBe(429);
      expect(service.isUnlocked()).toBe(false);
      expect(await statusOf(service.unlock(PASS, ACTOR, 'ip-b'))).toBe(200);
    });

    it('Ereignis: onUnlocked läuft sofort bei entsperrtem, sonst beim Entsperren', async () => {
      const { service } = build();
      await service.initialize(PASS, ACTOR);
      await service.lock();
      const calls: string[] = [];
      service.onUnlocked(() => calls.push('einmal'));
      service.onEveryUnlock(() => calls.push('jedes'));
      expect(calls).toEqual([]);
      await service.unlock(PASS, ACTOR);
      expect(calls).toEqual(['einmal', 'jedes']);
    });

    it('ein Wartungslauf (hold) hält isReady() zurück, bis er fertig ist', async () => {
      const { service } = build();
      await service.initialize(PASS, ACTOR);
      let done!: () => void;
      service.hold(new Promise<void>((resolve) => (done = resolve)));
      expect(service.isUnlocked()).toBe(true);
      expect(service.isReady()).toBe(false);
      done();
      await service.settled();
      expect(service.isReady()).toBe(true);
    });
  });

  describe('Umpacken (DEK bleibt)', () => {
    it('weitere Passphrase: entsperrt denselben Schlüssel', async () => {
      const { service } = build();
      await service.initialize(PASS, ACTOR);
      const aad = aadFor('Company', 'name', 'id');
      const stored = encryptField('Muster', aad);
      await service.addPassphrase('zweite-admin-passphrase', 'Zweite Person', null, ACTOR);
      await service.lock();
      await service.unlock('zweite-admin-passphrase', ACTOR);
      expect(decryptField(stored, aad)).toBe('Muster');
    });

    it('addPassphrase verlangt entsperrten Tresor (423)', async () => {
      const { service } = build();
      await service.initialize(PASS, ACTOR);
      await service.lock();
      expect(await statusOf(service.addPassphrase('zweite-admin-passphrase', 'x', null, ACTOR))).toBe(423);
    });

    it('Passphrase ändern: alte funktioniert nicht mehr, neue entsperrt, Daten bleiben lesbar', async () => {
      const { service, rows } = build();
      await service.initialize(PASS, ACTOR);
      const aad = aadFor('Company', 'name', 'id');
      const stored = encryptField('Muster', aad);
      const entry = rows.find((r) => r.kind === 'passphrase')!;

      await service.changePassphrase(entry.id, PASS, 'neue-lange-passphrase-1', ACTOR);
      expect(rows.filter((r) => r.kind === 'passphrase')).toHaveLength(1);
      await service.lock();
      expect(await statusOf(service.unlock(PASS, ACTOR))).toBe(401);
      await service.unlock('neue-lange-passphrase-1', ACTOR);
      expect(decryptField(stored, aad)).toBe('Muster');
    });

    it('Passphrase ändern verlangt die bisherige Passphrase', async () => {
      const { service, rows } = build();
      await service.initialize(PASS, ACTOR);
      const entry = rows.find((r) => r.kind === 'passphrase')!;
      expect(
        await statusOf(service.changePassphrase(entry.id, 'nicht-die-alte-passphrase', 'neue-lange-passphrase-1', ACTOR)),
      ).toBe(401);
      expect(rows.find((r) => r.id === entry.id)).toBeDefined();
    });

    it('Wiederherstellungsschlüssel neu erzeugen: der alte wird ungültig, der neue entsperrt', async () => {
      const { service, rows, entries } = build();
      const { recoveryKey: old } = await service.initialize(PASS, ACTOR);
      const aad = aadFor('Company', 'name', 'id');
      const stored = encryptField('Muster', aad);

      const { recoveryKey: fresh } = await service.regenerateRecovery(ACTOR);
      expect(fresh).not.toBe(old);
      expect(rows.filter((r) => r.kind === 'recovery')).toHaveLength(1);
      await service.lock();
      expect(await statusOf(service.unlock(old, ACTOR, 'a'))).toBe(401);
      await service.unlock(fresh, ACTOR, 'b');
      expect(decryptField(stored, aad)).toBe('Muster');
      expect(entries.map((e) => e.action)).toContain('vault.recovery.regenerated');
      expect(JSON.stringify(entries)).not.toContain(fresh);
    });

    it('verschiedene Einträge haben verschiedene Salze und IVs', async () => {
      const { service, rows } = build();
      await service.initialize(PASS, ACTOR);
      await service.addPassphrase('zweite-admin-passphrase', 'x', null, ACTOR);
      const salts = new Set(rows.map((r) => Buffer.from(r.salt).toString('hex')));
      expect(salts.size).toBe(rows.length);
    });
  });

  it('status() zählt Einträge je Art', async () => {
    const { service } = build();
    await service.initialize(PASS, ACTOR);
    await service.addPassphrase('zweite-admin-passphrase', 'x', null, ACTOR);
    expect(await service.status()).toEqual({ state: 'unlocked', passphrases: 2, hasRecovery: true });
  });
});
