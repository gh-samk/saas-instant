import { SetupStatusService } from './setup-status.service';
import { CONTRACT_PRESET } from '../coolify/coolify.config';
import type { SetupStatus } from './setup-status';

const FRESH = {
  id: 'i1',
  subdomain: 'musterverein',
  status: 'active',
  setupTokenEncrypted: 'iv.tag.chiffre',
  setupCompletedAt: null as Date | null,
  metrics: [] as unknown[],
};

function build(
  instance: Record<string, unknown> | null,
  state: SetupStatus | Error,
  contract: Record<string, unknown> = {},
) {
  const updateMany = jest.fn().mockResolvedValue({ count: 1 });
  const prisma = {
    instance: { findUnique: jest.fn().mockResolvedValue(instance), updateMany },
  };
  const fetch = jest.fn(async () => {
    if (state instanceof Error) throw state;
    return state;
  });
  const coolifyConfig = {
    contract: () => ({ ...CONTRACT_PRESET, baseDomain: 'example.com', ...contract }),
  };
  const service = new SetupStatusService(
    prisma as never,
    coolifyConfig as never,
    fetch as never,
  );
  return { service, updateMany, fetch };
}

describe('SetupStatusService — der Pfad ist im Instanz-Vertrag optional', () => {
  it('fragt nicht, wenn die Software keinen setup-status-Pfad deklariert', async () => {
    const { service, fetch, updateMany } = build(FRESH, 'configured', { setupStatusPath: null });
    await service.check('o1');
    expect(fetch).not.toHaveBeenCalled();
    expect(updateMany).not.toHaveBeenCalled();
  });
});

describe('SetupStatusService — beim Öffnen der Karte nachsehen', () => {
  it('vermerkt den Abschluss, wenn die Instanz „eingerichtet" meldet', async () => {
    const { service, updateMany, fetch } = build(FRESH, 'configured');

    await service.check('o1');

    expect(fetch).toHaveBeenCalledWith(
      'https://musterverein.example.com/api/setup/status',
      expect.any(Number),
    );
    // NUR VON NULL AUS: Ein vermerkter Tag wird nie verschoben.
    expect(updateMany).toHaveBeenCalledWith({
      where: { id: 'i1', setupCompletedAt: null },
      data: { setupCompletedAt: expect.any(Date) },
    });
  });

  it.each<SetupStatus>(['open', 'unknown'])(
    'schreibt nichts bei „%s" — ein Ausfall darf den Link nicht verbergen',
    async (state) => {
      const { service, updateMany } = build(FRESH, state);
      await service.check('o1');
      expect(updateMany).not.toHaveBeenCalled();
    },
  );

  it('fragt gar nicht, wenn der Abschluss schon vermerkt ist', async () => {
    const { service, fetch } = build(
      { ...FRESH, setupCompletedAt: new Date('2026-09-12') },
      'configured',
    );
    await service.check('o1');
    expect(fetch).not.toHaveBeenCalled();
  });

  it.each(['provisioning', 'stopped', 'archived'])(
    'fragt nicht bei einer Instanz im Zustand %s',
    async (status) => {
      const { service, fetch } = build({ ...FRESH, status }, 'configured');
      await service.check('o1');
      expect(fetch).not.toHaveBeenCalled();
    },
  );

  it('fragt nicht ohne Einrichtungsgeheimnis (Instanz von vor [K4])', async () => {
    const { service, fetch } = build(
      { ...FRESH, setupTokenEncrypted: null },
      'configured',
    );
    await service.check('o1');
    expect(fetch).not.toHaveBeenCalled();
  });

  it('tut nichts, wenn es keine Instanz gibt', async () => {
    const { service, fetch } = build(null, 'configured');
    await service.check('o1');
    expect(fetch).not.toHaveBeenCalled();
  });

  it('wirft nie — die Detailseite darf daran nicht scheitern', async () => {
    const { service, updateMany } = build(FRESH, new Error('Netz weg'));
    await expect(service.check('o1')).resolves.toBeUndefined();
    expect(updateMany).not.toHaveBeenCalled();
  });
});
