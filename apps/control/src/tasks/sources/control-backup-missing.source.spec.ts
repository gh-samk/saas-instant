import type { PrismaService } from '../../prisma/prisma.service';
import { PRICE_PRESETS } from '../../invoices/pricing.config';
import type { TasksContext } from '../tasks.types';
import { controlBackupMissing } from './control-backup-missing.source';

const NOW = new Date('2026-09-10T08:00:00Z');

function setup(opts: { target: boolean; last: Partial<Record<'control' | 'invoices', string>> }) {
  const findFirst = jest.fn(
    async (args: { where: { afterValue: { equals: 'control' | 'invoices' } } }) => {
      const at = opts.last[args.where.afterValue.equals];
      return at === undefined ? null : { timestamp: new Date(at) };
    },
  );
  const prisma = {
    backupTarget: { findUnique: jest.fn(async () => (opts.target ? { id: 'singleton' } : null)) },
    auditLog: { findFirst },
  } as unknown as PrismaService;
  const context: TasksContext = {
    prisma,
    todayDay: '2026-09-10',
    now: NOW,
    since: '2026-09-03',
    limit: 25,
    priceTable: PRICE_PRESETS,
    outbox: [],
  };
  return { context, findFirst };
}

describe('Aufgabenquelle control_backup_missing', () => {
  it('ohne eingerichtetes Ziel keine Aufgabe und keine Audit-Abfrage', async () => {
    const { context, findFirst } = setup({ target: false, last: {} });
    expect(await controlBackupMissing.collect(context)).toEqual({ tasks: [], total: 0 });
    expect(findFirst).not.toHaveBeenCalled();
  });

  it('frische Meldungen beider Arten: keine Aufgabe', async () => {
    const { context } = setup({
      target: true,
      last: { control: '2026-09-09T02:00:00Z', invoices: '2026-09-08T02:00:00Z' },
    });
    expect((await controlBackupMissing.collect(context)).total).toBe(0);
  });

  it('fehlende Meldung: eine hohe Aufgabe, die das Fehlende nennt', async () => {
    const { context } = setup({ target: true, last: { control: '2026-09-09T02:00:00Z' } });
    const { tasks, total } = await controlBackupMissing.collect(context);
    expect(total).toBe(1);
    expect(tasks[0]).toMatchObject({
      kind: 'control_backup_missing',
      urgency: 'high',
      title: 'Sicherung der Verwaltung überfällig',
      action: { target: '/settings' },
    });
    expect(tasks[0]?.reason).toContain('Rechnungsarchiv: noch nie gemeldet');
  });

  it('Meldung älter als drei Tage: Aufgabe, fällig am vierten Tag nach der Meldung', async () => {
    const { context } = setup({
      target: true,
      last: { control: '2026-09-05T02:00:00Z', invoices: '2026-09-09T02:00:00Z' },
    });
    const { tasks } = await controlBackupMissing.collect(context);
    expect(tasks).toHaveLength(1);
    expect(tasks[0]?.dueAt).toBe('2026-09-08');
    expect(tasks[0]?.reason).toContain('Verwaltungs-Datenbank: zuletzt am 2026-09-05');
    expect(tasks[0]?.reason).not.toContain('Rechnungsarchiv');
  });
});
