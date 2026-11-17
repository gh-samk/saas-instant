import type { Instance, Metric, Backup } from '.prisma/control-client';
import { datePlusDays, dateStringFromDate, today } from '@saas-instant/shared';
import { CONTRACT_PRESET, instanceHost } from '../coolify/coolify.config';
import {
  BACKUP_MISSING_AFTER_DAYS,
  COMPARISON_DAYS,
} from './instance.rules';
import type {
  InstanceDetail,
  InstanceMetrics,
  InstanceMetricsPoint,
  InstanceBackup,
  InstanceStatus,
} from './instance.types';

/**
 * Formt die Datenbankzeilen in den Datenvertrag der Oberfläche um.
 *
 * ALLE ABLEITUNGEN PASSIEREN HIER, nicht im Browser: `sinceDaysFailed`,
 * `ausgeblieben` und der Vergleichswert „vor drei Wochen" sind
 * Betriebsentscheidungen (`instance.rules.ts`), und die Oberfläche soll sie
 * weder kennen noch nachrechnen — dieselbe Zurückhaltung wie bei den
 * Fristen der Organisation.
 */
export function toInstanceDetail(
  instance: Instance,
  metrics: Metric[],
  backups: Backup[],
  baseDomain: string,
  /**
   * LIEGT ein Einrichtungsgeheimnis vor? — nicht mehr das Geheimnis selbst.
   *
   * [A.7] Diese Antwort geht an eine reine Sitzung heraus. Sie trägt deshalb
   * nur noch die Ja/Nein-Auskunft, ob ein Einladungslink zu holen wäre. Den
   * Link selbst gibt es über `POST :id/instanz/einladungslink/anzeigen` — hinter
   * einem zweiten Faktor und mit Eintrag im Nachweis.
   */
  hasSetupSecret = false,
  todayDay: string = today(),
): InstanceDetail {
  const status = instance.status as InstanceStatus;
  const values = status === 'active' ? toMetrics(metrics, todayDay) : null;
  return {
    id: instance.id,
    companyId: instance.companyId,
    subdomain: instance.subdomain,
    status,
    appVersion: instance.appVersion,
    createdAt: instance.createdAt.toISOString(),
    archivedAt:
      instance.archivedAt === null
        ? null
        : dateStringFromDate(instance.archivedAt),
    message: instance.message,
    metrics: values,
    backup: toBackup(backups, todayDay),
    invitationOpen: invitationOpenFrom(
      status,
      values,
      hasSetupSecret,
      instance.setupCompletedAt !== null,
    ),
    configuredAt:
      instance.setupCompletedAt === null
        ? null
        : dateStringFromDate(instance.setupCompletedAt),
    coolifyCreated: instance.coolifyApplicationId !== null,
  };
}

/**
 * Der Einrichtungslink — solange ihn niemand eingelöst hat.
 *
 * ER TRÄGT EIN GEHEIMNIS, und das ist der ganze Punkt ([K4]). Vorher war er
 * die Konstante `https://<subdomain>.<basis>/setup`, also frei erratbar —
 * und weil `POST /api/setup` bis zum Abschluss der Einrichtung
 * unauthentifiziert ist, wurde Admin der Organisation, wer die frische
 * Subdomain zuerst erreichte. Die Oberfläche nannte ihn „Einladungslink —
 * noch nicht eingelöst" und behauptete damit eine Eigenschaft, die er nicht
 * hatte.
 *
 * Jetzt zeigt er auf `<setupPath>?token=…`: Die Instanz prüft das
 * Geheimnis zeitkonstant, setzt ein kurzlebiges Cookie und leitet auf den
 * Assistenten weiter.
 *
 * OHNE GEHEIMNIS GIBT ES KEINEN LINK. Eine Instanz von vor dieser Änderung
 * bekommt `null` statt einer Adresse, die nichts schützt — lieber kein Link
 * als ein Link, der etwas verspricht, was er nicht hält.
 *
 * „Eingelöst" heisst: die Instanz meldet mindestens eine aktive Person, also
 * hat jemand den Assistenten abgeschlossen. Vor der ersten erfolgreichen
 * Kennzahlen-Abfrage (`werte === null`) gilt er als offen — eine frisch
 * angelegte Instanz ist genau der Fall, in dem der Link gebraucht wird.
 *
 * DIE VERZÖGERUNG VON BIS ZU 24 STUNDEN IST BEHOBEN ([H4]).
 *
 * Bis zum 12.09.2026 war die einzige Grundlage der TÄGLICHE Kennzahlenabruf,
 * und das stand hier als bewusste Abwägung. Im Betrieb sah das so aus: Eine
 * Instanz wurde am Vormittag angelegt und eingerichtet, und die Verwaltung
 * bot bis zum nächsten Morgen „Einrichtungslink anzeigen" an — für einen
 * Link, den die Instanz selbst schon mit 410 sperrte. Wer das sieht, glaubt
 * der Karte beim nächsten Mal nicht mehr.
 *
 * Jetzt gibt es `Instanz.setupCompletedAt`, und `eingerichtet` sticht
 * alle übrigen Bedingungen. Gesetzt wird der Tag vom Kennzahlenabruf und vom
 * `SetupStatusService`, der beim Öffnen der Karte EINMAL die öffentliche
 * Auskunft `GET <setupStatusPath>` der Instanz liest — nur, solange der Link
 * nach bisherigem Stand offen wäre. Das ist kein Push von aussen (E3-6 bleibt:
 * das CRM fragt, die Instanz schickt nichts) und kein Takt: Die Karte fragt
 * im Zustand `aktiv` nicht periodisch nach.
 */
export function invitationLinkFrom(
  status: InstanceStatus,
  values: InstanceMetrics | null,
  subdomain: string,
  baseDomain: string,
  setupToken: string | null,
  /** `Instanz.setupCompletedAt !== null` — sticht alles andere. */
  isConfigured: boolean,
  /** Instanz-Vertrag: Pfad des Einladungslinks. */
  setupPath: string = CONTRACT_PRESET.setupPath,
  /** Muster des Hostnamens (Manifest `provisioning.subdomainPattern`). */
  subdomainPattern: string = CONTRACT_PRESET.subdomainPattern,
): string | null {
  if (!invitationOpenFrom(status, values, setupToken !== null, isConfigured)) {
    return null;
  }
  return (
    `https://${instanceHost({ baseDomain, subdomainPattern }, subdomain)}${setupPath}` +
    `?token=${encodeURIComponent(setupToken as string)}`
  );
}

/**
 * Gäbe es einen Einladungslink zu holen? — die Auskunft OHNE das Geheimnis.
 *
 * Genau dieselben Bedingungen wie `invitationLinkFrom`, damit die Anzeige
 * nicht einen Knopf anbietet, hinter dem nichts liegt.
 */
export function invitationOpenFrom(
  status: InstanceStatus,
  values: InstanceMetrics | null,
  hasSetupSecret: boolean,
  isConfigured: boolean,
): boolean {
  if (status !== 'active') return false;
  // VOR allen anderen Bedingungen: Ein festgestellter Abschluss gilt, auch
  // wenn die Kennzahlen (noch) nichts melden. Sonst stünde der Link weiter da,
  // bis der nächtliche Abruf nachzieht — genau der Fehler, um den es geht.
  if (isConfigured) return false;
  if (!hasSetupSecret) return false;
  if (values !== null && values.activePersons.current > 0) return false;
  return true;
}

/** Die Sicherungslage: letzte Zeile plus die fertige Aussage „ausgeblieben". */
export function toBackup(
  backups: Backup[],
  todayDay: string,
): InstanceBackup {
  const last = [...backups].sort(
    (a, b) => b.date.getTime() - a.date.getTime(),
  )[0];
  if (last === undefined) {
    // Noch nie gesichert. Das IST der Störungsfall — eine Instanz ohne jede
    // Sicherung ist genau das, was der Auftrag „stilles Ausbleiben" nennt.
    return { last: null, missing: true };
  }
  const day = dateStringFromDate(last.date);
  const limit = datePlusDays(todayDay, -BACKUP_MISSING_AFTER_DAYS);
  return {
    last: { date: day, sizeBytes: Number(last.sizeBytes) },
    missing: day < limit,
  };
}

/**
 * Die Kennzahlen als Zeitreihe zusammengefasst.
 *
 * `kennzahlen` kommt absteigend nach Tag sortiert herein. Gezählt wird gegen
 * die letzte ERFOLGREICHE Zeile; gescheiterte Abfragen stehen mit
 * `fetchSuccessful: false` daneben und werden hier zu
 * `sinceDaysFailed` — sie verschwinden nicht (E3-7).
 */
export function toMetrics(
  metrics: Metric[],
  todayDay: string,
): InstanceMetrics | null {
  const afterDay = [...metrics].sort(
    (a, b) => b.date.getTime() - a.date.getTime(),
  );
  const successful = afterDay.filter((z) => z.fetchSuccessful);
  const latest = successful[0];
  if (latest === undefined) {
    if (afterDay.length === 0) return null;
    // Es gab Versuche, aber nie einen Erfolg. Auch das ist eine Aussage.
    return {
      activePersons: { current: 0, beforeThreeWeeks: null },
      circles: { current: 0, beforeThreeWeeks: null },
      lastEntryAt: null,
      lastLoginAt: null,
      lastSuccessfulQueryAt: null,
      sinceDaysFailed: daysBetween(
        dateStringFromDate(afterDay[afterDay.length - 1].date),
        todayDay,
      ),
      database: null,
    };
  }

  const lastSuccessDay = dateStringFromDate(latest.date);
  const comparisonDay = datePlusDays(lastSuccessDay, -COMPARISON_DAYS);
  // Die jüngste erfolgreiche Zeile, die MINDESTENS drei Wochen zurückliegt.
  // Liegt keine vor (junge Instanz), entfällt der Vergleich ganz — ein
  // erfundener Nullwert behauptete einen Rückgang, den niemand gemessen hat.
  const comparison = successful.find(
    (z) => dateStringFromDate(z.date) <= comparisonDay,
  );

  return {
    activePersons: point(latest.activePersons, comparison?.activePersons ?? null),
    circles: point(latest.circles, comparison?.circles ?? null),
    lastEntryAt:
      latest.lastEntryAt === null
        ? null
        : dateStringFromDate(latest.lastEntryAt),
    lastLoginAt:
      latest.lastLoginAt === null
        ? null
        : dateStringFromDate(latest.lastLoginAt),
    lastSuccessfulQueryAt: lastSuccessDay,
    sinceDaysFailed: daysBetween(lastSuccessDay, todayDay),
    database: databaseStateFrom(latest.databaseState),
  };
}

function point(
  current: number | null,
  beforeThreeWeeks: number | null,
): InstanceMetricsPoint {
  return { current: current ?? 0, beforeThreeWeeks };
}

function databaseStateFrom(value: string | null): 'erreichbar' | 'gestoert' | null {
  return value === 'erreichbar' || value === 'gestoert' ? value : null;
}

/** Ganze Tage zwischen zwei Tagesdaten `YYYY-MM-DD`, nie negativ. */
export function daysBetween(from: string, until: string): number {
  const a = Date.parse(`${from}T00:00:00.000Z`);
  const b = Date.parse(`${until}T00:00:00.000Z`);
  const days = Math.round((b - a) / 86_400_000);
  return days > 0 ? days : 0;
}
