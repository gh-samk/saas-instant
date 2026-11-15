import type { TasksContext } from '../tasks.types';
import type { OutboxSituation } from '../../outbox/outbox.types';
import { outboxDisrupted } from './outbox-disrupted.source';

const Today = '2026-09-12';

function contextWith(outbox: OutboxSituation[]): TasksContext {
  return {
    // Die Quelle liest keine Datenbank und keine Preistafel.
    prisma: {} as never,
    todayDay: Today,
    now: new Date(`${Today}T09:00:00.000Z`),
    since: '2026-09-05',
    limit: 25,
    priceTable: {} as never,
    outbox,
  };
}

const Quiet: OutboxSituation = {
  role: 'admin',
  state: 'in_ordnung',
  checkedAt: `${Today}T08:00:00.000Z`,
  disruptedSince: null,
  errorClass: null,
  detectedBy: null,
};

describe('Aufgabe „Gestörter Postausgang"', () => {
  it('bleibt still, solange alles in Ordnung oder noch ungeprüft ist', async () => {
    const result = await outboxDisrupted.collect(
      contextWith([Quiet, { ...Quiet, role: 'instances', state: 'ungeprueft', checkedAt: null }]),
    );
    expect(result).toEqual({ tasks: [], total: 0 });
  });

  it('meldet ein falsches Passwort dringend, ohne Organisation und mit dem Prüfknopf', async () => {
    const { tasks } = await outboxDisrupted.collect(
      contextWith([
        {
          ...Quiet,
          state: 'gestoert',
          disruptedSince: '2026-09-10T07:12:00.000Z',
          errorClass: 'login',
          detectedBy: 'probe',
        },
      ]),
    );

    expect(tasks).toHaveLength(1);
    const [task] = tasks;
    expect(task).toMatchObject({
      kind: 'outbox_disrupted',
      dueAt: '2026-09-10',
      urgency: 'high',
      title: 'Der Postausgang der Verwaltung ist gestört',
      action: { kind: 'outbox_check', target: '' },
    });
    expect(task.company).toBeUndefined();
    expect(task.reason).toMatch(/Passwort/);
    expect(task.reason).toMatch(/SMTP_\*/);
  });

  it('meldet beide Postausgänge getrennt', async () => {
    const disrupted = {
      state: 'gestoert' as const,
      disruptedSince: `${Today}T08:00:00.000Z`,
      errorClass: 'verbindung' as const,
      detectedBy: 'probe' as const,
    };
    const { tasks, total } = await outboxDisrupted.collect(
      contextWith([
        { ...Quiet, ...disrupted },
        { ...Quiet, role: 'instances', ...disrupted },
      ]),
    );
    expect(total).toBe(2);
    expect(tasks.map((a) => a.title)).toEqual([
      'Der Postausgang der Verwaltung ist gestört',
      'Der Postausgang der Instanzen ist gestört',
    ]);
  });

  it('meldet einen fehlenden Instanz-Postausgang', async () => {
    const { tasks } = await outboxDisrupted.collect(
      contextWith([{ ...Quiet, role: 'instances', state: 'nicht_eingerichtet' }]),
    );
    expect(tasks[0]).toMatchObject({
      title: 'Den Instanzen fehlt der Postausgang',
      dueAt: Today,
      urgency: 'high',
    });
    expect(tasks[0].reason).toMatch(/CONTROL_INSTANCE_SMTP_HOST/);
  });

  it('legt den Beginn nie in die Zukunft, auch bei verstellter Uhr', async () => {
    const { tasks } = await outboxDisrupted.collect(
      contextWith([
        {
          ...Quiet,
          state: 'gestoert',
          disruptedSince: '2026-09-13T01:00:00.000Z',
          errorClass: 'tls',
          detectedBy: 'send',
        },
      ]),
    );
    expect(tasks[0].dueAt).toBe(Today);
    expect(tasks[0].urgency).toBe('high');
  });
});
