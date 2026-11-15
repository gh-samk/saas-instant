import { dateStringFromDate } from '@saas-instant/shared';
import { urgencyFrom } from '../urgency';
import type {
  Task,
  TasksContext,
  TaskSource,
  SourceResult,
} from '../tasks.types';

/** Klartext der Instanz-Zustände für die Begründung. */
const INSTANCE_LABEL: Record<string, string> = {
  provisioning: 'Wird erstellt',
  active: 'Aktiv',
  stopped: 'Wird archiviert',
  archived: 'Archiviert',
};

/**
 * Die organisationsgebundenen Befunde des täglichen Abgleichs.
 *
 * DER ABGLEICH MELDET, ER KORRIGIERT NICHT (E3-16). Diese Quelle liest
 * ausschliesslich den zuletzt gespeicherten `AbgleichLauf` und formt ihn zu
 * Aufgaben um — sie fragt Coolify nicht selbst und ändert nichts.
 *
 * Die dritte Befundart (Coolify-Anwendung ganz ohne CRM-Eintrag) taucht hier
 * NICHT auf: Sie hat keine Organisation, an die sich eine Aufgabe hängen
 * liesse. Sie geht als eigene Liste `orphanedApplications` mit derselben
 * Antwort heraus (`TasksService.sammle`).
 */
export const reconciliationDeviation: TaskSource = {
  kind: 'reconciliation_deviation',

  async collect(context: TasksContext): Promise<SourceResult> {
    const run = await context.prisma.reconciliationRun.findFirst({
      orderBy: { executedAt: 'desc' },
    });
    // Kein Lauf oder ein gescheiterter Lauf heisst NICHT „kein Befund". Es
    // heisst, dass nichts gemessen wurde — und daraus eine beruhigende leere
    // Liste zu machen, wäre die schlechteste aller Auskünfte. Gemeldet wird
    // das trotzdem nicht hier, sondern über `state.abgleich` in der Antwort;
    // eine erfundene Aufgabe „der Abgleich lief nicht" hätte keine
    // Organisation und passte nicht in diesen Vertrag.
    if (run === null || !run.successful) return { tasks: [], total: 0 };

    const deviations = asList(run.deviations);
    if (deviations.length === 0) return { tasks: [], total: 0 };

    const companies = await context.prisma.company.findMany({
      where: { id: { in: deviations.map((a) => a.companyId) } },
      select: { id: true, name: true, status: true },
    });
    const afterId = new Map(companies.map((o) => [o.id, o]));

    // Fällig ist der Befund am Tag des Abgleichs — er ist damit sofort
    // überfällig und steht oben, ohne dass die Art dafür eine Sonderregel
    // bräuchte.
    const dueAt = dayFrom(run.executedAt);

    const all: Task[] = deviations
      .map((deviation): Task | null => {
        const company = afterId.get(deviation.companyId);
        if (company === undefined) return null;
        return {
          kind: 'reconciliation_deviation' as const,
          dueAt,
          urgency: urgencyFrom(dueAt, context.todayDay),
          title:
            deviation.kind === 'without_coolify_application'
              ? 'Instanz in Coolify nicht auffindbar'
              : 'Status weicht von Coolify ab',
          reason:
            deviation.kind === 'without_coolify_application'
              ? `Der Abgleich konnte am ${dueAt} keine passende Anwendung ` +
                'in Coolify finden. Es wurde nichts geändert und nichts ' +
                'gelöscht — bitte von Hand nachsehen.'
              : `CRM zeigt „${INSTANCE_LABEL[deviation.crmStatus] ?? deviation.crmStatus}", ` +
                `Coolify zeigt „${deviation.coolifyStatus ?? 'unbekannt'}". ` +
                'Der Abgleich meldet nur; er gleicht nichts an.',
          action: {
            kind: 'company_open' as const,
            label: 'Organisation öffnen',
            target: `/companies/${company.id}`,
          },
          company: {
            id: company.id,
            name: company.name,
            status: company.status,
          },
        };
      })
      .filter((a: Task | null): a is Task => a !== null);

    return { tasks: all.slice(0, context.limit), total: all.length };
  },
};

interface Deviation {
  instanceId: string;
  companyId: string;
  kind: 'without_coolify_application' | 'statusunterschied';
  crmStatus: string;
  coolifyStatus: string | null;
}

/** Liest die JSON-Spalte defensiv — sie kommt aus einem früheren Lauf. */
function asList(value: unknown): Deviation[] {
  if (!Array.isArray(value)) return [];
  return (value as unknown[]).filter(
    (e): e is Deviation =>
      typeof e === 'object' &&
      e !== null &&
      typeof (e as Deviation).companyId === 'string' &&
      ((e as Deviation).kind === 'without_coolify_application' ||
        (e as Deviation).kind === 'statusunterschied'),
  );
}

function dayFrom(timestamp: Date): string {
  return dateStringFromDate(
    new Date(
      Date.UTC(
        timestamp.getUTCFullYear(),
        timestamp.getUTCMonth(),
        timestamp.getUTCDate(),
      ),
    ),
  );
}
