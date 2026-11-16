import { Injectable } from '@nestjs/common';
import type { Prisma } from '.prisma/control-client';
import type { DbClient } from '../prisma/db-client';
import { PrismaService } from '../prisma/prisma.service';
import { normalizeIp } from '../common/ip-address';
import {
  SUSPICIOUS_ACTIONS,
  SECURITY_ACTIONS,
  SECURITY_TEXTS,
  type SecurityEvent,
} from './audit-read';

/** Bekannte Aktionen im Audit-Log. Feste Namen, damit sich danach filtern lässt. */
export const AUDIT_ACTION = {
  // Faktor eins
  loginPasswordSuccess: 'login.password.success',
  loginPasswordError: 'login.password.failure',
  loginSecondFactorRequired: 'login.second_factor_required',
  // Faktor zwei
  loginTotpSuccess: 'login.totp.success',
  loginTotpError: 'login.totp.failure',
  loginRecoverySuccess: 'login.recovery_code.success',
  loginRecoveryError: 'login.recovery_code.failure',
  loginEmailCodeSuccess: 'login.email_code.success',
  loginEmailCodeError: 'login.email_code.failure',
  // Anforderung eines E-Mail-Codes. NIEMALS mit dem Code selbst — protokolliert
  // wird nur, DASS einer angefordert wurde, und ob er verschickt werden konnte.
  emailCodeRequested: 'login_code.requested',
  emailCodeNotSent: 'login_code.not_sent',
  emailCodeAddressChangeRequested: 'login_code.address_change_requested',
  emailCodeSetUp: 'login_code.set_up',
  emailCodeRemoved: 'login_code.removed',
  totpRemoved: 'totp.removed',
  /** Serverseitige Sperre gegen das Entfernen des letzten zweiten Faktors. */
  factorRemoveRejected: 'factor.removal_rejected',
  sessionRenewed: 'session.renewed',
  // Anmeldung über das Portal (Modus `portal`). Nie mit Token oder Code im Eintrag.
  ssoLoginSuccess: 'sso.login.success',
  ssoLoginError: 'sso.login.failure',
  ssoStepUpSuccess: 'sso.step_up.success',
  ssoStepUpError: 'sso.step_up.failure',
  ssoLogout: 'sso.logout',
  ssoFrontChannelLogout: 'sso.front_channel_logout',
  // Einstufiger Passkey-Weg
  loginPasskeySuccess: 'login.passkey.success',
  loginPasskeyError: 'login.passkey.failure',
  accountLocked: 'account.locked',
  accountUnlocked: 'account.unlocked',
  logout: 'session.logout',
  deviceCreated: 'device.created',
  deviceRenewed: 'device.renewed',
  deviceRevoked: 'device.revoked',
  devicesAllRevoked: 'device.all_revoked',
  passkeyRegistered: 'passkey.registered',
  passkeyRevoked: 'passkey.revoked',
  totpSetUp: 'totp.set_up',
  /**
   * Fehlgeschlagene Bestätigung der TOTP-Einrichtung.
   *
   * Fehlte bis [K5] ganz: die Route war die einzige Stelle, an der sich ein
   * Geheimnis raten ließ, ohne eine einzige Zeile zu hinterlassen.
   */
  totpSetupError: 'totp.setup.failure',
  recoveryCodesNew: 'recovery_code.new_generated',
  passwordSet: 'password.set',
  passwordChangeError: 'password.change.failure',
  secondFactorError: 'second_factor.failure',
  emergencyEnrollmentGenerated: 'emergency.enrollment.generated',
  emergencyEnrollmentRedeemed: 'emergency.enrollment.redeemed',
  emergencyPasswordGenerated: 'emergency.password.generated',
  emergencyPasswordRedeemed: 'emergency.password.redeemed',

  // --- Etappe 8: Nutzerverwaltung ---
  //
  // JEDE ÄNDERUNG AM ZUGANG STEHT IM NACHWEIS, auch die abgelehnte. Ein
  // versuchter Entzug des letzten Zugangs ist selbst eine Auskunft: Er sagt,
  // dass es jemand vorhatte.
  userRegistered: 'user.registered',
  // [Review B1] Adresse eines Kontos berichtigt, das noch keinen Zugang hat.
  userAddressCorrected: 'user.address.corrected',
  userDeactivated: 'user.deactivated',
  userReactivated: 'user.reactivated',
  /** Serverseitige Sperre gegen den Entzug des LETZTEN Zugangs. */
  userLastAccountRejected: 'user.last_account_rejected',

  // --- Etappe 2: Organisationen, Notizen, öffentliche Anfrage, Zeitplan ---
  companyCreated: 'company.created',
  companyUpdated: 'company.updated',
  /** Statuswechsel VON HAND durch die Betreiberin. */
  companyStatusChanged: 'company.status.changed',
  /**
   * Statuswechsel durch den täglichen Zeitplan — der erste automatische
   * Schreibvorgang im CRM. Bewusst eine EIGENE Aktion und nicht dieselbe wie
   * beim Wechsel von Hand: das Dashboard muss „seit deinem letzten Blick ist
   * etwas von allein passiert" beantworten können, und im Nachweis muss
   * unterscheidbar bleiben, wer gehandelt hat.
   */
  companyStatusAutomatic: 'company.status.automatic',
  companyContactPersonChanged: 'company.contact_person.changed',
  /**
   * Zahlungsdaten ANGESEHEN. Ja, auch das Lesen — bei einer Bankverbindung ist
   * der Zugriff selbst die Aktion, die im Nachweis stehen muss ([W4]).
   */
  companyPaymentDetailsRead: 'company.payment_details.read',
  // [A.7] Wer das Einrichtungsgeheimnis einer Kundeninstanz liest, wird dort
  // Administrator. Der Zugriff gehoert deshalb in den Nachweis — wie der auf
  // die Zahlungsdaten.
  instanceInvitationLinkRead: 'instance.invitation_link.read',
  /**
   * Einrichtungslink per Mail an die Ansprechpartnerin verschickt.
   *
   * Dasselbe Gewicht wie das Lesen: Wer den Link bekommt, wird auf der
   * Kundeninstanz Administrator. Im Eintrag steht nur die Subdomain — weder
   * Link noch Adresse; die Adresse steht in der Versandzeile, und die räumt die
   * Kontaktdatenlöschung.
   */
  instanceInvitationLinkSent: 'instance.invitation_link.sent',
  companyPaymentDetailsUpdated: 'company.payment_details.updated',
  /**
   * Kontaktdaten gelöscht — von Hand ausgelöst, nie automatisch (R4).
   *
   * Der Eintrag nennt, WELCHE Felder geräumt wurden, niemals ihre Werte: Das
   * Audit-Log hat keinen Löschweg, ein „vorher" mit den Daten machte die
   * Löschung wirkungslos.
   */
  companyContactDataDeleted: 'company.contact_data.deleted',
  /**
   * Die ganze Organisation entfernt — möglich nur, solange keine Instanz,
   * keine Rechnung und keine werbliche Mail an ihr hängt.
   *
   * OHNE NAMEN, wie jeder Eintrag hier: `name` steht auf
   * `VERBOTENE_FELDNAMEN`. Der Eintrag nennt die Kennung, den Status, den
   * Anlagetag und die Zahl der mitgelöschten Zeilen — genug, um
   * nachzuvollziehen, wer wann was entfernt hat, und zu wenig, um die
   * Löschung wieder aufzuheben.
   */
  companyDeleted: 'company.deleted',
  noteCreated: 'note.created',
  noteUpdated: 'note.updated',
  noteDeleted: 'note.deleted',
  /** Anfrage über das öffentliche Formular, neue Organisation angelegt. */
  publicInquiryReceived: 'public.inquiry.received',
  /** Anfrage zu einer bereits bekannten Adresse — nur Notiz, keine zweite Organisation. */
  publicInquiryDuplicate: 'public.inquiry.duplicate',
  /** Honeypot-Feld ausgefüllt: verworfen, aber nachweisbar. */
  publicInquiryDiscarded: 'public.inquiry.discarded',
  /**
   * Die Anfrage steht in der Datenbank, aber die Benachrichtigungsmail ging
   * nicht hinaus. Das ist der Fall, für den es die Redundanz gibt — er darf
   * nicht still bleiben.
   */
  publicInquiryMailError: 'public.inquiry.mail_failed',
  /** Falscher oder fehlender Schlüssel im Header der öffentlichen Route. */
  publicInquiryRefused: 'public.inquiry.refused',
  // --- Das Aufnahmeformular der Pilotphase (A.35) ---
  /**
   * Ein Einmal-Link zum Aufnahmeformular wurde erzeugt. OHNE den Token: Das
   * Audit-Log hat keinen Loeschweg, und ein Token darin waere ein Zugang, den
   * niemand mehr entwerten kann.
   */
  intakeAccessGenerated: 'intake.access.generated',
  /** Der Link ging per Mail hinaus — automatisch oder auf Zuruf. */
  intakeAccessSent: 'intake.access.sent',
  /**
   * Das Formular wurde abgeschickt. NIEMALS mit der IBAN im Nachweis —
   * stattdessen `{ bankverbindungHinterlegt: true, mandatsreferenz }`. Der
   * Name meidet „iban" mit Absicht: `istVerboten()` vergleicht als
   * Teilzeichenkette und loeschte sonst genau die Angabe, die hier stehen
   * soll.
   */
  intakeReceived: 'intake.received',
  /** Abgewiesen: unbekannter, abgelaufener oder schon benutzter Token. */
  intakeRejected: 'intake.rejected',

  scheduleRun: 'schedule.run',

  // --- Etappe 3: Instanzen, Kennzahlen, Sicherungen, Abgleich ---
  /**
   * Die Pflicht-Vorschau wurde erzeugt. EIGENE Aktion, damit im Nachweis
   * steht, dass der Schritt stattgefunden hat — er ist die Schranke gegen
   * eine falsch getippte Subdomain und darf nicht unsichtbar sein.
   */
  instancePreviewGenerated: 'instance.preview.generated',
  /** Erster der beiden erlaubten Schreibvorgaenge gegen eine Kundeninstanz. */
  instanceCreated: 'instance.created',
  /** Der Hintergrundaufbau ist durch, die Instanz antwortet. */
  instanceReady: 'instance.ready',
  /**
   * Der Aufbau oder die Archivierung ist gescheitert. Muss eine EIGENE Aktion
   * sein: „kein stiller Halbzustand" (E3-12) heisst, dass der Fehlschlag
   * genauso nachweisbar ist wie der Erfolg.
   */
  instanceProvisioningError: 'instance.provisioning.failure',
  /** Zweiter und letzter erlaubter Schreibvorgang. NIEMALS ein Loeschen. */
  instanceArchived: 'instance.archived',
  /**
   * Eine GESCHEITERTE Erstellung wurde verworfen ([W4]).
   *
   * Der einzige Weg aus der Sackgasse: `wird_erstellt` blieb sonst stehen, und
   * `Instanz.organisationId` ist unique — die Organisation waere dauerhaft
   * ohne Instanz und ohne Weg zu einer. Erlaubt ist es nur, wenn in Coolify
   * GAR NICHTS entstanden ist; die Zeile beschreibt dann einen Vorgang, der
   * nie stattgefunden hat. Dieser Eintrag steht VOR dem Verwerfen und
   * ueberlebt es.
   */
  instanceCreationDiscarded: 'instance.creation.discarded',
  /** Zusammenfassung des taeglichen Kennzahlen-Abrufs (Pull). */
  metricsFetch: 'metrics.fetch',
  /** Meldung einer gelungenen Sicherung durch das externe Werkzeug. */
  backupReported: 'backup.reported',
  /** Sicherungsziel geaendert (nur Metadaten, nie Zugangsdaten). */
  backupTargetUpdated: 'backup.target_updated',
  /** Verbindungstest des Sicherungsziels ausgeloest. */
  backupTargetTested: 'backup.target_tested',
  /** Sicherung (oder Pruefung) beim Sicherungs-Agent angestossen. */
  backupJobTriggered: 'backup.job_triggered',
  /** Wiederherstellung als NEUE Instanz begonnen. */
  instanceRestoreStarted: 'instance.restore_started',
  /** Wiederhergestellte Instanz uebernommen; die alte wurde GESTOPPT, nie geloescht. */
  instanceRestoreAdopted: 'instance.restore_adopted',
  /** Taeglicher Abgleich Coolify <-> CRM. Er meldet, er korrigiert nicht. */
  coolifyReconciliation: 'coolify.reconciliation',

  // --- Etappe 4: Rechnungen -----------------------------------------------
  //
  // R6 gilt hier besonders: Eine Rechnung ist ein Beleg mit zehn Jahren
  // Aufbewahrungspflicht. Was mit ihr geschah, muss vollstaendig nachlesbar
  // sein — OHNE dass Zahlungsdaten oder personenbezogene Angaben im Klartext
  // ins Log geraten. Die Sperrliste aus Etappe 2 greift dabei von selbst:
  // `name`, `email`, `strasse`, `plz`, `ort` und `iban` sind darin bereits
  // enthalten. Die Aufrufer uebergeben deshalb nur Betraege, Zeitraeume und
  // Kennungen.
  invoiceDraftCreated: 'invoice.draft.created',
  invoiceDraftUpdated: 'invoice.draft.updated',
  /**
   * Ein ENTWURF wurde geloescht — der einzige Loeschvorgang des Moduls.
   *
   * Eine eigene Aktion und nicht dieselbe wie beim Storno: Im Nachweis muss
   * unterscheidbar bleiben, ob ein Versuch verworfen oder ein Beleg
   * zurueckgenommen wurde. Ab dem Festschreiben gibt es diesen Weg nicht mehr
   * (R2).
   */
  invoiceDraftDeleted: 'invoice.draft.deleted',
  /**
   * DER VORGANG, AUF DEN ES ANKOMMT: Nummer vergeben, Schnappschuss
   * eingefroren, Rechnung unveraenderlich.
   */
  invoiceFinalized: 'invoice.finalized',
  /** Storniert — mit der Nummer der Stornorechnung im Nachweis. */
  invoiceCancelled: 'invoice.cancelled',
  /** Das PDF/A-3b samt eingebettetem factur-x.xml wurde erzeugt. */
  invoiceDocumentGenerated: 'invoice.document.generated',
  /**
   * Der Rechnungsdienst hat das erzeugte Dokument selbst als ungueltig
   * erkannt. Muss eine eigene Aktion sein: Es ist der einzige Fall, in dem
   * eine festgeschriebene Rechnung ohne Dokument dasteht.
   */
  invoiceDocumentInvalid: 'invoice.document.invalid',
  /**
   * JEDER Abruf eines Belegs (PDF, XML, XRechnung) — GoBD: nachvollziehbar,
   * wer wann welche Fassung bekommen hat. Das Format steht im Detail.
   */
  invoiceDocumentDownloaded: 'invoice.document_downloaded',
  invoiceSent: 'invoice.sent',
  invoiceSendError: 'invoice.send.failed',
  invoicePaymentReminder: 'invoice.payment_reminder',
  /**
   * Zahlung VON HAND vermerkt. Es gibt keinen Kontoabgleich und keine
   * Bankschnittstelle; diesen Eintrag erzeugt ausschliesslich ein Mensch.
   */
  invoicePaymentNoted: 'invoice.payment.noted',
  /** Uebertragungsvermerk an die Buchhaltung, ebenfalls von Hand. */
  invoiceTransferNoted: 'invoice.transfer.noted',
  /**
   * Der Integritaetslauf (naechtlich oder per Abruf) hat an einem festgeschriebenen
   * Beleg eine Abweichung gefunden: Pruefsumme stimmt nicht, Dokument fehlt oder
   * der Nummernkreis hat eine Luecke. Im Detail stehen nur Pruefungsname und
   * Hashes bzw. fehlende Nummern, nie Dokumentinhalt.
   */
  invoiceIntegrityFailed: 'invoice.integrity_failed',
  /**
   * GoBD-Export (Pruefer-Zugriff) erzeugt: Zeitraum und Anzahl im Detail.
   */
  invoiceGobdExport: 'invoice.gobd_export',

  // --- Etappe 5: Einwilligung und Rundmail ---------------------------------
  //
  // R6 gilt hier besonders eng: Der Gegenstand IST eine E-Mail-Adresse. Die
  // Sperrliste aus Etappe 2 entfernt Werte unter `email`, `name`, `token`,
  // `code` und `bestaetigung` von selbst — die Aufrufer uebergeben deshalb
  // ausschliesslich Kennungen (`objektId` = Einwilligung.id), Zaehler,
  // Statuswerte und Fehlerklassen. Wer wann was tat, bleibt vollstaendig
  // nachlesbar, ohne dass eine Adresse im Nachweis steht.

  /** Jemand hat sich ueber das Formular eingetragen. NOCH KEINE Einwilligung. */
  consentSubscribed: 'consent.subscribed',
  /**
   * Eintragung an einer GESPERRTEN Adresse abgewiesen (Spam-Meldung).
   *
   * Muss eine eigene Aktion sein: Es ist der Fall, in dem das Formular
   * absichtlich nichts tut. Ohne Eintrag saehe das aus wie ein Aussetzer.
   */
  consentSubscriptionRefused: 'consent.subscription.refused',
  /** DER VORGANG, AUF DEN ES ANKOMMT: der Klick im Postfach. */
  consentConfirmed: 'consent.confirmed',
  /** Bestaetigungslink unbekannt, verbraucht oder aelter als 72 Stunden. */
  consentConfirmationInvalid: 'consent.confirmation.invalid',
  /** Ein-Klick-Abmeldung. Ohne Anmeldung, ohne Rueckfrage, sofort wirksam. */
  consentUnsubscribed: 'consent.unsubscribed',
  /** Abmeldelink unbekannt. */
  consentUnsubscribeInvalid: 'consent.unsubscribe.invalid',
  /**
   * DIE EINZIGE AUTOMATISCHE LOESCHUNG DES PROJEKTS (Ausnahme von R4):
   * unbestaetigte Eintragungen nach 72 Stunden.
   *
   * Sie MUSS im Nachweis stehen, gerade weil sie automatisch ist — sonst
   * verschwaende ein Datensatz ohne jede Spur, und niemand koennte sagen, ob
   * er je da war.
   */
  consentUnconfirmedDeleted: 'consent.unconfirmed.deleted',
  /** Adresse nach drei erfolglosen Zustellversuchen stillgelegt. */
  consentDeactivated: 'consent.deactivated',
  /**
   * Adresse VON HAND gesperrt ([W4]) — auf einen Widerspruch, der uns
   * ausserhalb des Abmeldelinks erreicht hat, oder auf eine Beschwerde.
   *
   * EIGENE AKTION und nicht dieselbe wie die Ein-Klick-Abmeldung: Im Nachweis
   * muss unterscheidbar bleiben, ob die Person selbst geklickt hat oder ob ein
   * Mensch im CRM es für sie eingetragen hat.
   */
  consentBlockedManually: 'consent.blocked_manually',

  broadcastTemplateCreated: 'broadcast.template.created',
  broadcastTemplateUpdated: 'broadcast.template.updated',
  /** In die Warteschlange eingestellt — noch ist nichts hinausgegangen. */
  broadcastEnqueued: 'broadcast.enqueued',
  broadcastSent: 'broadcast.sent',
  /**
   * VOR DEM VERSAND ABGEWIESEN, weil die Freigabe fehlte (R3).
   *
   * Der wichtigste Eintrag dieses Blocks: Er belegt, dass die Pruefung beim
   * VERSAND stattfindet und nicht bei der Auswahl. Wer zwischen Auswahl und
   * Versand widerruft, hinterlaesst hier die Zeile, die das zeigt.
   */
  broadcastRefused: 'broadcast.refused',
  broadcastSendError: 'broadcast.send.failed',
  broadcastTestSend: 'broadcast.test_send',

  /** Ein Betriebsschalter für alle Instanzen wurde umgestellt (z. B. Feedback). */
  featureFlagChanged: 'feature_flag.changed',

  /** Preisliste (Stufen, Steuersatz, Zahlungsziel) von der Betreiberin geändert. */
  priceUpdated: 'price.updated',

  /**
   * Firmendaten (Rechnungsaussteller), Akzentfarbe oder Logo geändert. Im
   * Eintrag stehen nur Rechtsform, Feldliste und Prüfsumme — keine Inhalte
   * großer Felder (Logo-Bytes).
   */
  issuerUpdated: 'issuer.updated',

  // --- Tresor (Feldverschlüsselung). NIEMALS mit Passphrase, Wiederherstellungs-
  // schlüssel oder Schlüsselmaterial: protokolliert wird nur, DASS etwas geschah.
  vaultInitialized: 'vault.initialized',
  vaultUnlocked: 'vault.unlocked',
  vaultUnlockError: 'vault.unlock.failure',
  vaultLocked: 'vault.locked',
  vaultPassphraseAdded: 'vault.passphrase.added',
  vaultPassphraseChanged: 'vault.passphrase.changed',
  vaultRecoveryRegenerated: 'vault.recovery.regenerated',
  /** Einmal-Lauf nach dem Entsperren: nur Anzahl je Tabelle. */
  vaultEncryptExisting: 'vault.encrypt_existing',
} as const;

export type AuditAction = (typeof AUDIT_ACTION)[keyof typeof AUDIT_ACTION];

export interface AuditEntry {
  /** Benutzer, falls auflösbar. Null bei Fehlversuchen an unbekannten Konten. */
  userId?: string | null;
  /** Klartext-Akteur, z. B. eine E-Mail-Adresse oder `cli:sam`. */
  actor: string;
  action: AuditAction;
  objectType: string;
  objectId?: string | null;
  beforeValue?: unknown;
  afterValue?: unknown;
  ip?: string | null;
  userAgent?: string | null;
}

/**
 * Feldnamen, deren Werte NIEMALS im Audit-Log stehen dürfen (Kleinschreibung,
 * als Teilzeichenkette geprüft).
 *
 * ZWEI GRUPPEN, aus zwei verschiedenen Gründen:
 *
 * 1. ZUGANGSGEHEIMNISSE — TOTP-Geheimnis, Wiederherstellungscode, Merk-Token,
 *    Passkey-Challenge. Wer sie liest, kommt herein.
 * 2. DATEN, DIE JEDE LÖSCHUNG ÜBERLEBEN WÜRDEN — Bankverbindung, SEPA-Mandat,
 *    Freitext ([W3]) und alles, was eine PERSON bezeichnet: Name, Adresse,
 *    E-Mail, Telefon, Funktion ([W4]).
 *
 *    Das Audit-Log wird bewusst nicht mitgelöscht, wenn Kontaktdaten entfernt
 *    werden; es hat keinen Löschweg und soll auch keinen bekommen — ein
 *    Nachweis, der sich ändern lässt, ist keiner. Genau deshalb dürfen diese
 *    Werte gar nicht erst hinein: Sonst stünde der alte Name der
 *    Ansprechpartnerin nach der Löschung weiterhin im Eintrag „Ansprechpartnerin
 *    gewechselt", und die zugesagte Löschung wäre eine Behauptung.
 *
 * Für R6 genügt in beiden Fällen die TATSACHE der Änderung: WELCHES Feld sich
 * geändert hat, steht weiterhin im Eintrag; nur der Wert ist «entfernt». Wer
 * wann was angefasst hat, bleibt damit vollständig nachvollziehbar — und der
 * Akteur steht ohnehin in einer eigenen Spalte, die nicht gesäubert wird.
 */
const FORBIDDEN_FIELD_NAMES = [
  // (1) Zugangsgeheimnisse
  'token',
  'challenge',
  'password',
  'secret',
  'publickey',
  'code',
  // (2) Zahlungsdaten und Freitext ([W3])
  'iban',
  'sepamandate',
  'notes',
  // (3) Personenbezogene Angaben ([W4]). Die Liste deckt alle Felder ab, die
  //     `CompanyService.CONTACT_FIELDS` bei einer Löschung räumt;
  //     `audit.service.spec.ts` prüft das nach, damit sie nicht auseinander
  //     laufen. `contact` und `deputy` decken die Felder der Ansprechperson und
  //     der Stellvertretung (Name, E-Mail, Telefon, Funktion) ab.
  'name',
  'email',
  'phone',
  'street',
  'housenumber',
  'postalcode',
  'city',
  'website',
  'contact',
  'deputy',
  'confirmation',
];

/**
 * ACHTUNG BEIM BENENNEN VON ZÄHLERN: Die Prüfung ist eine TEILZEICHENKETTE,
 * und sie sieht den Feldnamen, nicht seinen Sinn.
 *
 * `geraeumteMailversande` enthält „email" (…chte**Mail**versande) und wurde
 * deshalb geschwärzt — eine reine Anzahl, an der nichts zu schützen war. Der
 * Fehler blieb lange unbemerkt, weil der zugehörige Test nur prüfte, ob der
 * SCHLÜSSEL im Eintrag steht; der stand da, mit «entfernt» daneben. Beide
 * Zähler heißen jetzt `…Versandzeilen`.
 *
 * Die Liste bleibt trotzdem so grob, wie sie ist: Ein zu weit gefasstes
 * Verbot kostet eine Zahl, ein zu enges lässt einen Namen dauerhaft stehen.
 * Wer einen Zähler hinzufügt, prüft seinen Namen gegen diese Liste.
 */

/** Platzhalter anstelle eines entfernten Geheimnisses. */
export const REMOVED = '«entfernt»';

function isForbidden(fieldName: string): boolean {
  const small = fieldName.toLowerCase();
  return FORBIDDEN_FIELD_NAMES.some((forbidden) => small.includes(forbidden));
}

/**
 * Entfernt rekursiv alle Werte, deren Feldname nach einem Geheimnis aussieht.
 *
 * Das ist eine zweite Verteidigungslinie: die Aufrufer übergeben Geheimnisse
 * ohnehin nicht, aber ein späterer Fehlgriff soll nicht dazu führen, dass ein
 * TOTP-Geheimnis dauerhaft im Nachweis steht.
 */
export function sanitizeForAudit(value: unknown, depth = 0): unknown {
  if (depth > 8 || value === null || value === undefined) return null;
  if (Array.isArray(value)) {
    return value.map((entry) => sanitizeForAudit(entry, depth + 1));
  }
  if (typeof value === 'object') {
    const result: Record<string, unknown> = {};
    for (const [field, content] of Object.entries(value as Record<string, unknown>)) {
      result[field] = isForbidden(field)
        ? REMOVED
        : sanitizeForAudit(content, depth + 1);
    }
    return result;
  }
  if (typeof value === 'bigint') return value.toString();
  if (value instanceof Date) return value.toISOString();
  return value;
}

/**
 * Schreibt das Audit-Log (harte Regel R6).
 *
 * Bewusst OHNE eigenes Abfangen von Fehlern: schlägt der Schreibvorgang fehl,
 * scheitert die auslösende Anfrage. Eine Aktion, die nicht protokolliert werden
 * konnte, darf nicht als erfolgreich gelten.
 */
@Injectable()
export class AuditService {
  constructor(private readonly prisma: PrismaService) {}

  async log(
    entry: AuditEntry,
    db: DbClient = this.prisma,
  ): Promise<void> {
    await db.auditLog.create({
      data: {
        userId: entry.userId ?? null,
        actor: entry.actor,
        action: entry.action,
        objectType: entry.objectType,
        objectId: entry.objectId ?? null,
        beforeValue: sanitizeForAudit(entry.beforeValue) as Prisma.InputJsonValue,
        afterValue: sanitizeForAudit(entry.afterValue) as Prisma.InputJsonValue,
        ip: normalizeIp(entry.ip),
        userAgent: entry.userAgent ?? null,
      },
    });
  }

  /**
   * Das Sicherheitsprotokoll — die Leseseite von R6.
   *
   * NUR DIE AUSDRÜCKLICH BENANNTEN AKTIONEN (`SICHERHEITSAKTIONEN`). Der
   * fachliche Betrieb bleibt draussen; zwischen „Notiz geändert" und
   * „Anmeldung mit falschem Passwort" fiele der zweite Eintrag nicht mehr auf.
   *
   * OHNE `vorherWert`/`nachherWert`. Sie sind für die Nachvollziehbarkeit
   * einer ÄNDERUNG gedacht und können Namen enthalten; in einer Liste, die
   * man überfliegt, tragen sie nichts bei. Wer sie braucht, liest die
   * Datenbank.
   *
   * DIE OBERGRENZE IST HART. Ein Protokoll wächst unbegrenzt — eine Antwort
   * ohne Grenze wäre irgendwann ein Speicherproblem und vorher schon
   * unlesbar.
   */
  async securityLog(limit = 100): Promise<SecurityEvent[]> {
    const lines = await this.prisma.auditLog.findMany({
      where: { action: { in: [...SECURITY_ACTIONS] } },
      orderBy: { timestamp: 'desc' },
      take: Math.min(Math.max(limit, 1), 200),
      select: {
        id: true,
        timestamp: true,
        action: true,
        actor: true,
        ip: true,
      },
    });
    return lines.map((line) => ({
      id: line.id,
      timestamp: line.timestamp.toISOString(),
      action: line.action,
      // FEHLT EIN KLARTEXT, steht die Kennung da. Ein Eintrag ohne Text ist
      // immer noch ein Eintrag; ihn wegzulassen wäre eine Lücke.
      text: SECURITY_TEXTS[line.action] ?? line.action,
      actor: line.actor,
      suspicious: SUSPICIOUS_ACTIONS.includes(line.action),
      // Ältere Einträge tragen noch die IPv4-mapped-Form.
      ip: normalizeIp(line.ip),
    }));
  }
}
