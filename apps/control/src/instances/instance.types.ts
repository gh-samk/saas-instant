/** Datenvertrag der Instanzverwaltung (Etappe 3, Abschnitt 8 der Spezifikation). */

export type InstanceStatus = 'provisioning' | 'active' | 'stopped' | 'archived';

export interface InstanceMetricsPoint {
  current: number;
  /** `null`, solange keine mindestens drei Wochen alte Kennzahl vorliegt. */
  beforeThreeWeeks: number | null;
}

export interface InstanceMetrics {
  activePersons: InstanceMetricsPoint;
  circles: InstanceMetricsPoint;
  lastEntryAt: string | null;
  lastLoginAt: string | null;
  /**
   * Der Tag der letzten ERFOLGREICHEN Abfrage — abgeleitet aus der
   * `Kennzahl`-Historie, nicht aus `Instanz.lastMetricsFetchAt` (das ist
   * der letzte VERSUCH). Offener Punkt 12.5 der Spezifikation, hier entschieden.
   */
  lastSuccessfulQueryAt: string | null;
  /** 0 = die letzte Abfrage war erfolgreich. */
  sinceDaysFailed: number;
  /** Zustand der Datenbank der Instanz beim letzten erfolgreichen Abruf. */
  database: 'erreichbar' | 'gestoert' | null;
}

export interface InstanceBackup {
  last: { date: string; sizeBytes: number } | null;
  /** Fertig berechnet: liegt die letzte Sicherung länger zurück als erlaubt? */
  missing: boolean;
}

export interface InstanceDetail {
  id: string;
  companyId: string;
  subdomain: string;
  status: InstanceStatus;
  appVersion: string | null;
  createdAt: string;
  archivedAt: string | null;
  /** Transienter Zwischenstand während `wird_erstellt`/`gestoppt`. */
  message: string | null;
  /** `null`, solange `status !== 'aktiv'`. */
  metrics: InstanceMetrics | null;
  backup: InstanceBackup;
  /**
   * Gäbe es einen Einrichtungslink zu holen? — NICHT der Link selbst.
   *
   * [A.7] Der Link trägt das Einrichtungsgeheimnis der Kundeninstanz; wer es
   * hat, wird dort Administrator. Diese Antwort geht an eine blosse Sitzung
   * heraus, ein erbeutetes Cookie hätte also genügt. Den Link liefert nur
   * `POST :id/instanz/einladungslink/anzeigen` — hinter einem zweiten Faktor,
   * gedrosselt und mit Eintrag im Nachweis, wie bei den Zahlungsdaten.
   */
  invitationOpen: boolean;
  /**
   * Tag, an dem die Instanz als eingerichtet erkannt wurde (`YYYY-MM-DD`).
   *
   * `null` heisst „noch nicht erkannt", nicht „sicher nicht eingerichtet":
   * Ist die Instanz beim Nachfragen nicht erreichbar, bleibt das Feld leer,
   * statt zu raten.
   */
  configuredAt: string | null;
  /**
   * Wurde in Coolify schon eine Anwendung angelegt?
   *
   * Nur ja/nein, nicht die Kennung. Die Oberfläche braucht es, um nach einem
   * Fehlschlag die WAHRE Anweisung zu geben: „nichts entstanden, verwerfen"
   * oder „erst in Coolify löschen, dann verwerfen". Ohne das Feld stand unter
   * dem Knopf „dort ist nichts entstanden" — auch wenn dort etwas stand.
   */
  coolifyCreated: boolean;
}

/**
 * Eine Zeile der Übersicht „Instanzen".
 *
 * NUR, WAS DIE LISTE ZEIGT: keine Geheimnisse, keine Meldung; von den
 * Kennzahlen nur die Zahl der aktiven Personen. Wer mehr wissen will, geht in die Organisation — genau dorthin
 * führt jede Zeile.
 */
export interface InstanceListenEntry {
  id: string;
  subdomain: string;
  /** Die Adresse der Instanz, fertig zusammengesetzt. */
  url: string;
  status: InstanceStatus;
  /** Technischer Zeitstempel (ISO). */
  createdAt: string;
  company: { id: string; name: string };
  /** Zuletzt gemeldete Version; `null`, solange keine bekannt ist. */
  appVersion: string | null;
  /**
   * Aktive Personen laut letzter ERFOLGREICHER Kennzahlenabfrage; `null` bei
   * nicht laufenden Instanzen und solange nie eine Zahl ankam.
   */
  activePersons: number | null;
  /** Tag der letzten Sicherung (`YYYY-MM-DD`), `null` = noch nie. */
  lastBackupAt: string | null;
  /**
   * Fertig berechnet, mit derselben Schwelle wie Detailkarte und Aufgabe
   * „Sicherung überfällig" (`BACKUP_MISSING_AFTER_DAYS`). Nur laufende
   * Instanzen können sie verpassen — alle anderen: `false`.
   */
  backupMissing: boolean;
}

/** Was die Pflicht-Vorschau vor dem Anlegen zeigt. */
export interface InstancePreviewResponse {
  previewId: string;
  subdomain: string;
  url: string;
  applicationName: string;
  databaseName: string;
  /** NUR die Namen der Umgebungsvariablen. Niemals ihre Werte. */
  environmentVariables: string[];
  /** Technischer Zeitstempel, ab wann die Vorschau erneuert werden muss. */
  validUntil: string;
  /** Weicht die eingegebene Subdomain vom Vorschlag aus dem Namen ab? */
  deviatesBySuggestionFrom: boolean;
  suggestedSubdomain: string;
}

/** Eine Coolify-Anwendung ohne passenden CRM-Eintrag. */
export interface OrphanedApplication {
  subdomain: string;
  coolifyUrl: string | null;
  detectedAt: string;
}

/** Eine organisationsgebundene Abweichung aus dem Abgleich. */
export interface ReconciliationDeviation {
  instanceId: string;
  companyId: string;
  kind: 'without_coolify_application' | 'statusunterschied';
  crmStatus: string;
  coolifyStatus: string | null;
}
