/**
 * ===========================================================================
 * DAS PROTOKOLL SICHERHEITSRELEVANTER EREIGNISSE — die Leseseite von R6
 * ===========================================================================
 *
 * Das Audit-Log führt rund sechzig Aktionen. Sie ALLE in einem Screen namens
 * „Sicherheit" zu zeigen wäre die zuverlässigste Art, ihn nutzlos zu machen:
 * Zwischen „Notiz geändert" und „Anmeldung mit falschem Passwort" fällt der
 * zweite Eintrag nicht mehr auf. Ein Protokoll, in dem nichts auffällt, ist
 * keins.
 *
 * DESHALB EINE AUSDRÜCKLICHE LISTE und kein Präfixvergleich. Ein Präfix wie
 * `anmeldung.` sähe kürzer aus, nähme aber jede künftige Aktion stillschweigend
 * mit auf — und niemand entschiede je wieder, ob sie hierhergehört. Wer eine
 * Aktion ergänzt, trägt sie hier ein oder eben nicht; beides ist eine
 * Entscheidung.
 *
 * WAS DRINSTEHT: alles, was den ZUGANG betrifft — Anmeldungen (auch die
 * gescheiterten), zweite Faktoren, Passwörter, Geräte, Sperren, Notfallwege.
 * Dazu die beiden Lesevorgänge auf besonders schutzwürdige Daten
 * (Zahlungsdaten, Kontaktdatenlöschung): Sie sind keine Zugangsereignisse,
 * aber genau das, was man in einem Sicherheitsprotokoll sucht.
 *
 * WAS NICHT DRINSTEHT: der fachliche Betrieb. Organisationen, Rechnungen,
 * Instanzen, Notizen, Zeitpläne, Anfragen. Sie stehen weiterhin im Audit-Log
 * und sind über die Datenbank lesbar — nur nicht in DIESER Liste.
 */

/** Die Aktionen, die im Sicherheitsprotokoll erscheinen. */
export const SECURITY_ACTIONS: readonly string[] = [
  // Anmeldung, Faktor eins und zwei — Erfolge UND Fehlversuche.
  'login.password.success',
  'login.password.failure',
  'login.second_factor_required',
  'login.totp.success',
  'login.totp.failure',
  'login.email_code.success',
  'login.email_code.failure',
  'login.passkey.success',
  'login.passkey.failure',
  'login.recovery_code.success',
  'login.recovery_code.failure',
  'second_factor.failure',
  // Einrichtung und Entzug von Faktoren.
  'login_code.requested',
  'login_code.not_sent',
  'login_code.address_change_requested',
  'login_code.set_up',
  'login_code.removed',
  'totp.set_up',
  'totp.setup.failure',
  'totp.removed',
  'passkey.registered',
  'passkey.revoked',
  'factor.removal_rejected',
  'recovery_code.new_generated',
  // Passwort.
  'password.set',
  'password.change.failure',
  // Sitzungen und Merk-Geräte.
  'session.logout',
  'device.created',
  'device.renewed',
  'device.revoked',
  'device.all_revoked',
  // Sperren.
  'account.locked',
  'account.unlocked',
  // Notfallwege — die Umgehung des gewöhnlichen Zugangs.
  'emergency.password.generated',
  'emergency.password.redeemed',
  'emergency.enrollment.generated',
  'emergency.enrollment.redeemed',
  // Zugänge. Wer wen einträgt oder abschaltet, ist die Frage, die ein
  // Sicherheitsprotokoll zuerst beantworten muss — erst recht, wenn jedes
  // Konto dasselbe darf.
  'user.registered',
  'user.deactivated',
  'user.reactivated',
  'user.last_account_rejected',
  // Zugriffe auf besonders schutzwürdige Daten. Keine Zugangsereignisse —
  // aber genau das, was man in einem Sicherheitsprotokoll sucht.
  'company.payment_details.read',
  'company.payment_details.updated',
  'company.contact_data.deleted',
];

/**
 * Der Klartext je Aktion.
 *
 * DIE AKTIONSKENNUNG SELBST STEHT NICHT IN DER OBERFLÄCHE. „anmeldung.totp.
 * fehler" ist für die Datenbank gedacht, nicht für einen Menschen um halb
 * elf abends, der wissen will, ob jemand an seinem Konto war.
 *
 * FEHLT EINE KENNUNG HIER, wird sie unverändert angezeigt statt verschwiegen.
 * Ein Eintrag ohne Text ist immer noch ein Eintrag; ihn wegzulassen wäre eine
 * Lücke im Protokoll.
 */
export const SECURITY_TEXTS: Record<string, string> = {
  'login.password.success': 'Anmeldung mit Passwort',
  'login.password.failure': 'Fehlgeschlagene Anmeldung (Passwort)',
  'login.second_factor_required': 'Zweiter Faktor angefordert',
  'login.totp.success': 'Zweiter Faktor bestätigt (Authenticator)',
  'login.totp.failure': 'Zweiter Faktor falsch (Authenticator)',
  'login.email_code.success': 'Zweiter Faktor bestätigt (Code per E-Mail)',
  'login.email_code.failure': 'Zweiter Faktor falsch (Code per E-Mail)',
  'login.passkey.success': 'Anmeldung mit Passkey',
  'login.passkey.failure': 'Fehlgeschlagene Anmeldung (Passkey)',
  'login.recovery_code.success':
    'Anmeldung mit Wiederherstellungscode',
  'login.recovery_code.failure':
    'Wiederherstellungscode falsch',
  'second_factor.failure': 'Nachweis für eine geschützte Handlung falsch',
  'login_code.requested': 'Code per E-Mail angefordert',
  'login_code.not_sent': 'Code per E-Mail konnte nicht zugestellt werden',
  'login_code.address_change_requested':
    'Wechsel der Code-Adresse angefordert',
  'login_code.set_up': 'Code per E-Mail eingerichtet',
  'login_code.removed': 'Code per E-Mail entfernt',
  'totp.set_up': 'Authenticator-App eingerichtet',
  'totp.setup.failure': 'Einrichtung der Authenticator-App fehlgeschlagen',
  'totp.removed': 'Authenticator-App entfernt',
  'passkey.registered': 'Passkey angelegt',
  'passkey.revoked': 'Passkey widerrufen',
  'factor.removal_rejected':
    'Entfernen des letzten zweiten Faktors abgelehnt',
  'recovery_code.new_generated': 'Neue Wiederherstellungscodes erzeugt',
  'password.set': 'Passwort geändert',
  'password.change.failure': 'Passwortänderung fehlgeschlagen',
  'session.logout': 'Abmeldung',
  'device.created': 'Gerät gemerkt',
  'device.renewed': 'Merk-Gerät verlängert',
  'device.revoked': 'Gerät abgemeldet',
  'device.all_revoked': 'Alle Geräte abgemeldet',
  'account.locked': 'Konto nach Fehlversuchen gesperrt',
  'account.unlocked': 'Kontosperre aufgehoben',
  'emergency.password.generated': 'Notfall-Link für ein Passwort erzeugt',
  'emergency.password.redeemed': 'Notfall-Link für ein Passwort eingelöst',
  'emergency.enrollment.generated': 'Notfall-Link für einen Zugang erzeugt',
  'emergency.enrollment.redeemed': 'Notfall-Link für einen Zugang eingelöst',
  'user.registered': 'Konto eingetragen',
  'user.deactivated': 'Zugang entzogen',
  'user.reactivated': 'Zugang wieder erteilt',
  'user.last_account_rejected':
    'Entzug des letzten Zugangs abgelehnt',
  'company.payment_details.read': 'Zahlungsdaten angesehen',
  'company.payment_details.updated': 'Zahlungsdaten geändert',
  'company.contact_data.deleted': 'Kontaktdaten gelöscht',
};

/**
 * Ereignisse, die eine ABWEICHUNG sind und nicht der Normalbetrieb.
 *
 * Sie werden in der Oberfläche hervorgehoben. Nicht als „Gefahr" — ein
 * einzelner Tippfehler beim Passwort ist keiner —, sondern als das, was man
 * beim Überfliegen zuerst sehen will.
 */
export const SUSPICIOUS_ACTIONS: readonly string[] = [
  'login.password.failure',
  'login.totp.failure',
  'login.email_code.failure',
  'login.passkey.failure',
  'login.recovery_code.failure',
  'second_factor.failure',
  'password.change.failure',
  'totp.setup.failure',
  'factor.removal_rejected',
  'account.locked',
  'login_code.not_sent',
  'emergency.password.redeemed',
  'emergency.enrollment.redeemed',
  'user.last_account_rejected',
];

/** Eine Zeile des Sicherheitsprotokolls. */
export interface SecurityEvent {
  id: string;
  /** ISO-Zeitstempel. Technisch, kein fachliches Datum — hier zählt die Minute. */
  timestamp: string;
  action: string;
  /** Der Klartext, oder die Kennung, wenn keiner hinterlegt ist. */
  text: string;
  /** Wer gehandelt hat, im Klartext — auch bei einem Fehlversuch. */
  actor: string;
  /** `true`, wenn das Ereignis eine Abweichung ist. */
  suspicious: boolean;
  ip: string | null;
}
