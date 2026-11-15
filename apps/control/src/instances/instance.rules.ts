/**
 * Die Betriebsentscheidungen der Instanzverwaltung — an EINER Stelle.
 *
 * Die Spezifikation nennt sie ausdrücklich Backend-Sache (Offene Punkte 12.2
 * und 12.4): Die Oberfläche bekommt fertig berechnete Felder und muss die
 * Schwellen nicht kennen. Sie stehen deshalb hier und nicht verstreut in den
 * Quellen, damit ein Wechsel eine Zeile ist und keine Suche.
 */

/**
 * Ab wie vielen Tagen ohne neue Sicherung gilt sie als ausgeblieben.
 *
 * Der Betrieb sichert ZWEIMAL TÄGLICH (siehe docs/operations/backup-and-recovery.md).
 * Zwei Tage ohne eine einzige Zeile heisst also: mindestens vier Läufe sind
 * ausgefallen. Ein Tag wäre zu eng — ein verspäteter Lauf über Mitternacht
 * erzeugte sonst jede Woche einen Fehlalarm, und ein Alarm, der meistens
 * nichts bedeutet, wird nicht mehr gelesen.
 */
export const BACKUP_MISSING_AFTER_DAYS = 2;

/**
 * Ab wie vielen Tagen ohne Eintrag die Instanz als ungenutzt gilt.
 *
 * Der Auftrag nennt diese Zahl selbst und nennt sie die geschäftlich
 * wichtigste Zeile der Anwendung: Abwanderung entsteht bei diesem Produkt
 * nicht über den Preis, sondern über Nichtnutzung.
 */
export const NO_ENTRY_DAYS = 45;

/** Fester Vergleichszeitraum der Kennzahlen: „vor drei Wochen". */
export const COMPARISON_DAYS = 21;

/** Wie lange eine erzeugte Vorschau gültig bleibt (Minuten). */
export const PREVIEW_VALID_MINUTES = 15;

/**
 * Ab wann eine laufende Erstellung als „hängt fest" gilt (Minuten).
 *
 * Vorschlag der Spezifikation (Offener Punkt 12.2), hier übernommen. Ein
 * vollständiger Coolify-Durchlauf (Bau des Images, Deployment, TLS,
 * Health-Check) braucht laut Provisionierungsskript einige Minuten; 15 lässt
 * dafür Luft und ist trotzdem noch am selben Arbeitstag auffällig.
 */
export const STUCK_MINUTES = 15;

/** Wie lange auf den Abschluss eines Deployments gewartet wird (Sekunden). */
export const DEPLOY_TIMEOUT_S = 600;

/** Wie lange nach dem Deployment auf den Health-Check gewartet wird (Sekunden). */
export const HEALTH_TIMEOUT_S = 180;

/** Zeitgrenze einer einzelnen Kennzahlen-Abfrage (Millisekunden). */
export const METRICS_TIMEOUT_MS = 20_000;

/** Die Umgebungsvariablen, die eine neue Instanz bekommt (nur die NAMEN). */
export const ENVIRONMENT_VARIABLES = [
  'APP_URL',
  'COOKIE_SECURE',
  'NODE_ENV',
  'POSTGRES_PASSWORD',
  'JWT_SECRET',
  'SESSION_SECRET',
  'CONFIG_KEY',
  'METRICS_TOKEN',
  'SETUP_TOKEN',
  // Der geteilte Postausgang. Fehlte bis zum 11.09.2026 — und Coolify belegte
  // `SMTP_HOST` aus der Pflichtform der Compose mit einem deutschen Satz.
  // `compose-required.spec.ts` hält diese Liste gegen die Compose-Datei.
  'SMTP_HOST',
  'SMTP_PORT',
  'SMTP_USER',
  'SMTP_PASS',
  'SMTP_FROM',
] as const;

/**
 * Name der Datenbank in einer Kundeninstanz.
 *
 * ABWEICHUNG VON DER DESIGN-SPEZIFIKATION, bewusst: Dort steht in der Vorschau
 * `<name>_<subdomain>`. Tatsächlich bekommt jede Instanz einen EIGENEN
 * Datenbank-Container innerhalb ihres eigenen Compose-Stapels
 * (`docker-compose.coolify.yml`), und die Datenbank darin heisst schlicht
 * `instanz`. Einen Namen anzuzeigen, den es nicht gibt, wäre in einer
 * Vorschau, deren einziger Zweck das Auffallen von Fehlern ist, das schlechteste
 * Ergebnis. Unterschieden werden die Instanzen über den Stapelnamen.
 */
export const DATABASE_NAME = 'instance';
