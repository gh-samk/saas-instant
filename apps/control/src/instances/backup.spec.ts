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
