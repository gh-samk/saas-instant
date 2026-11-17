import { validate } from 'class-validator';
import { plainToInstance } from 'class-transformer';
import { datePlusDays, today } from '@saas-instant/shared';
import { BackupReportDto } from './dto/instance.dto';
import { BackupDateInFutureError } from './instance.errors';
import { BackupService } from './backup.service';
import { toBackup } from './instance.response';

async function errorFields(raw: Record<string, unknown>): Promise<string[]> {
  const dto = plainToInstance(BackupReportDto, raw);
  const error = await validate(dto);
  return error.map((f) => f.property).sort();
}

const VALID = {
  subdomain: 'musterverein',
  date: today(),
  sizeBytes: 2_400_000_000,
};

describe('BackupReportDto — kein Datum in der Zukunft ([K3])', () => {
  it('nimmt eine Meldung für heute an', async () => {
    expect(await errorFields(VALID)).toEqual([]);
  });

  it('nimmt eine Meldung für gestern an', async () => {
    expect(
      await errorFields({ ...VALID, date: datePlusDays(today(), -1) }),
    ).toEqual([]);
  });

  it('lässt einen Tag Toleranz für Zeitzone und Laufzeit durch', async () => {
    expect(
      await errorFields({ ...VALID, date: datePlusDays(today(), 1) }),
    ).toEqual([]);
  });

  it('WEIST `9999-12-31` ab — der Fall, der den Alarm dauerhaft abschaltete', async () => {
    expect(await errorFields({ ...VALID, date: '9999-12-31' })).toEqual(['date']);
  });

  it('weist auch ein Datum in der nahen Zukunft ab', async () => {
    expect(
      await errorFields({ ...VALID, date: datePlusDays(today(), 3) }),
    ).toEqual(['date']);
  });

  it('weist weiterhin unmögliche und formwidrige Daten ab', async () => {
    expect(await errorFields({ ...VALID, date: '2027-02-30' })).toEqual(['date']);
    expect(await errorFields({ ...VALID, date: 'gestern' })).toEqual(['date']);
  });

  it('begrenzt die Grösse nach oben', async () => {
    expect(
      await errorFields({ ...VALID, sizeBytes: Number.MAX_SAFE_INTEGER }),
    ).toEqual(['sizeBytes']);
  });
});

describe('BackupService — zweite Verteidigungslinie', () => {
  function build() {
    const prisma = {
      instance: { findUnique: jest.fn().mockResolvedValue({ id: 'i1' }) },
      backup: { upsert: jest.fn().mockResolvedValue({}) },
    };
    const audit = { log: jest.fn().mockResolvedValue(undefined) };
    return {
      service: new BackupService(prisma as never, audit as never),
      prisma,
    };
  }

  it('weist ein Zukunftsdatum auch dann ab, wenn die Pipe umgangen wird', async () => {
    const { service, prisma } = build();

    await expect(
      service.report({ ...VALID, date: '9999-12-31' }, null),
    ).rejects.toBeInstanceOf(BackupDateInFutureError);

    // Nichts geschrieben — und weil es keinen Löschpfad gibt, ist genau das
    // der Punkt.
    expect(prisma.backup.upsert).not.toHaveBeenCalled();
  });

  it('nimmt eine reguläre Meldung an', async () => {
    const { service, prisma } = build();
    await expect(service.report(VALID, '203.0.113.7')).resolves.toEqual({ ok: true });
    expect(prisma.backup.upsert).toHaveBeenCalledTimes(1);
  });
});

describe('Die Folge, um die es geht', () => {
  it('bleibt „ausgeblieben", solange nur alte Sicherungen vorliegen', () => {
    const old = [
      {
        id: 's1',
        instanceId: 'i1',
        date: new Date('2026-08-01T00:00:00.000Z'),
        sizeBytes: BigInt(1),
        createdAt: new Date(),
      },
    ];
    expect(toBackup(old as never, '2026-08-31').missing).toBe(true);
  });

  it('würde von einer Zukunftszeile dauerhaft abgeschaltet — deshalb kommt sie nicht rein', () => {
    // Die Gegenprobe zur Regel: Wäre die Zeile erst einmal da, wäre der Alarm
    // aus, und es gäbe keinen Weg, sie wieder loszuwerden.
    const future = [
      {
        id: 's1',
        instanceId: 'i1',
        date: new Date('9999-12-31T00:00:00.000Z'),
        sizeBytes: BigInt(1),
        createdAt: new Date(),
      },
    ];
    expect(toBackup(future as never, '2026-08-31').missing).toBe(false);
  });
});

describe('BackupReportDto — kind, objectKey, sha256 (abwärtskompatibel)', () => {
  const HASH = 'a'.repeat(64);

  it('nimmt die alte Meldung ohne neue Felder an', async () => {
    expect(await errorFields(VALID)).toEqual([]);
  });

  it('nimmt Instanz-Meldung mit objectKey und sha256 an', async () => {
    expect(
      await errorFields({
        ...VALID,
        kind: 'instance',
        objectKey: 'p/instances/musterverein/2026-11-14T023000Z.dump.age',
        sha256: HASH,
      }),
    ).toEqual([]);
  });

  it('verlangt die Subdomain nur für Instanz-Sicherungen', async () => {
    const { subdomain: _s, ...ohne } = VALID;
    expect(await errorFields(ohne)).toEqual(['subdomain']);
    expect(await errorFields({ ...ohne, kind: 'instance' })).toEqual(['subdomain']);
    expect(await errorFields({ ...ohne, kind: 'control' })).toEqual([]);
    expect(await errorFields({ ...ohne, kind: 'invoices' })).toEqual([]);
  });

  it('lehnt unbekannte Art, unzulässigen Schlüssel und falsche Prüfsumme ab', async () => {
    expect(await errorFields({ ...VALID, kind: 'sonst' })).toEqual(['kind']);
    expect(await errorFields({ ...VALID, objectKey: '../etc/passwd' })).toEqual(['objectKey']);
    expect(await errorFields({ ...VALID, objectKey: 'a b' })).toEqual(['objectKey']);
    expect(await errorFields({ ...VALID, sha256: 'xyz' })).toEqual(['sha256']);
    expect(await errorFields({ ...VALID, uploadsSha256: 'xyz' })).toEqual(['uploadsSha256']);
    expect(await errorFields({ ...VALID, uploadsSha256: HASH })).toEqual([]);
  });
});

describe('BackupService — kind/objectKey/sha256', () => {
  function build() {
    const prisma = {
      instance: { findUnique: jest.fn().mockResolvedValue({ id: 'i1' }) },
      backup: { upsert: jest.fn().mockResolvedValue({}) },
    };
    const audit = { log: jest.fn().mockResolvedValue(undefined) };
    return { service: new BackupService(prisma as never, audit as never), prisma, audit };
  }

  it('schreibt objectKey und sha256 an die Zeile und setzt die Prüfung zurück', async () => {
    const { service, prisma } = build();
    await service.report(
      { ...VALID, kind: 'instance', objectKey: 'p/k.dump.age', sha256: 'A'.repeat(64) },
      null,
    );
    const call = prisma.backup.upsert.mock.calls[0][0];
    expect(call.create).toMatchObject({ objectKey: 'p/k.dump.age', sha256: 'a'.repeat(64) });
    expect(call.update).toMatchObject({ objectKey: 'p/k.dump.age', verifiedAt: null });
  });

  it('speichert uploadsSha256 klein geschrieben; ohne sie wird eine alte beim neuen Satz geleert', async () => {
    const { service, prisma } = build();
    await service.report(
      { ...VALID, kind: 'instance', objectKey: 'p/k.dump.age', sha256: 'a'.repeat(64), uploadsSha256: 'D'.repeat(64) },
      null,
    );
    expect(prisma.backup.upsert.mock.calls[0][0].update).toMatchObject({ uploadsSha256: 'd'.repeat(64) });
    await service.report({ ...VALID, kind: 'instance', objectKey: 'p/k2.dump.age', sha256: 'a'.repeat(64) }, null);
    expect(prisma.backup.upsert.mock.calls[1][0].update).toMatchObject({ uploadsSha256: null });
  });

  it('nimmt null als „nicht gemeldet“ statt mit 500 zu scheitern (sonst Giftmeldung im Agenten)', async () => {
    const { service, prisma } = build();
    await expect(
      service.report(
        { ...VALID, kind: 'instance', objectKey: 'p/k.dump.age', sha256: null, uploadsSha256: null } as never,
        null,
      ),
    ).resolves.toEqual({ ok: true });
    expect(prisma.backup.upsert.mock.calls[0][0].update).toMatchObject({ uploadsSha256: null });
    // objectKey null darf einen gespeicherten Schlüssel nicht löschen und die Prüfung nicht zurücksetzen.
    await service.report({ ...VALID, kind: 'instance', objectKey: null } as never, null);
    const update = prisma.backup.upsert.mock.calls[1][0].update;
    expect(update).not.toHaveProperty('objectKey');
    expect(update).not.toHaveProperty('verifiedAt');
  });

  it('lässt ohne neue Felder objectKey und Prüfung unangetastet (abwärtskompatibel)', async () => {
    const { service, prisma } = build();
    await service.report(VALID, null);
    const call = prisma.backup.upsert.mock.calls[0][0];
    expect(Object.keys(call.update)).toEqual(['sizeBytes']);
  });

  it('control und invoices hängen an keiner Instanz: nur Nachweis im Audit-Log', async () => {
    const { service, prisma, audit } = build();
    const { subdomain: _s, ...ohne } = VALID;
    await service.report({ ...ohne, kind: 'control', objectKey: 'p/control/x.dump.age' }, '1.2.3.4');
    expect(prisma.instance.findUnique).not.toHaveBeenCalled();
    expect(prisma.backup.upsert).not.toHaveBeenCalled();
    expect(audit.log).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'backup.reported',
        afterValue: expect.objectContaining({ kind: 'control', objectKey: 'p/control/x.dump.age' }),
      }),
    );
  });
});

describe('BackupReportDto — Bestätigung der Löschung (`purged`)', () => {
  it('nimmt `purged` mit Subdomain an', async () => {
    expect(await errorFields({ ...VALID, kind: 'purged', sizeBytes: 0 })).toEqual([]);
  });

  it('verlangt auch bei `purged` die Subdomain', async () => {
    expect(await errorFields({ kind: 'purged', date: today(), sizeBytes: 0 })).toEqual(['subdomain']);
  });

  it('weist eine unbekannte Art ab', async () => {
    expect(await errorFields({ ...VALID, kind: 'geloescht' })).toEqual(['kind']);
  });
});
