import type { IssuerProfile } from '@saas-instant/shared';
import { apiFetch, ApiError, fetchCsrf } from './api-client';
import type {
  LoginOptionsJson,
  RegisterOptionsJson,
  WebauthnResponse,
} from './webauthn';
import { t } from '../i18n';

/**
 * Getippte Fassung des Backend-Vertrags (`/api`). Eine Stelle, an der alle
 * Routen und Antwortformen stehen — die Seiten rufen nur noch diese Funktionen
 * auf und kennen keine Pfade.
 */

export interface User {
  id: string;
  name: string;
  username: string;
  email: string;
  role: string;
}

/**
 * Die drei Arten von zweitem Faktor. Wortgleich mit `FaktorArt` im Backend
 * (`apps/control/src/auth/faktoren.ts`) — die Werte gehen unverändert über die
 * Leitung, deshalb hier dieselbe Schreibweise mit Bindestrich.
 */
export type FactorKind = 'email-code' | 'totp' | 'passkey';

/** Stand der Ersteinrichtung (GET /api/auth/me). */
export interface AccessState {
  user: User;
  passwordSet: boolean;
  passkeyCount: number;
  totpSetUp: boolean;
  /** Ist der Faktor „Code per E-Mail" eingerichtet und bestätigt? */
  emailCodeSetUp: boolean;
  /** Adresse, an die Anmeldecodes gehen. Unmaskiert — es ist die eigene. */
  loginCodeEmail: string;
  /** Alle eingerichteten zweiten Faktoren. Leer heißt: Ersteinrichtung offen. */
  setUpFactors: FactorKind[];
  openRecoveryCodes: number;
}

/** Ein Eintrag der Faktorenliste (GET /api/zugang/faktoren). */
export interface FactorEntry {
  kind: FactorKind;
  label: string;
  setUp: boolean;
  /** Nur bei `email-code`: die hinterlegte Zieladresse. */
  email?: string;
  /** Nur bei `passkey`: wie viele hinterlegt sind. */
  count?: number;
  /** Ließe sich dieser Faktor entfernen, ohne den letzten wegzunehmen? */
  removable: boolean;
}

export interface FactorsOverview {
  factors: FactorEntry[];
  countSetUp: number;
}

export type DeviceKind = 'passkey' | 'trusted_device';

/** Ein Eintrag der Geräteliste. Zeitstempel kommen als ISO-Strings an. */
export interface DeviceEntry {
  id: string;
  kind: DeviceKind;
  label: string;
  createdAt: string;
  lastSeenAt: string | null;
  validUntil: string | null;
}

export interface TotpSetup {
  secretBase32: string;
  otpauthUrl: string;
}

/**
 * Ergebnis von Schritt 1 der Passwortanmeldung.
 *
 * `faktoren` sagt, welche zweiten Faktoren an diesem Konto eingerichtet sind.
 * Enumerationsschutz ist hier kein Thema mehr — die Antwort kommt erst, nachdem
 * Kennung und Passwort bereits als richtig bestätigt wurden.
 */
export type LoginStep1 =
  | { secondFactorRequired: true; factors: FactorKind[] }
  | { user: User };

/**
 * Wartezeit zwischen zwei Code-Anforderungen, in Sekunden.
 *
 * Beim Anmelden liefert der Server sie in `erneutMoeglichInSekunden` mit; beim
 * Einrichten aus einer Sitzung heraus liefert die Erfolgsantwort sie nicht,
 * dort ist diese Konstante die Vorgabe (Spiegel von `CODE_ERNEUT_NACH_MS` im
 * Backend). Verbindlich ist in beiden Fällen der Server: er lehnt zu frühes
 * Anfordern mit `anmeldecode_zu_frueh` samt Restzeit ab.
 */
export const CODE_AGAIN_AFTER_SECONDS = 60;

// --- Anmeldung --------------------------------------------------------------

export function login(
  identifier: string,
  password: string,
): Promise<LoginStep1> {
  return apiFetch<LoginStep1>('/api/auth/login', {
    method: 'POST',
    body: JSON.stringify({ identifier, password }),
  });
}

export function secondFactorTotp(
  code: string,
  deviceRemember: boolean,
): Promise<{ user: User }> {
  return apiFetch<{ user: User }>('/api/auth/login/totp', {
    method: 'POST',
    body: JSON.stringify({ code, deviceRemember }),
  });
}

/**
 * Fordert einen achtstelligen Anmeldecode per E-Mail an.
 *
 * Antwortet IMMER gleich — auch bei unbekannter Kennung, bei nicht
 * eingerichtetem Faktor und innerhalb der 60-Sekunden-Sperre. Die Oberfläche
 * darf daraus also NICHTS ableiten außer „abgeschickt"; `erneutMoeglichInSekunden`
 * ist die konstante Wartezeit, keine Restzeit.
 */
export function loginCodeRequest(
  identifier: string,
): Promise<{ requested: true; againPossibleInSeconds: number }> {
  return apiFetch<{ requested: true; againPossibleInSeconds: number }>(
    '/api/auth/login-code/request',
    { method: 'POST', body: JSON.stringify({ identifier }) },
  );
}

export function secondFactorEmailCode(
  code: string,
  deviceRemember: boolean,
): Promise<{ user: User }> {
  return apiFetch<{ user: User }>('/api/auth/login/email-code', {
    method: 'POST',
    body: JSON.stringify({ code, deviceRemember }),
  });
}

export function secondFactorRecoveryCode(
  code: string,
): Promise<{ user: User }> {
  return apiFetch<{ user: User }>(
    '/api/auth/login/recovery-code',
    { method: 'POST', body: JSON.stringify({ code }) },
  );
}

/**
 * Startet die Passkey-Anmeldung. Bewusst **ohne** Kennung: Der Server wertet
 * sie nicht mehr aus, weil die Länge von `allowCredentials` sonst verriet, ob
 * ein Konto existiert. Der Browser wählt den passenden Passkey selbst.
 */
export function passkeyLoginStart(): Promise<{
  options: LoginOptionsJson;
}> {
  return apiFetch<{ options: LoginOptionsJson }>(
    '/api/auth/passkey/login/start',
    { method: 'POST', body: JSON.stringify({}) },
  );
}

export function passkeyLoginComplete(
  response: WebauthnResponse,
): Promise<{ user: User }> {
  return apiFetch<{ user: User }>(
    '/api/auth/passkey/login/complete',
    { method: 'POST', body: JSON.stringify({ response }) },
  );
}

export function logout(): Promise<{ ok: true }> {
  return apiFetch<{ ok: true }>('/api/auth/logout', { method: 'POST' });
}

export function fetchState(): Promise<AccessState> {
  return apiFetch<AccessState>('/api/auth/me');
}

// --- Notfall-Links ----------------------------------------------------------

export interface EmergencyCheck {
  valid: boolean;
  kind?: 'passkey' | 'password';
  username?: string;
  /**
   * Restgültigkeit des Links in Sekunden. Der Client zählt selbst herunter —
   * ein Zeitstempel wäre von der Uhr des Browsers abhängig.
   *
   * Optional getippt, damit die Oberfläche auch gegen ein Backend läuft, das
   * das Feld noch nicht liefert: dann entfällt der Countdown und es bleibt bei
   * der festen Angabe „gilt 15 Minuten ab dem Erzeugen". Es wird nichts
   * geschätzt und nichts erfunden.
   */
  secondsRemaining?: number;
}

export function emergencyCheck(token: string): Promise<EmergencyCheck> {
  return apiFetch<EmergencyCheck>('/api/auth/emergency/check', {
    method: 'POST',
    body: JSON.stringify({ token }),
  });
}

export function emergencyEnrollmentStart(
  token: string,
): Promise<{ valid: boolean; options?: RegisterOptionsJson }> {
  return apiFetch<{ valid: boolean; options?: RegisterOptionsJson }>(
    '/api/auth/emergency/enrollment/start',
    { method: 'POST', body: JSON.stringify({ token }) },
  );
}

export function emergencyEnrollmentComplete(
  token: string,
  response: WebauthnResponse,
): Promise<{ user: User }> {
  return apiFetch<{ user: User }>(
    '/api/auth/emergency/enrollment/complete',
    { method: 'POST', body: JSON.stringify({ token, response }) },
  );
}

export function emergencyPasswordSet(
  token: string,
  password: string,
): Promise<{ ok: true; username: string }> {
  return apiFetch<{ ok: true; username: string }>(
    '/api/auth/emergency/password/set',
    { method: 'POST', body: JSON.stringify({ token, password }) },
  );
}

// --- Eigener Zugang ---------------------------------------------------------

/**
 * Nachweis des zweiten Faktors vor dem Anlegen eines Passkeys.
 *
 * Ein gestohlenes Sitzungs-Cookie soll nicht reichen, um sich einen eigenen,
 * einstufigen Dauerzugang einzurichten. Genau eines der beiden Felder wird
 * gesetzt — Passwort ODER Code aus der Authenticator-App.
 */
export interface SecondFactorEvidence {
  currentPassword?: string;
  totpCode?: string;
}

export function passkeyEnrollmentStart(
  evidence?: SecondFactorEvidence,
): Promise<{ options: RegisterOptionsJson }> {
  return apiFetch<{ options: RegisterOptionsJson }>(
    '/api/access/passkey/start',
    { method: 'POST', body: JSON.stringify(evidence ?? {}) },
  );
}

export function passkeyEnrollmentComplete(
  response: WebauthnResponse,
): Promise<{ passkeyId: string; label: string }> {
  return apiFetch<{ passkeyId: string; label: string }>(
    '/api/access/passkey/complete',
    { method: 'POST', body: JSON.stringify({ response }) },
  );
}

/**
 * Setzt oder ändert das eigene Passwort.
 *
 * `aktuellesPasswort` entfällt nur, solange am Konto noch keines hinterlegt ist
 * (`passwordSet: false` aus `GET /api/auth/me`) — das ist der Fall im
 * ersten Schritt der Ersteinrichtung. Sonst ist es Pflicht.
 *
 * Achtung, Zwangsfolge: der Server entwertet dabei alle Merk-Geräte.
 */
export function passwordSet(
  newPassword: string,
  currentPassword?: string,
): Promise<{ ok: true }> {
  return apiFetch<{ ok: true }>('/api/access/password', {
    method: 'POST',
    body: JSON.stringify(
      currentPassword === undefined
        ? { newPassword }
        : { currentPassword, newPassword },
    ),
  });
}

/**
 * Erzeugt ein neues TOTP-Geheimnis samt QR-Code.
 *
 * Das Geheimnis ist bis `totpBestaetigen` nur VORLÄUFIG hinterlegt — ein
 * abgebrochener Vorgang lässt einen bereits eingerichteten Authenticator
 * unberührt. Die Oberfläche darf den Faktor deshalb erst nach der Bestätigung
 * als eingerichtet zeigen.
 *
 * Verlangt denselben Zweitfaktor-Nachweis wie die übrigen ändernden Routen,
 * sofern die Sitzung nicht frisch ist: Sonst könnte sich ein erbeutetes Cookie
 * selbst einen zweiten Faktor setzen und ihn anschließend als Nachweis für
 * alles Weitere benutzen.
 */
export function totpSetup(
  evidence?: SecondFactorEvidence,
): Promise<TotpSetup> {
  return apiFetch<TotpSetup>('/api/access/totp/setup', {
    method: 'POST',
    body: JSON.stringify(evidence ?? {}),
  });
}

export function totpConfirm(code: string): Promise<{ ok: true }> {
  return apiFetch<{ ok: true }>('/api/access/totp/confirm', {
    method: 'POST',
    body: JSON.stringify({ code }),
  });
}

/** Welche zweiten Faktoren sind eingerichtet, und welcher ist entfernbar? */
export function fetchFactors(): Promise<FactorsOverview> {
  return apiFetch<FactorsOverview>('/api/access/factors');
}

/**
 * Schickt einen achtstelligen Bestätigungscode an die gewünschte Adresse.
 * Deckt Einrichten UND Adressänderung ab — ohne `email` geht der Code an die
 * bereits hinterlegte Adresse.
 *
 * Übernommen wird die Adresse erst mit `emailCodeBestaetigen`; ein Tippfehler
 * kann einen aktiven Faktor also nicht auf ein unerreichbares Postfach
 * umbiegen.
 *
 * Verlangt zusätzlich einen Zweitfaktor-Nachweis (Passwort ODER TOTP-Code) —
 * sonst ließe sich mit einem erbeuteten Sitzungs-Cookie die Zustelladresse des
 * zweiten Faktors auf ein fremdes Postfach umbiegen. Bei einer Sitzung unter
 * 10 Minuten entfällt er; die Oberfläche versucht es deshalb erst ohne und
 * fragt erst nach, wenn der Server ablehnt.
 */
export function emailCodeSetup(
  email?: string,
  evidence?: SecondFactorEvidence,
): Promise<{ email: string; secondsValid: number }> {
  return apiFetch<{ email: string; secondsValid: number }>(
    '/api/access/factors/email-code/setup',
    {
      method: 'POST',
      body: JSON.stringify({
        ...(email === undefined ? {} : { email }),
        ...(evidence ?? {}),
      }),
    },
  );
}

/** Bestätigt den Einrichtungscode; erst danach gilt der Faktor. */
export function emailCodeConfirm(
  code: string,
): Promise<{ ok: true; email: string }> {
  return apiFetch<{ ok: true; email: string }>(
    '/api/access/factors/email-code/confirm',
    { method: 'POST', body: JSON.stringify({ code }) },
  );
}

/**
 * Entfernt einen zweiten Faktor. Passkeys laufen nicht hierüber, sondern
 * einzeln über `widerrufeGeraet`.
 *
 * Verlangt denselben Zweitfaktor-Nachweis wie das Hinzufügen (Passwort ODER
 * TOTP-Code), sofern die Sitzung nicht frisch ist: Etwas wegzunehmen schwächt
 * den Zugang und darf nicht schlechter geschützt sein als das Hinzufügen.
 *
 * Zwangsfolge: der Server entwertet dabei alle Merk-Geräte. Wer den letzten
 * Faktor entfernen will, bekommt `letzter_faktor` (409) — die Oberfläche darf
 * das vorher verhindern, entschieden wird es serverseitig.
 */
export function factorRemove(
  kind: 'totp' | 'email-code',
  evidence?: SecondFactorEvidence,
): Promise<{ invalidatedTrustedDevices: number }> {
  return apiFetch<{ invalidatedTrustedDevices: number }>(
    `/api/access/factors/${kind}`,
    { method: 'DELETE', body: JSON.stringify(evidence ?? {}) },
  );
}

/**
 * Erzeugt acht neue Wiederherstellungscodes und entwertet alle bisherigen.
 *
 * Verlangt denselben Nachweis wie die übrigen ändernden Routen: Ein erbeutetes
 * Cookie könnte sonst acht gültige Codes erzeugen und dabei die acht der
 * Betreiberin entwerten.
 */
export function recoveryCodesNew(
  evidence?: SecondFactorEvidence,
): Promise<{ codes: string[] }> {
  return apiFetch<{ codes: string[] }>('/api/access/recovery-codes', {
    method: 'POST',
    body: JSON.stringify(evidence ?? {}),
  });
}

export function fetchDevices(): Promise<{ devices: DeviceEntry[] }> {
  return apiFetch<{ devices: DeviceEntry[] }>('/api/access/devices');
}

/**
 * Entwertet alle Geräte auf einmal. Wird serverseitig so erweitert, dass auch
 * laufende Sitzungen enden — danach kann die eigene Sitzung ungültig sein, und
 * die Oberfläche landet über den regulären 401-Weg auf der Anmeldeseite.
 */
export function signOutAllDevices(): Promise<{ invalidated: number }> {
  return apiFetch<{ invalidated: number }>(
    '/api/access/devices/sign-out-all',
    { method: 'POST', body: JSON.stringify({}) },
  );
}

/**
 * Widerruft einen Eintrag der Geräteliste.
 *
 * Ein **Passkey** ist ein Faktor: Sein Widerruf verlangt denselben Nachweis wie
 * das Entfernen von TOTP oder E-Mail-Code. Ein **Merk-Gerät** dagegen nimmt
 * niemandem etwas weg — es entzieht nur eine Abkürzung und kommt bewusst ohne
 * Nachweis aus.
 */
export function revokeDevice(
  id: string,
  evidence?: SecondFactorEvidence,
): Promise<{ label: string }> {
  return apiFetch<{ label: string }>(
    `/api/access/devices/${encodeURIComponent(id)}`,
    { method: 'DELETE', body: JSON.stringify(evidence ?? {}) },
  );
}

// ---------------------------------------------------------------------------
// Etappe 2 — Organisationen, Verlauf, Aufgaben
//
// Die Typen sind die getippte Fassung dessen, was das Backend TATSÄCHLICH
// liefert (`organisation.antwort.ts`, `notiz.service.ts`, `aufgaben.typen.ts`),
// nicht die im Entwurf vorgeschlagene Wunschform. Wo beides auseinandergeht,
// gilt der Server — er ist bereits gebaut und wird in dieser Etappe nicht
// angefasst.
// ---------------------------------------------------------------------------

/** Die acht Status einer Organisation, wortgleich mit dem Prisma-Enum. */
export type CompanyStatus =
  | 'inquiry'
  | 'demo'
  | 'pilot_approved'
  | 'pilot_running'
  | 'paying'
  | 'review_pending'
  | 'dormant'
  | 'ended';

/** Der Zahlungsrhythmus — die drei, die die Webseite anbietet. */
export type PaymentInterval = 'yearly' | 'half_yearly' | 'monthly';

/**
 * WIE gezahlt wird — getrennt vom Rhythmus, weil es zwei Fragen sind.
 *
 * Die Webseite bindet beides aneinander: „Halbjaehrlich und jaehrlich per
 * Ueberweisung oder Lastschrift, monatlich per Lastschrift." Durchgesetzt
 * wird das serverseitig, nicht nur im Formular.
 */
export type PaymentMethod = 'direct_debit' | 'bank_transfer';

export type Source = 'form' | 'phone' | 'referral' | 'event';

export type ConsentStatus =
  | 'unconfirmed'
  | 'confirmed'
  | 'unsubscribed'
  | 'hard_bounced'
  | 'spam_reported';

/**
 * Eine Zeile der Organisationsliste.
 *
 * Bewusst schmaler als das Detailobjekt: Bank- und Rechnungsdaten gehören
 * nicht in eine Übersicht, die beim Öffnen der Seite ohnehin geladen wird.
 * `erstelltAm` ist ein technischer Zeitstempel (ISO), alle übrigen
 * Datumsangaben sind Tagesdaten `YYYY-MM-DD`.
 */
export interface CompanyShort {
  id: string;
  name: string;
  status: CompanyStatus;
  city: string | null;
  contactName: string | null;
  contactEmail: string | null;
  reviewDueDate: string | null;
  lastStatusChangeAt: string | null;
  createdAt: string;
  /** Status der Kundeninstanz — `null`, wenn es keine gibt. */
  instanceStatus: InstanceStatus | null;
  /** Noch offene Rechnungsbeträge in Cent. `0` heisst: nichts offen. */
  openAmountCent: number;
  /** Ist davon etwas überfällig? Färbt den Betrag rot. */
  openOverdue: boolean;
}

/** Art der Rechnungsempfängerin: Unternehmen, Behörde (Leitweg-ID Pflicht) oder Privatperson. */
export type BuyerType = 'business' | 'authority' | 'consumer';

/** Das vollständige Organisationsobjekt der Detailseite. */
export interface Company {
  id: string;
  name: string;
  legalForm: string | null;
  website: string | null;

  street: string | null;
  houseNumber: string | null;
  postalCode: string | null;
  city: string | null;
  country: string | null;

  billingName: string | null;
  billingStreet: string | null;
  billingHouseNumber: string | null;
  billingPostalCode: string | null;
  billingCity: string | null;
  billingCountry: string | null;
  billingEmail: string | null;

  contactName: string | null;
  contactEmail: string | null;
  contactPhone: string | null;
  contactRole: string | null;

  deputyName: string | null;
  deputyEmail: string | null;
  deputyPhone: string | null;
  deputyRole: string | null;

  status: CompanyStatus;
  lastStatusChangeAt: string | null;

  priceTier: string | null;

  /** E-Rechnung: Art der Empfängerin und ihre Kennungen (ZUGFeRD / XRechnung). */
  buyerType: BuyerType;
  vatId: string | null;
  /** Leitweg-ID bzw. Bestellreferenz (BT-10). */
  buyerReference: string | null;
  electronicAddress: string | null;
  electronicAddressScheme: string | null;

  paymentInterval: PaymentInterval | null;
  paymentMethod: PaymentMethod | null;

  /**
   * Ob Zahlungsdaten hinterlegt sind — NICHT die Daten selbst.
   *
   * IBAN, SEPA-Mandat und der abweichende Betrag stehen bewusst nicht mehr in
   * dieser Antwort: Mit einem 25 Stunden alten Sitzungs-Cookie war die
   * Bankverbindung sonst an einer gewöhnlichen Detailansicht mitzulesen. Wer
   * sie sehen will, geht über `holeZahlungsdaten` und weist sich dabei ein
   * zweites Mal aus.
   */
  paymentDetailsStored: boolean;

  pilotDecisionDate: string | null;
  /** ABGELEITET (Beschlussdatum + 7 Monate). Nur lesen, nie senden. */
  reviewDueDate: string | null;
  /**
   * Quittung der Überprüfung; `null` heißt „steht noch offen".
   *
   * Gesetzt wird sie serverseitig, wenn der Status `ueberpruefung_offen`
   * VERLASSEN wird — das Weiterstellen IST die Erledigung. Einen eigenen Knopf
   * dafür gibt es bewusst nicht.
   */
  reviewDoneAt: string | null;
  instanceStartDate: string | null;

  newsletterConsentStatus: ConsentStatus | null;
  source: Source | null;
  notes: string | null;

  createdAt: string;
  updatedAt: string;
}

export interface CompanyPage {
  companies: CompanyShort[];
  total: number;
  page: number;
  perPage: number;
  /**
   * Menge je Status — die Zahlen der Filterchips.
   *
   * Sie beachten die SUCHE, aber nicht den Statusfilter: Sonst zeigte jeder
   * Chip ausser dem gewählten eine Null.
   */
  countPerStatus: Record<CompanyStatus, number>;
}

export interface CompanyFilter {
  /**
   * Einer oder mehrere Status. Mehrere, weil die Filterleiste
   * `pilot_beschlossen` und `pilot_laufend` zu einem Chip „Pilot" bündelt.
   */
  status?: CompanyStatus[];
  search?: string;
  page?: number;
  perPage?: number;
}

/**
 * Änderbare Stammdaten.
 *
 * `null` LEERT ein Feld, `undefined` lässt es unangetastet — genau die
 * Unterscheidung, die `stammdatenNachPrisma` im Backend trifft. `name` ist
 * deshalb `string | undefined` und niemals `null`: er ist das einzige
 * Pflichtfeld und darf nicht geleert werden.
 *
 * NICHT enthalten, weil der Server sie hier ausdrücklich zurückweist:
 * `status` (eigener Endpunkt), `ansprechpartnerin*` (eigener Endpunkt),
 * `ueberpruefungsterminAm` (abgeleitet) und seit der Nacharbeit auch
 * `iban`, `sepaMandatsreferenz`, `sepaMandatsdatum`, `abweichenderBetrag`
 * (eigener Endpunkt hinter dem zweiten Faktor).
 */
export interface CompanyChange {
  name?: string;
  legalForm?: string | null;
  website?: string | null;
  street?: string | null;
  houseNumber?: string | null;
  postalCode?: string | null;
  city?: string | null;
  country?: string | null;
  billingName?: string | null;
  billingStreet?: string | null;
  billingHouseNumber?: string | null;
  billingPostalCode?: string | null;
  billingCity?: string | null;
  billingCountry?: string | null;
  billingEmail?: string | null;
  deputyName?: string | null;
  deputyEmail?: string | null;
  deputyPhone?: string | null;
  deputyRole?: string | null;
  priceTier?: string | null;
  buyerType?: BuyerType;
  vatId?: string | null;
  buyerReference?: string | null;
  electronicAddress?: string | null;
  electronicAddressScheme?: string | null;
  paymentInterval?: PaymentInterval | null;
  paymentMethod?: PaymentMethod | null;
  pilotDecisionDate?: string | null;
  instanceStartDate?: string | null;
  source?: Source | null;
  notes?: string | null;
}

/** Beim Anlegen kommen Name (Pflicht) und die Ansprechpartnerin dazu. */
export interface CompanyCreation extends CompanyChange {
  name: string;
  contactName?: string;
  contactEmail?: string;
  contactPhone?: string;
  contactRole?: string;
}

/** Der Wechsel ERSETZT den Datensatz — nicht gesendete Felder werden geleert. */
export interface ContactPersonChange {
  name: string;
  email?: string;
  phone?: string;
  functionValue?: string;
}

/**
 * Ein Eintrag des gemeinsamen Verlaufs.
 *
 * Notizen von Hand und systemerzeugte Einträge (Statuswechsel, Wechsel der
 * Ansprechpartnerin, erneute Anfrage über das Formular) sind DIESELBE
 * Datenart und kommen aus derselben Abfrage — genau deshalb ist der Verlauf
 * eine Liste und nicht drei. `datum` ist das fachliche Tagesdatum,
 * `erstelltAm` der technische Zeitstempel des Schreibens.
 */
export interface HistoryEntry {
  id: string;
  companyId: string;
  date: string;
  text: string;
  bySystem: boolean;
  createdAt: string;
}

/**
 * Die Aufgabenarten, die das Backend ableitet — wortgleich mit
 * `AUFGABEN_ARTEN` in `apps/control/src/aufgaben/aufgaben.typen.ts`.
 *
 * Etappe 3 hat die Liste um fünf Arten verlängert. Jede neue Art braucht einen
 * Eintrag in `AUFGABEN_ICON` und `AUFGABEN_BEZEICHNUNG` (`lib/aufgaben.ts`);
 * beide sind `Record<AufgabenArt, …>` und lassen eine Lücke nicht durch die
 * Typprüfung.
 */
export type TaskKind =
  | 'inquiry_unanswered'
  | 'review_date'
  | 'status_change_automatic'
  | 'deletion_suggestion'
  | 'price_info_missing'
  | 'audit_retention'
  // --- Etappe 3: Instanzen ---
  | 'backup_missing'
  | 'metrics_query_failed'
  | 'reconciliation_deviation'
  | 'no_entry_for_long'
  | 'company_name_mismatch'
  // --- Etappe 4: Rechnungen ---
  | 'invoice_overdue'
  // Die beiden Arten, die im Auftrag zu Etappe 4 stehen und dort noch fehlten.
  // Sie stehen in dieser Union VOR ihrer Registrierung im Backend — die
  // umgekehrte Reihenfolge hätte die Startseite an dem Tag ausgeschaltet, an
  // dem die erste Aufgabe dieser Art entsteht.
  | 'invoice_due'
  | 'tier_check'
  // Ohne Organisationsbezug: ein gestörter Postausgang der Verwaltung oder
  // der Instanzen.
  | 'outbox_disrupted'
  // GoBD: Beleg weicht von seiner Prüfsumme ab / Lücke im Nummernkreis.
  | 'document_tampered'
  // Ziel eingerichtet, aber seit 3 Tagen keine Sicherung der Verwaltung gemeldet.
  | 'control_backup_missing';

export type Urgency = 'high' | 'medium' | 'low';

export type ActionKind =
  | 'company_open'
  | 'status_change'
  | 'deletion_check'
  | 'price_agree'
  | 'retention_check'
  // Führt zur Rechnung und LÖST NICHTS AUS — weder Mahnung noch
  // Statusänderung; der Zahlungseingang wird von Hand vermerkt.
  | 'payment_check'
  // Führt zur Rechnungsliste der Organisation. Sie LEGT NICHTS AN (R5): Die
  // Rechnung schreibt die Betreiberin, mit Zeitraum und Beträgen vor Augen.
  | 'invoice_create'
  // Der einzige KNOPF: löst eine Probe des Postausgangs aus (anmelden, keine
  // Mail). `ziel` ist leer.
  | 'outbox_check';

export interface Action {
  kind: ActionKind;
  label: string;
  /** Ziel innerhalb der Anwendung, z. B. `/companies/<id>`. */
  target: string;
}

export interface Task {
  kind: TaskKind;
  dueAt: string;
  urgency: Urgency;
  title: string;
  reason: string;
  action: Action;
  /**
   * Bezug zur Organisation — OPTIONAL.
   *
   * Nicht jede Aufgabe betrifft eine einzelne Organisation: Die
   * Aufbewahrungsfrist des Audit-Logs gilt für den ganzen Bestand. Jeder
   * Zugriff hier muss das aushalten, sonst stirbt die Startseite an dem Tag,
   * an dem der erste Audit-Eintrag drei Jahre alt wird.
   */
  company?: { id: string; name: string; status: CompanyStatus };
}

/**
 * Meldung über abgeschnittene Aufgaben.
 *
 * Der Server begrenzt jede Art auf `grenzeJeArt` Einträge und sagt hier, wie
 * viele es darüber hinaus gäbe. Das gehört sichtbar in die Oberfläche: Eine
 * Liste, die stillschweigend abschneidet, behauptet Vollständigkeit.
 */
export interface TaskTruncation {
  kind: TaskKind;
  shown: number;
  further: number;
}

/**
 * Eine Coolify-Anwendung OHNE passenden CRM-Eintrag.
 *
 * Sie hat keine Organisation, an die sich eine `Aufgabe` hängen ließe, und
 * kommt deshalb als eigene Liste in derselben Antwort — nicht als Aufgabe mit
 * erfundenem Ziel.
 */
export interface OrphanedApplication {
  subdomain: string;
  coolifyUrl: string | null;
  detectedAt: string;
}

/**
 * Wann der Abgleich zuletzt lief und ob er durchlief.
 *
 * EIN LEERER BEFUND UND EIN AUSGEFALLENER LAUF SIND NICHT DASSELBE. Ohne diese
 * Angabe läse die Oberfläche „keine Abweichungen", obwohl seit Tagen nichts
 * gemessen wurde — die beruhigendste aller falschen Auskünfte.
 */
export interface ReconciliationState {
  lastAt: string | null;
  successful: boolean;
  message: string | null;
}

export interface TaskList {
  tasks: Task[];
  shortened: TaskTruncation[];
  orphanedApplications: OrphanedApplication[];
  /** `day` = heute laut Server, `seit` = ab wann automatische Wechsel zählen. */
  state: {
    day: string;
    since: string;
    limitPerKind: number;
    reconciliation: ReconciliationState;
  };
}

function searchParams(filter: CompanyFilter): string {
  const p = new URLSearchParams();
  if (filter.status && filter.status.length > 0) {
    // Kommagetrennt — der Server zerlegt es wieder. Ein wiederholter
    // Parameter waere die Alternative, aber die URL bliebe schlechter
    // lesbar, und geteilte Links sind hier ein ausdrueckliches Ziel.
    p.set('status', filter.status.join(','));
  }
  if (filter.search && filter.search.trim() !== '') p.set('search', filter.search.trim());
  if (filter.page !== undefined) p.set('page', String(filter.page));
  if (filter.perPage !== undefined) p.set('perPage', String(filter.perPage));
  const text = p.toString();
  return text === '' ? '' : `?${text}`;
}

export function fetchCompanies(
  filter: CompanyFilter = {},
): Promise<CompanyPage> {
  return apiFetch<CompanyPage>(
    `/api/companies${searchParams(filter)}`,
  );
}

/** Eine Zeile der Übersicht „Instanzen" — nur, was die Liste zeigt. */
export interface InstanceListEntry {
  id: string;
  subdomain: string;
  url: string;
  status: InstanceStatus;
  createdAt: string;
  company: { id: string; name: string };
}

/** Alle Instanzen, sortiert nach Subdomain. */
export function fetchInstances(): Promise<InstanceListEntry[]> {
  return apiFetch<InstanceListEntry[]>('/api/instances');
}

export function fetchCompany(id: string): Promise<Company> {
  return apiFetch<Company>(
    `/api/companies/${encodeURIComponent(id)}`,
  );
}

/** Eine Anfrage über das Formular der Webseite und was darauf passierte. */
export interface CompanyInquiry {
  kind: 'demo' | 'pilot';
  /** `null` = vor dem 15.09.2026 eingegangen, Ergebnis nicht erfasst. */
  outcome:
    | 'credentials_sent'
    | 'confirmation_sent'
    | 'already_triggered'
    | 'quota_exhausted'
    | 'send_failed'
    | null;
  receivedAt: string;
}

export function fetchInquiries(
  id: string,
): Promise<{ inquiries: CompanyInquiry[] }> {
  return apiFetch<{ inquiries: CompanyInquiry[] }>(
    `/api/companies/${encodeURIComponent(id)}/inquiries`,
  );
}

export function createCompany(
  data: CompanyCreation,
): Promise<Company> {
  return apiFetch<Company>('/api/companies', {
    method: 'POST',
    body: JSON.stringify(data),
  });
}

/* --- Funktionsschalter (Einstellungen → Funktionen) ---------------------- */

/** Ein Betriebsschalter, der für alle Kundeninstanzen gilt. */
export interface FeatureFlag {
  key: string;
  label: string;
  description: string;
  active: boolean;
  defaultValue: boolean;
  /** Technischer Zeitstempel (ISO) oder `null`, wenn nie umgestellt. */
  changedAt: string | null;
}

export function fetchFeatureFlags(): Promise<FeatureFlag[]> {
  return apiFetch<FeatureFlag[]>('/api/feature-flags');
}

export function setFeatureFlag(
  key: string,
  active: boolean,
): Promise<FeatureFlag> {
  return apiFetch<FeatureFlag>(
    `/api/feature-flags/${encodeURIComponent(key)}`,
    { method: 'PUT', body: JSON.stringify({ active }) },
  );
}

/** Ändert NUR die mitgeschickten Felder — bewusst je Karte, nie die ganze Seite. */
export function updateCompany(
  id: string,
  change: CompanyChange,
): Promise<Company> {
  return apiFetch<Company>(
    `/api/companies/${encodeURIComponent(id)}`,
    { method: 'PATCH', body: JSON.stringify(change) },
  );
}

/**
 * Eigener Endpunkt, kein Feld-Update: Der Server schreibt dabei die
 * systemerzeugte Notiz und den Audit-Eintrag. Steht der Status schon so,
 * antwortet er mit `409 status_unveraendert`.
 */
/** Was aus dem automatischen Versand des Aufnahmelinks wurde. */
export interface IntakeLinkSend {
  sent: boolean;
  email: string;
  reason?: 'no_address' | 'send_failed';
}

/**
 * Wechselt den Status.
 *
 * Die Antwort traegt `aufnahmelink` mit: Beim Wechsel auf `pilot_beschlossen`
 * geht der Aufnahmelink automatisch hinaus, und die Oberflaeche sagt danach
 * EINMAL, ob er ankam. `null` heisst: bei diesem Wechsel war nichts zu tun.
 */
export function changeCompanyStatus(
  id: string,
  status: CompanyStatus,
): Promise<Company & { intakeLink: IntakeLinkSend | null }> {
  return apiFetch<Company & { intakeLink: IntakeLinkSend | null }>(
    `/api/companies/${encodeURIComponent(id)}/status`,
    { method: 'POST', body: JSON.stringify({ status }) },
  );
}

/** Ebenfalls eigener Endpunkt: der Datensatz wird ersetzt, nicht ergänzt. */
export function changeContactPerson(
  id: string,
  data: ContactPersonChange,
): Promise<Company> {
  return apiFetch<Company>(
    `/api/companies/${encodeURIComponent(id)}/contact-person`,
    { method: 'POST', body: JSON.stringify(data) },
  );
}

export function fetchHistory(
  companyId: string,
): Promise<{ notes: HistoryEntry[] }> {
  return apiFetch<{ notes: HistoryEntry[] }>(
    `/api/notes?companyId=${encodeURIComponent(companyId)}`,
  );
}

export function addNote(
  companyId: string,
  text: string,
): Promise<HistoryEntry> {
  return apiFetch<HistoryEntry>('/api/notes', {
    method: 'POST',
    body: JSON.stringify({ companyId, text }),
  });
}

/**
 * Ändert eine selbst erfasste Notiz. Für eine systemerzeugte antwortet der
 * Server mit `409 notiz_vom_system` — die Oberfläche bietet den Weg dorthin
 * gar nicht erst an, verlässt sich darauf aber nicht.
 */
export function updateNote(
  id: string,
  text: string,
): Promise<HistoryEntry> {
  return apiFetch<HistoryEntry>(`/api/notes/${encodeURIComponent(id)}`, {
    method: 'PATCH',
    body: JSON.stringify({ text }),
  });
}

/**
 * Die Aufgaben des Dashboards. Sie werden bei jeder Abfrage neu abgeleitet und
 * nirgends gespeichert; es gibt deshalb auch keinen Endpunkt, der eine Aufgabe
 * abhakt.
 *
 * `seit` sagt, ab wann automatische Statuswechsel gemeldet werden. Ohne Angabe
 * gilt serverseitig eine Woche.
 */
/** Stand eines Postausgangs, wie ihn `POST /api/postausgang/pruefen` liefert. */
export interface OutboxSituation {
  role: 'admin' | 'instances';
  state: 'in_ordnung' | 'gestoert' | 'nicht_eingerichtet' | 'ungeprueft';
  checkedAt: string | null;
  disruptedSince: string | null;
  errorClass: string | null;
  detectedBy: 'probe' | 'send' | null;
}

/** Prüft beide Postausgänge (anmelden, keine Mail) und gibt den Stand zurück. */
export function checkOutbox(): Promise<OutboxSituation[]> {
  return apiFetch<OutboxSituation[]>('/api/outbox/check', { method: 'POST' });
}

export function fetchTasks(since?: string): Promise<TaskList> {
  const attachment = since ? `?since=${encodeURIComponent(since)}` : '';
  return apiFetch<TaskList>(`/api/tasks${attachment}`);
}

/**
 * Die zwei Zahlen der Seitenleiste.
 *
 * Nur bei Handlungsbedarf: `aufgabenDringend` ist rot, `rechnungenOffen`
 * bernstein. Steht dort eine 0, zeigt die Leiste gar keine Pille — eine
 * Null in einem roten Kreis ist eine Warnung ohne Anlass.
 */
export interface NavigationCounters {
  tasksUrgent: number;
  invoicesOpen: number;
}

export function fetchNavigationCounters(): Promise<NavigationCounters> {
  return apiFetch<NavigationCounters>('/api/navigation/counters');
}

// ---------------------------------------------------------------------------
// Vertrauliche Vorgänge — hinter dem zweiten Faktor
//
// Alle drei sind POST oder PATCH, auch das Anzeigen. Das ist keine Nachlässig-
// keit: Der Server liest den Nachweis (`aktuellesPasswort` ODER `totpCode`)
// aus dem Rumpf, und ein GET hat keinen. Bei einer Sitzung unter zehn Minuten
// lässt der Server den Nachweis weg — deshalb ruft die Oberfläche immer
// zuerst OHNE ihn auf und fragt erst bei `401` nach.
// ---------------------------------------------------------------------------

/** Bankverbindung und Mandat. Erscheinen NICHT in der Detailansicht. */
export interface PaymentDetails {
  companyId: string;
  iban: string | null;
  sepaMandateReference: string | null;
  sepaMandateDate: string | null;
  /** Decimal(10,2) als Zeichenkette — Geld geht nie über Gleitkomma. */
  customAmount: string | null;
}

/** Beim Schreiben ist der Betrag eine Zahl; leere Felder werden weggelassen. */
export interface PaymentDetailsChange {
  iban?: string;
  sepaMandateReference?: string;
  sepaMandateDate?: string;
  customAmount?: number;
}

export function fetchPaymentDetails(
  id: string,
  evidence?: SecondFactorEvidence,
): Promise<PaymentDetails> {
  return apiFetch<PaymentDetails>(
    `/api/companies/${encodeURIComponent(id)}/payment-details/reveal`,
    { method: 'POST', body: JSON.stringify(evidence ?? {}) },
  );
}

/**
 * Holt den Einrichtungslink einer Kundeninstanz — mit zweitem Faktor.
 *
 * POST auch fuers blosse Anzeigen: Der Nachweis steht im Rumpf, ein GET haette
 * keinen. Der Zugriff wird serverseitig protokolliert.
 */
export function fetchInvitationLink(
  companyId: string,
  evidence?: SecondFactorEvidence,
): Promise<{ invitationLink: string | null }> {
  return apiFetch<{ invitationLink: string | null }>(
    `/api/companies/${encodeURIComponent(companyId)}/instance/invitation-link/reveal`,
    { method: 'POST', body: JSON.stringify(evidence ?? {}) },
  );
}

/** Was aus dem Versand des Einrichtungslinks wurde. */
export interface InvitationLinkSend {
  sent: boolean;
  email: string;
  reason?: 'no_address' | 'no_link' | 'send_failed';
}

/**
 * Schickt den Einrichtungslink an die hinterlegte Ansprechpartnerin — mit
 * zweitem Faktor, wie das Anzeigen. Die Adresse kommt NICHT von hier: Der
 * Server nimmt die im Datensatz, sonst liesse sich der Link umlenken.
 */
export function sendInvitationLink(
  companyId: string,
  evidence?: SecondFactorEvidence,
): Promise<InvitationLinkSend> {
  return apiFetch<InvitationLinkSend>(
    `/api/companies/${encodeURIComponent(companyId)}/instance/invitation-link/send`,
    { method: 'POST', body: JSON.stringify(evidence ?? {}) },
  );
}

/**
 * Ruft die Kennzahlen dieser einen Instanz sofort ab, statt bis 04:00 zu
 * warten. `null`, wenn es keine aktive Instanz gibt.
 */
export function fetchMetrics(
  companyId: string,
): Promise<{ successful: boolean; errorKind: string | null } | null> {
  return apiFetch<{ successful: boolean; errorKind: string | null } | null>(
    `/api/companies/${encodeURIComponent(companyId)}/instance/fetch-metrics`,
    { method: 'POST' },
  );
}

/** Zustand des Aufnahmezugangs. OHNE zweiten Faktor — er nennt nie den Token. */
export interface IntakeAccessState {
  present: boolean;
  expiresAt: string | null;
  redeemedAt: string | null;
  lastSentAt: string | null;
  sendCount: number;
  expired: boolean;
  address: string | null;
  completedAt: string | null;
  /** Was noch fehlt — aus derselben Quelle wie Formular und Statuswechsel. */
  missing: { field: string; label: string }[];
}

export function fetchIntakeAccess(
  companyId: string,
): Promise<IntakeAccessState> {
  return apiFetch<IntakeAccessState>(
    `/api/companies/${encodeURIComponent(companyId)}/intake-access`,
  );
}

/**
 * Schickt den Aufnahmelink erneut — OHNE zweiten Faktor.
 *
 * Die Betreiberin erfaehrt dabei nichts, was sie nicht schon weiss, und die
 * Mail geht an eine Adresse, die bereits im Datensatz steht; sie laesst sich
 * nicht umlenken. Wer den Link SEHEN will, braucht `zeigeAufnahmelink`.
 */
export function sendIntakeLink(
  companyId: string,
): Promise<{ sent: boolean; email: string; reason?: string }> {
  return apiFetch(
    `/api/companies/${encodeURIComponent(companyId)}/intake-link/send`,
    { method: 'POST' },
  );
}

/**
 * Zeigt den Aufnahmelink im Klartext — MIT zweitem Faktor.
 *
 * Er fuehrt zur IBAN-Erfassung; wer ihn hat, kann fuer diese Organisation
 * Bankdaten hinterlegen. Der Aufruf erzeugt einen NEUEN Link und zieht einen
 * offenen zurueck — den alten Klartext gibt es danach nicht mehr.
 */
export function showIntakeLink(
  companyId: string,
  evidence?: SecondFactorEvidence,
): Promise<{ link: string; expiresAt: string }> {
  return apiFetch(
    `/api/companies/${encodeURIComponent(companyId)}/intake-link/reveal`,
    { method: 'POST', body: JSON.stringify(evidence ?? {}) },
  );
}

/**
 * „Erneut prüfen": Antwortet eine ausgerollte Instanz inzwischen?
 *
 * Nur ein Lesezugriff auf die Instanz; Coolify wird nicht angefasst. Bei
 * Erfolg steht sie danach auf `aktiv`.
 */
export function checkInstanceReachability(
  companyId: string,
): Promise<{ erreichbar: boolean }> {
  return apiFetch(
    `/api/companies/${encodeURIComponent(companyId)}/instance/check-reachability`,
    { method: 'POST' },
  );
}

/**
 * Verwirft eine GESCHEITERTE Erstellung.
 *
 * Kein Schreibvorgang gegen Coolify: Der Server laesst die Route ueberhaupt
 * nur zu, wenn dort nichts entstanden ist. Sie gibt eine CRM-Zeile ueber
 * einen Vorgang auf, der nie stattgefunden hat, und macht damit den Weg fuer
 * einen neuen Versuch frei — `Instanz.organisationId` ist unique.
 */
export function discardInstanceCreation(
  companyId: string,
): Promise<{ discarded: true }> {
  return apiFetch(
    `/api/companies/${encodeURIComponent(companyId)}/instance/discard`,
    { method: 'POST' },
  );
}

export function setPaymentDetails(
  id: string,
  data: PaymentDetailsChange,
  evidence?: SecondFactorEvidence,
): Promise<PaymentDetails> {
  return apiFetch<PaymentDetails>(
    `/api/companies/${encodeURIComponent(id)}/payment-details`,
    { method: 'PATCH', body: JSON.stringify({ ...data, ...(evidence ?? {}) }) },
  );
}

/** Was die Löschung tatsächlich angefasst hat — für die Rückmeldung. */
export interface DeleteResult {
  cleanedUpFields: string[];
  deletedNotes: number;
  rewrittenNotes: number;
}

/**
 * Löscht die Kontaktdaten einer Organisation.
 *
 * `bestaetigung` muss der Name der Organisation sein — der Vorgang ist
 * unumkehrbar, und ein Fehlgriff in der Liste soll dafür nicht genügen.
 * Der Server anonymisiert, statt zu löschen: Der Datensatz bleibt (Notizen
 * hängen mit `Restrict` daran), der Name wird umgeschrieben.
 */
export function deleteContactData(
  id: string,
  confirmation: string,
  evidence?: SecondFactorEvidence,
): Promise<DeleteResult> {
  return apiFetch<DeleteResult>(
    `/api/companies/${encodeURIComponent(id)}/delete-contact-data`,
    {
      method: 'POST',
      body: JSON.stringify({ confirmation, ...(evidence ?? {}) }),
    },
  );
}

/** Was die vollständige Löschung mitgenommen hat — für die Rückmeldung. */
export interface CompanyDeleteResult {
  /** Der Name, den es gerade noch gab. Nur für die Meldung. */
  name: string;
  deletedNotes: number;
  deletedPreviews: number;
  deletedSendRows: number;
  deletedConsents: number;
  /**
   * Sperreinträge, die STEHENGEBLIEBEN sind — ohne Bezug zur Organisation.
   * Eine Abmeldung, die mit der Organisation verschwände, wäre beim nächsten
   * Import wieder im Verteiler.
   */
  detachedBlockEntries: number;
}

/**
 * Entfernt die Organisation vollständig.
 *
 * ANDERS ALS `loescheKontaktdaten`: Dort bleibt der Datensatz stehen und wird
 * anonymisiert, weil Belege an ihm hängen. Hier ist die Zeile hinterher weg —
 * möglich nur, solange es KEINE Instanz, KEINE Rechnung und KEINE werbliche
 * Mail zu ihr gibt. Sonst antwortet der Server mit 409
 * (`organisation_nicht_loeschbar`) und nennt in der Meldung alle Hindernisse
 * auf einmal.
 *
 * Gedacht für das, was sich im Register sonst ansammelt: Anfragen, die nie
 * Kunde wurden, und Organisationen aus dem eigenen Ausprobieren.
 */
export function deleteCompany(
  id: string,
  confirmation: string,
  evidence?: SecondFactorEvidence,
): Promise<CompanyDeleteResult> {
  return apiFetch<CompanyDeleteResult>(
    `/api/companies/${encodeURIComponent(id)}/delete`,
    {
      method: 'POST',
      body: JSON.stringify({ confirmation, ...(evidence ?? {}) }),
    },
  );
}

// ---------------------------------------------------------------------------
// Etappe 3 — Instanzen
//
// Die Typen sind die getippte Fassung dessen, was das Backend TATSÄCHLICH
// liefert (`apps/control/src/instanz/instanz.typen.ts`), nicht die im Entwurf
// vorgeschlagene Wunschform. Wo beides auseinandergeht, gilt der Server.
//
// ES GIBT GENAU ZWEI SCHREIBENDE AUFRUFE gegen eine Kundeninstanz:
// `legeInstanzAn` und `archiviereInstanz`. Kein Löschen, kein Wiederherstellen,
// kein „erneut versuchen" — die dritte Schreiboperation, die R1 nicht kennt,
// existiert hier auch nicht als Funktion. `erzeugeInstanzVorschau` schreibt
// ausschließlich in die eigene Datenbank.
// ---------------------------------------------------------------------------

/** Die vier Zustände einer Instanz, wortgleich mit dem Prisma-Enum. */
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
  /** Tag der letzten ERFOLGREICHEN Abfrage, nicht des letzten Versuchs. */
  lastSuccessfulQueryAt: string | null;
  /** 0 = die letzte Abfrage war erfolgreich. */
  sinceDaysFailed: number;
  database: 'erreichbar' | 'gestoert' | null;
}

export interface InstanceBackup {
  last: { date: string; sizeBytes: number } | null;
  /**
   * Fertig berechnet vom Server. Die Schwelle, ab der eine Sicherung als
   * überfällig gilt, ist eine Betriebsentscheidung — die Oberfläche kennt sie
   * nicht und rechnet sie nicht nach.
   */
  missing: boolean;
}

export interface InstanceDetail {
  id: string;
  companyId: string;
  subdomain: string;
  status: InstanceStatus;
  appVersion: string | null;
  /** Technischer Zeitstempel (ISO) — daraus wird die Laufzeit gerechnet. */
  createdAt: string;
  archivedAt: string | null;
  /**
   * Klartext-Zwischenstand ODER Fehlschlag.
   *
   * ES GIBT KEINEN ENUMWERT `fehlgeschlagen`. Scheitert die Erstellung, bleibt
   * der Status auf `wird_erstellt` stehen und der Grund steht hier im Klartext;
   * scheitert ein Teil der Archivierung, steht er nach `archiviert` hier. Die
   * Karte muss dieses Feld deshalb in BEIDEN Fällen zeigen — im laufenden
   * Übergang und im Endzustand —, sonst entsteht genau der stille Halbzustand,
   * den die Pflicht-Vorschau verhindern soll (E3-12).
   */
  message: string | null;
  /** `null`, solange `status !== 'aktiv'`. */
  metrics: InstanceMetrics | null;
  backup: InstanceBackup;
  /** Einrichtungslink der Instanz, solange ihn niemand eingelöst hat. */
  /**
   * Gaebe es einen Einrichtungslink zu holen? — NICHT der Link selbst.
   *
   * [A.7] Der Link traegt das Einrichtungsgeheimnis der Kundeninstanz. Er kommt
   * nur ueber `holeEinladungslink` heraus, hinter einem zweiten Faktor.
   */
  invitationOpen: boolean;
  /**
   * Tag, an dem die Instanz als eingerichtet erkannt wurde — `null` heisst
   * „noch nicht erkannt", nicht „sicher nicht eingerichtet".
   */
  configuredAt: string | null;
  /**
   * Wurde in Coolify schon eine Anwendung angelegt? Entscheidet nach einem
   * Fehlschlag, welche Anweisung WAHR ist: verwerfen, oder erst in Coolify
   * löschen.
   */
  coolifyCreated: boolean;
}

/**
 * Was die PFLICHT-VORSCHAU zeigt.
 *
 * Sie ist kein Anzeigeschritt der Oberfläche, sondern eine Eigenschaft des
 * Servers: Der Aufruf legt eine kurzlebige Zeile an, die das Anlegen atomar
 * verbraucht. Ohne sie antwortet `legeInstanzAn` mit `409 vorschau_fehlt`.
 */
export interface InstancePreview {
  previewId: string;
  subdomain: string;
  url: string;
  applicationName: string;
  databaseName: string;
  /** NUR die Namen der Umgebungsvariablen. Niemals ihre Werte. */
  environmentVariables: string[];
  validUntil: string;
  deviatesBySuggestionFrom: boolean;
  suggestedSubdomain: string;
}

/** `null`, wenn zu dieser Organisation (noch) keine Instanz gehört. */
export function fetchInstance(
  companyId: string,
): Promise<InstanceDetail | null> {
  return apiFetch<InstanceDetail | null>(
    `/api/companies/${encodeURIComponent(companyId)}/instance`,
  );
}

/**
 * Der Vorschlag aus dem Organisationsnamen — vom Server, nicht nachgebaut.
 *
 * Die Regeln (Umlaute, weggelassene Rechtsformen, gesperrte Namen) stehen in
 * `apps/control/src/coolify/subdomain.ts` und sind Backend-Code. Eine zweite
 * Fassung im Browser liefe irgendwann auseinander, und ausgerechnet hier wäre
 * die Abweichung ein Tippfehler, der NICHT auffällt.
 */
export function fetchSubdomainSuggestion(
  companyId: string,
): Promise<{ subdomain: string }> {
  return apiFetch<{ subdomain: string }>(
    `/api/companies/${encodeURIComponent(companyId)}/instance/subdomain-suggestion`,
  );
}

/**
 * Ist die Subdomain frei? Geprüft gegen CRM UND Coolify.
 *
 * Wirft `400 subdomain_ungueltig`, wenn der Wert unzulässig oder für den
 * Betrieb reserviert ist — die Nachricht des Servers ist der Text, der ins
 * Fehlerfeld gehört. Die Oberfläche pflegt dafür keine eigene Sperrliste.
 */
export function checkSubdomain(
  companyId: string,
  value: string,
): Promise<{ available: boolean }> {
  return apiFetch<{ available: boolean }>(
    `/api/companies/${encodeURIComponent(companyId)}/instance/subdomain-available?value=${encodeURIComponent(value)}`,
  );
}

/** PFLICHTSCHRITT vor `legeInstanzAn`. Schreibt nur in die eigene Datenbank. */
export function generateInstancePreview(
  companyId: string,
  subdomain: string,
): Promise<InstancePreview> {
  return apiFetch<InstancePreview>(
    `/api/companies/${encodeURIComponent(companyId)}/instance/preview`,
    { method: 'POST', body: JSON.stringify({ subdomain }) },
  );
}

/**
 * SCHREIBVORGANG 1: anlegen.
 *
 * Die Antwort kommt, sobald die Instanz-Zeile mit `wird_erstellt` steht — der
 * minutenlange Coolify-Teil läuft danach im Hintergrund. Der Dialog schließt
 * deshalb sofort; die Instanz-Karte fragt von da an selbst nach.
 */
export function createInstance(
  companyId: string,
  data: { subdomain: string },
): Promise<InstanceDetail> {
  return apiFetch<InstanceDetail>(
    `/api/companies/${encodeURIComponent(companyId)}/instance`,
    { method: 'POST', body: JSON.stringify(data) },
  );
}

/**
 * SCHREIBVORGANG 2: stoppen, letzte Sicherung ziehen, Status setzen.
 *
 * NIEMALS LÖSCHEN. Es gibt keine Funktion, die ein Deployment oder eine
 * Datenbank entfernt, und keine, die eine Sicherung zurückspielt.
 */
export function archiveInstance(
  companyId: string,
): Promise<InstanceDetail> {
  return apiFetch<InstanceDetail>(
    `/api/companies/${encodeURIComponent(companyId)}/instance/archive`,
    { method: 'POST', body: JSON.stringify({}) },
  );
}

// ---------------------------------------------------------------------------
// Etappe 4 — Rechnungen
//
// Wieder die getippte Fassung dessen, was das Backend TATSÄCHLICH liefert
// (`apps/control/src/rechnung/rechnung.antwort.ts`, `dto/rechnung.dto.ts`,
// `preis.typen.ts`). Drei Fallstricke stehen dabei im Vordergrund und sind
// unten an Ort und Stelle noch einmal benannt:
//
// 1. ZWEI STATUSFELDER. `status` ist die rohe Datenbankspalte, `zahlungsstand`
//    der serverseitig abgeleitete Wert. Angezeigt wird ausschließlich
//    `zahlungsstand`.
// 2. GELD KOMMT ALS PUNKT-DEZIMALSTRING (`"1234.56"`), nicht deutsch
//    formatiert. Jede dieser Zeichenketten läuft vor der Anzeige durch
//    `formatBetrag`.
// 3. GESCHRIEBEN WIRD IN GANZEN CENT. Die DTOs nehmen `…Cent`-Ganzzahlen; eine
//    Gleitkommazahl hätte den ersten Rundungsfehler schon vor dem Rechnen.
// ---------------------------------------------------------------------------

/**
 * Die rohe Datenbankspalte.
 *
 * NICHT FÜR DIE ANZEIGE. Sie steuert, WAS möglich ist (ein Entwurf ist
 * bearbeitbar, alles andere nicht), nie, was dasteht. `ueberfaellig` existiert
 * im Prisma-Enum, wird aber nie geschrieben und taucht deshalb hier gar nicht
 * erst auf.
 */
export type InvoiceStatus =
  | 'draft'
  | 'finalized'
  | 'sent'
  | 'paid'
  | 'partially_paid'
  | 'cancelled';

/**
 * DER ABGELEITETE ZAHLUNGSSTAND — das einzige Feld, das als Statusabzeichen
 * erscheint.
 *
 * `festgeschrieben` und `versendet` fallen beide unter `offen`, solange die
 * Fälligkeit nicht überschritten ist. Das ist kein Informationsverlust: „schon
 * versendet?" ist eine Verlaufsfrage, keine Statusfrage.
 */
export type PaymentState =
  | 'draft'
  | 'open'
  | 'overdue'
  | 'partially_paid'
  | 'paid'
  | 'cancelled';

/** Ein Posten, wie der Server ihn zurückgibt — alle Beträge als Zeichenkette. */
export interface InvoiceLine {
  id: string;
  label: string;
  description: string | null;
  unit: string | null;
  periodFrom: string | null;
  periodUntil: string | null;
  /** Drei Nachkommastellen, Punkt als Trenner: `"1.000"`. */
  quantity: string;
  unitPriceNet: string;
  taxRate: string;
  netAmount: string;
  taxAmount: string;
  grossAmount: string;
  /** Preisstufe, aus der der Posten stammt (Preisvorschlag), sonst `null`. */
  priceTierKey?: string | null;
  priceTierLabel?: string | null;
}

export interface Invoice {
  id: string;
  companyId: string;
  /**
   * Der HEUTIGE Name der Organisation — für Listen, nicht für den Beleg.
   *
   * Auf dem Beleg steht `empfaengerName`, wie er beim Festschreiben lautete;
   * der ändert sich nie (R2). Wer die Organisation heute sucht, sucht sie
   * unter ihrem heutigen Namen.
   */
  companyName: string | null;
  /** Einleitungssatz und Zahlungshinweis auf dem Beleg. */
  introduction: string | null;
  paymentNote: string | null;
  /** Der Zettel am Vorgang — nicht auf dem Beleg, nicht in einer Mail. */
  internalNote: string | null;
  /** `null`, solange die Rechnung Entwurf ist — die Nummer vergibt erst das Festschreiben. */
  invoiceNumber: string | null;
  status: InvoiceStatus;
  paymentState: PaymentState;

  invoiceDate: string;
  servicePeriodFrom: string;
  servicePeriodUntil: string;
  dueDate: string;
  /** Technischer Zeitstempel (ISO), kein fachliches Datum. */
  finalizedAt: string | null;
  createdAt: string;

  paymentDate: string | null;
  paidAmount: string | null;
  openAmount: string;

  sumNet: string;
  sumTax: string;
  sumGross: string;
  /** Ganze Cent — zum RECHNEN (Vorbelegung des Zahlungsfelds), nie zur Anzeige. */
  sumGrossCent: number;

  cancellationInvoiceId: string | null;
  cancelledInvoiceId: string | null;
  cancellationReason: string | null;
  isCancellation: boolean;

  recipientName: string;
  recipientAddress: string;
  recipientEmail: string | null;

  transferStatus: string | null;
  documentPresent: boolean;
  /** Liegt die XRechnung (reines XML) vor? */
  xrechnungPresent?: boolean;
  /** E-Rechnung: Art der Empfängerin (Schnappschuss beim Festschreiben). */
  recipientBuyerType?: BuyerType | null;

  lines: InvoiceLine[];
}

/** Ein Posten, wie er zum Server geht. Beträge in GANZEN CENT. */
export interface InvoiceLineInput {
  label: string;
  description?: string;
  quantity: number;
  /** Leistungszeitraum JE POSTEN — beide oder keiner, der Server prüft es. */
  periodFrom?: string;
  periodUntil?: string;
  unitPriceNetCent: number;
  taxRate: number;
  /** UN/ECE Rec. 20: `C62` (Pauschale), `MON` (Monat), `ANN` (Jahr). */
  unit?: string;
  /** Preisstufe des Postens (aus dem Vorschlag); das Etikett setzt der Server. */
  priceTierKey?: string;
}

export interface InvoiceDraft {
  invoiceDate: string;
  servicePeriodFrom: string;
  servicePeriodUntil: string;
  /** Fehlt es, rechnet der Server `rechnungsdatum + Zahlungsziel`. */
  dueDate?: string;
  lines: InvoiceLineInput[];
  /** Steht auf dem BELEG — mit dem Festschreiben unveränderlich (R2). */
  introduction?: string;
  paymentNote?: string;
  /** Steht auf keinem Beleg und geht in keine Mail. */
  internalNote?: string;
}

/** Warum kein Stufenvorschlag zustande kam. */
export type SuggestionBlocker =
  | 'no_instance'
  | 'no_metrics'
  | 'instance_too_young';

export interface PriceTier {
  key: string;
  label: string;
  untilPersons: number | null;
  monthlyCent: number;
  halfYearlyCent: number;
  yearlyCent: number;
  setupCent: number;
}

/**
 * Der Stufenvorschlag — R5: er wird ANGEZEIGT, die Betreiberin bestätigt.
 *
 * Der Endpunkt ist rein lesend und setzt nirgends `Organisation.preisstufe`.
 * Die Oberfläche darf daraus deshalb niemals automatisch einen Posten
 * erzeugen; jeder Übernahme-Knopf ist ein ausdrücklicher Klick.
 *
 * KEIN STEUERSATZ IM VORSCHLAG. Neue Posten werden mit `STEUERSATZ_VORGABE`
 * vorbelegt und bleiben frei editierbar.
 */
export interface PriceSuggestion {
  tier: PriceTier | null;
  blockers: SuggestionBlocker[];
  averageActivePersons: number | null;
  measurementDays: number;
  period: { from: string; until: string };
  /** Decimal(10,2) als Zeichenkette. STICHT die Stufe, wenn gesetzt. */
  customAmount: string | null;
  subscriptionCalculableFrom: string | null;
  subscriptionCalculable: boolean;
  setupCalculable: boolean;
}

/**
 * Die Bestätigung, ohne die nicht festgeschrieben wird.
 *
 * Wörtlich derselbe Wert wie `FESTSCHREIBEN_BESTAETIGUNG` in
 * `rechnung.controller.ts` — bewusst DUPLIZIERT statt importiert: Die
 * Oberfläche zieht keine Symbole über die App-Grenze aus dem Nest-Teil, sonst
 * zöge `nest build` React-Code hinter sich her. Weicht der Server ab, scheitert
 * das Festschreiben mit `bestaetigung_fehlt` und der Text des Servers steht
 * im Dialog.
 */
export const FINALIZE_CONFIRMATION = 'festschreiben';

/** Vorgabewert des Steuersatzes neuer Posten (`PREIS_VORGABEN.steuersatz`). */
export const TAX_RATE_DEFAULT = 19;

/** Höchstzahl Posten je Rechnung (`@ArrayMaxSize(50)` im DTO). */
export const LINES_MAX_COUNT = 50;

/** Eine Seite der globalen Rechnungsliste. */
export interface InvoicePage {
  invoices: Invoice[];
  total: number;
  page: number;
  perPage: number;
  /** Menge je Zahlungsstand — die Zahlen der Filterchips. */
  countPerState: Record<PaymentState, number>;
}

/** Die drei Zahlen der Kennzahlkacheln. */
export interface InvoiceMetrics {
  year: number;
  openCent: number;
  openCount: number;
  overdueCent: number;
  overdueCount: number;
  paidCent: number;
}

/**
 * ALLE Rechnungen, gefiltert und mit Seiten.
 *
 * Bis zum Redesign gab es diese Liste bewusst nicht — Rechnungen gehörten zu
 * einer Organisation. Wer einen Abrechnungslauf macht, arbeitet aber nicht
 * Kunde für Kunde, sondern Rechnung für Rechnung.
 */
export function fetchAllInvoices(
  filter: {
    state?: PaymentState;
    companyId?: string;
    page?: number;
    perPage?: number;
  } = {},
): Promise<InvoicePage> {
  const p = new URLSearchParams();
  if (filter.state) p.set('state', filter.state);
  if (filter.companyId) p.set('companyId', filter.companyId);
  if (filter.page !== undefined) p.set('page', String(filter.page));
  if (filter.perPage !== undefined) p.set('perPage', String(filter.perPage));
  const text = p.toString();
  return apiFetch<InvoicePage>(`/api/invoices${text ? `?${text}` : ''}`);
}

export function fetchInvoiceMetrics(
  year?: number,
): Promise<InvoiceMetrics> {
  return apiFetch<InvoiceMetrics>(
    `/api/invoices/metrics${year === undefined ? '' : `?year=${year}`}`,
  );
}

export function fetchInvoices(companyId: string): Promise<Invoice[]> {
  return apiFetch<Invoice[]>(
    `/api/companies/${encodeURIComponent(companyId)}/invoices`,
  );
}

export function fetchInvoice(id: string): Promise<Invoice> {
  return apiFetch<Invoice>(`/api/invoices/${encodeURIComponent(id)}`);
}

export function fetchPriceSuggestion(
  companyId: string,
): Promise<PriceSuggestion> {
  return apiFetch<PriceSuggestion>(
    `/api/companies/${encodeURIComponent(companyId)}/price-suggestion`,
  );
}

export function createInvoiceDraft(
  companyId: string,
  draft: InvoiceDraft,
): Promise<Invoice> {
  return apiFetch<Invoice>(
    `/api/companies/${encodeURIComponent(companyId)}/invoices`,
    { method: 'POST', body: JSON.stringify(draft) },
  );
}

/**
 * Ändert einen ENTWURF — es gibt bewusst kein Gegenstück für festgeschriebene
 * Rechnungen (R2). Der Pfad sagt es, und der Server prüft es ein zweites Mal.
 */
export function updateInvoiceDraft(
  id: string,
  draft: InvoiceDraft,
): Promise<Invoice> {
  return apiFetch<Invoice>(
    `/api/invoices/${encodeURIComponent(id)}/draft`,
    { method: 'PATCH', body: JSON.stringify(draft) },
  );
}

/** Der einzige Löschweg des Moduls — und er trägt `entwurf` im Pfad. */
export function deleteInvoiceDraft(
  id: string,
): Promise<{ deleted: true }> {
  return apiFetch<{ deleted: true }>(
    `/api/invoices/${encodeURIComponent(id)}/draft`,
    { method: 'DELETE' },
  );
}

/**
 * ===========================================================================
 * DER ABSCHLUSS EINER RECHNUNG — ALLES HINTER DEM ZWEITEN FAKTOR
 * ===========================================================================
 *
 * Hier stand einmal „KEIN zweiter Faktor — der Vorgang hinterlässt ein
 * Dokument". Das war falsch, und der Prüfer hat es mit einem selbst
 * signierten, eine Stunde alten Sitzungs-Cookie belegt:
 * `FESTSCHREIBEN 200 → 2026-078`, `STORNIEREN 201 → 2026-079`, `ZAHLUNG 401`.
 * Der zweite Faktor sass auf der umkehrbaren Handlung und fehlte auf den
 * unumkehrbaren.
 *
 * DAS KRITERIUM IST NICHT „hinterlässt ein Dokument", SONDERN
 * „lässt sich zurücknehmen":
 *
 *   festschreiben  verbrennt eine Rechnungsnummer, die nie wieder frei wird
 *   stornieren     hebt eine Forderung endgültig auf
 *   versenden      eine verschickte Mail holt niemand zurück
 *   erinnerung     dasselbe, und sie geht an eine Kundin
 *
 * Der Zahlungsstand dagegen lässt sich korrigieren — er bleibt aus demselben
 * Grund geschützt wie zuvor, aber er ist nicht mehr der schwerere Fall.
 *
 * Alle vier liegen am `RechnungAbschlussController` (`SitzungGuard` +
 * `ZweitfaktorGuard`). `nachweis` bleibt optional: Es wird IMMER zuerst ohne
 * gerufen, denn bei einer Sitzung unter zehn Minuten lässt der Server ihn weg.
 * Wer eine Rechnung nach der anderen abarbeitet, tippt sein Passwort einmal.
 */
export function finalizeInvoice(
  id: string,
  evidence?: SecondFactorEvidence,
): Promise<Invoice> {
  return apiFetch<Invoice>(
    `/api/invoices/${encodeURIComponent(id)}/finalize`,
    {
      method: 'POST',
      body: JSON.stringify({
        confirmation: FINALIZE_CONFIRMATION,
        ...(evidence ?? {}),
      }),
    },
  );
}

/** Storno: zwei Belege, die beide bestehen bleiben — und keiner geht weg. */
export function cancelInvoice(
  id: string,
  reason: string,
  evidence?: SecondFactorEvidence,
): Promise<{ original: Invoice; cancellation: Invoice }> {
  return apiFetch<{ original: Invoice; cancellation: Invoice }>(
    `/api/invoices/${encodeURIComponent(id)}/cancel`,
    { method: 'POST', body: JSON.stringify({ reason, ...(evidence ?? {}) }) },
  );
}

export function sendInvoice(
  id: string,
  evidence?: SecondFactorEvidence,
): Promise<Invoice> {
  return apiFetch<Invoice>(
    `/api/invoices/${encodeURIComponent(id)}/send`,
    { method: 'POST', body: JSON.stringify({ ...(evidence ?? {}) }) },
  );
}

export function sendPaymentReminder(
  id: string,
  evidence?: SecondFactorEvidence,
): Promise<Invoice> {
  return apiFetch<Invoice>(
    `/api/invoices/${encodeURIComponent(id)}/reminder`,
    { method: 'POST', body: JSON.stringify({ ...(evidence ?? {}) }) },
  );
}

/**
 * ZAHLUNG UND ÜBERTRAGUNG — hinter dem zweiten Faktor.
 *
 * Der Unterschied zu Festschreiben und Storno steht im Kommentar von
 * `rechnung-zahlung.controller.ts` und ist der Grund für zwei verschieden
 * schwere Bestätigungswege: Anlegen, Festschreiben und Stornieren hinterlassen
 * IMMER ein Dokument (Nummer, Systemnotiz, Audit-Eintrag). Der Zahlungsstand
 * hinterlässt keines — wer ihn fälscht, löscht lautlos eine Forderung aus der
 * Übersicht, und die Dashboard-Aufgabe verschwindet gleich mit.
 *
 * Wie bei den vertraulichen Vorgängen der Etappe 2 wird immer zuerst OHNE
 * Nachweis gerufen: Bei einer Sitzung unter zehn Minuten lässt der Server ihn
 * weg, und niemand tippt sein Passwort zehnmal hintereinander.
 */
export function notePayment(
  id: string,
  data: { paymentDate: string; paidAmountCent: number },
  evidence?: SecondFactorEvidence,
): Promise<Invoice> {
  return apiFetch<Invoice>(
    `/api/invoices/${encodeURIComponent(id)}/payment`,
    { method: 'POST', body: JSON.stringify({ ...data, ...(evidence ?? {}) }) },
  );
}

export function noteTransfer(
  id: string,
  transferStatus: string,
  evidence?: SecondFactorEvidence,
): Promise<Invoice> {
  return apiFetch<Invoice>(
    `/api/invoices/${encodeURIComponent(id)}/transfer`,
    {
      method: 'POST',
      body: JSON.stringify({ transferStatus, ...(evidence ?? {}) }),
    },
  );
}

// ---------------------------------------------------------------------------
// Etappe 5 — Widerspruch von Hand eintragen ([W4])
//
// Art. 21 Abs. 1 DSGVO und § 7 UWG binden die Wirksamkeit eines Widerspruchs
// an KEINEN Kanal. Wer anruft, auf eine Mail antwortet oder schreibt, hat
// wirksam widersprochen. Bis zu dieser Route führte der einzige Weg zur Sperre
// über einen Token aus einer unserer eigenen Mails — die Abmeldeseite versprach
// „Antworte auf eine unserer Mails, wir tragen dich von Hand aus", und dahinter
// stand nichts.
//
// ES GIBT KEIN GEGENSTÜCK, und das ist keine Lücke, sondern die Eigenschaft:
// Eine Route, die entsperren könnte, wäre der bequemste Weg, R3 zu umgehen —
// jemand mit Zugriff auf das CRM könnte eine Einwilligung erfinden, die es nie
// gab. Der Weg zurück ist eine neue Eintragung durch die Person selbst über
// das öffentliche Formular; aus `spam_gemeldet` gibt es auch den nicht.
// Deshalb enthält `SPERRGRUND_TEXTE` ausschließlich Sperrzustände.
// ---------------------------------------------------------------------------

/**
 * Die drei Gründe, die von Hand gesetzt werden dürfen — wortgleich mit
 * `SPERRGRUENDE` in `einwilligung.dto.ts`.
 *
 * Bewusst DUPLIZIERT statt importiert, wie `FESTSCHREIBEN_BESTAETIGUNG`: Die
 * Oberfläche zieht keine Symbole über die App-Grenze aus dem Nest-Teil. Weicht
 * der Server ab, lehnt er den Wert mit seiner eigenen Meldung ab.
 */
export const BLOCK_REASON_TEXTS = {
  unsubscribed: {
    short: t('common.api.short'),
    long: t('common.api.long'),
  },
  hard_bounced: {
    short: t('common.api.short2'),
    long: t('common.api.long2'),
  },
  spam_reported: {
    short: t('common.api.short3'),
    long: t('common.api.long3'),
  },
} as const;

export type BlockReason = keyof typeof BLOCK_REASON_TEXTS;

export const BLOCK_REASONS = Object.keys(BLOCK_REASON_TEXTS) as BlockReason[];

/** Mindestlänge des Anlasses (`@MinLength(10)` in `AdresseSperrenDto`). */
export const BLOCK_REASON_MIN_LENGTH = 10;

/** Höchstlänge des Anlasses (`@MaxLength(500)`). */
export const BLOCK_REASON_MAX_LENGTH = 500;

export interface BlockResult {
  consentId: string;
  /** Gab es zu der Adresse vorher gar keinen Eintrag? */
  created: boolean;
  /** Wie viele schon eingestellte Mails dabei abgebrochen wurden. */
  abortedMails: number;
}

/**
 * Sperrt eine Adresse — endgültig. Hinter dem zweiten Faktor, aus demselben
 * Grund wie der Rechnungsabschluss: Der Vorgang lässt sich nicht zurücknehmen.
 */
export function blockAddress(
  input: { email: string; reason: BlockReason; justification: string },
  evidence?: SecondFactorEvidence,
): Promise<BlockResult> {
  return apiFetch<BlockResult>('/api/consent/block', {
    method: 'POST',
    body: JSON.stringify({ ...input, ...(evidence ?? {}) }),
  });
}

/**
 * Der Name, der nach der Kontaktdatenlöschung an einer Organisation
 * stehenbleibt (`NAME_NACH_LOESCHUNG` in `organisation.service.ts`).
 *
 * Wieder eine bewusste Dublette statt eines Imports über die App-Grenze. Sie
 * ist das einzige Merkmal, an dem die Oberfläche eine gelöschte Organisation
 * erkennt: Ein eigenes Feld dafür gibt es in der Antwort nicht, und die
 * geräumten Felder allein sagen nichts — eine Organisation ohne hinterlegte
 * E-Mail-Adresse hat es auch vorher gegeben.
 */
export const NAME_AFTER_CONTACT_DATA_DELETION = t('common.api.nameAfterContactDataDeletion');

// ---------------------------------------------------------------------------
// Etappe 5 — Redaktion: Vorlagen, Vorschau, Empfängerauswahl, Versand
//
// Wieder die getippte Fassung dessen, was das Backend TATSÄCHLICH liefert
// (`src/broadcast/vorlage.service.ts`, `warteschlange.service.ts`,
// `rundmail.controller.ts`, `einwilligung.service.ts`). Vier Eigenheiten des
// Vertrags formen die Oberfläche und stehen deshalb unten an Ort und Stelle
// noch einmal:
//
// 1. ES GIBT KEIN HTML-FELD. `VorlageAnlegenDto` kennt genau `inhaltText`, und
//    `WerbeMailService.versende` setzt ausschliesslich `text:`. Die Spalte
//    `MailVorlage.inhaltHtml` existiert im Schema, wird aber von keiner Zeile
//    gelesen oder geschrieben. Ein HTML-Feld in der Oberfläche wäre ein Feld,
//    dessen Inhalt niemand verschickt.
// 2. DER KANAL IST UNVERÄNDERLICH, und der NAME ebenfalls. `VorlageAendernDto`
//    enthält beide nicht — sie lassen sich nur beim Anlegen setzen.
// 3. DIE EMPFÄNGERAUSWAHL IST EINE VORHERSAGE. Der Server sagt das in seiner
//    Antwort selbst (`hinweis`), und dieser Satz wird angezeigt, nicht durch
//    einen eigenen ersetzt.
// 4. VERSAND, TESTVERSAND UND VERSANDLAUF LIEGEN HINTER DEM ZweitfaktorGuard.
//    Alle drei sind POST, alle drei nehmen den Nachweis im Body — und sonst
//    NICHTS: Die globale ValidationPipe läuft mit `forbidNonWhitelisted`, ein
//    zusätzliches Feld ergäbe eine 400.
// ---------------------------------------------------------------------------

/** Die beiden Kanäle. Wortgleich mit `MAIL_KANAELE` in `rundmail.dto.ts`. */
export const MAIL_CHANNELS = ['transactional', 'marketing'] as const;

export type MailChannel = (typeof MAIL_CHANNELS)[number];

// Die fünf Zustände einer Einwilligung stehen als `EinwilligungStatus` weiter
// oben — sie kamen mit dem Organisationsformular aus Etappe 2 herein. Nur
// `bestaetigt` erlaubt eine werbliche Mail.

/** Eine Vorlage, wie `VorlageAntwort` sie liefert. */
export interface Template {
  id: string;
  name: string;
  channel: MailChannel;
  subject: string;
  contentText: string;
  /**
   * Der formatierte Rumpf — `null` bei Vorlagen aus der Zeit vor dem
   * Redaktionsfeld. Dann steht der Wortlaut nur als Text da, und die
   * Oberflaeche baut daraus Absaetze.
   */
  contentHtml: string | null;
  /**
   * ERLAUBTE Platzhalternamen, ohne Klammern — einschliesslich der beiden
   * Standardplatzhalter, die der Server von sich aus voranstellt
   * (`organisation`, `abmeldelink`). Es ist NICHT die Liste der im Text
   * tatsächlich verwendeten.
   */
  placeholders: string[];
  active: boolean;
  /**
   * Die vier Strukturfelder der Werbemail — Vorueberschrift, Ueberschrift und
   * der Handlungsknopf.
   *
   * Sie stehen NICHT im Redaktionsfeld: Der Saeuberer laesst kein `<a>`
   * durch, und eine Ueberschrift ist eine Rolle im Rahmen, keine
   * Formatierung im Text. `null`, wo nichts steht.
   */
  eyebrow: string | null;
  heading: string | null;
  buttonText: string | null;
  buttonTarget: string | null;
  createdAt: string;
  updatedAt: string;
}

/** Vorschau mit Beispielwerten (`VorschauAntwort`). */
export interface Preview {
  subject: string;
  /**
   * NUR DER RUMPF, als reiner Text und ohne Rahmen — die Fassung, die im
   * Redaktionsfeld steht. Zum ANZEIGEN taugt sie nicht mehr: Sie lässt
   * ausgerechnet den Teil weg, den die Redaktion nicht ändern kann.
   */
  body: string;
  /**
   * DAS VOLLSTÄNDIGE DOKUMENT als HTML, so wie es hinausgeht: Kopf, Rumpf und
   * die kanalgerechte Fusszeile mit Abmeldelink und Anbieterkennung.
   *
   * Es wird SERVERSEITIG über denselben Weg gebaut wie beim Versand. Die
   * Oberfläche zeigt es nur an und setzt hier nichts zusammen: Eine zweite
   * Fassung der Anbieterkennung nach § 5 DDG im Browser liefe der Quelle
   * davon, und ausgerechnet bei einer Pflichtangabe fiele die Abweichung
   * niemandem auf.
   */
  html: string;
  /**
   * Dasselbe Dokument als reiner Text — der zweite Teil, der tatsächlich
   * hinausgeht (`multipart/alternative`), samt Fusszeile.
   */
  text: string;
  used: Record<string, string>;
}

/** Eine Zeile der Empfängerauswahl (`EmpfaengerZeile`). */
export interface RecipientRow {
  consentId: string;
  email: string;
  companyId: string | null;
  companyName: string | null;
  confirmedAt: string | null;
  /** WO das Formular stand, z. B. „webseite-newsletter". */
  origin: string | null;
}

/** Eine Zeile der Sperrliste. */
export interface BlockRow {
  consentId: string;
  email: string;
  status: 'unsubscribed' | 'hard_bounced' | 'spam_reported';
  /**
   * Der Anlass im Wortlaut — nur bei einer Sperre VON HAND.
   *
   * Leer, wenn sich jemand selbst ueber den Link abgemeldet hat: Wer das tut,
   * nennt keinen Anlass. Leer auch nach einer Kontaktdatenloeschung — der
   * Anlass ist ein Freitext ueber eine Person und geht mit ihren Daten.
   */
  reason: string | null;
  registeredAt: string | null;
}

/** Ein Konto in der Nutzerverwaltung. */
export interface UserRow {
  id: string;
  name: string;
  username: string;
  email: string;
  /**
   * Die Rolle. Sie unterscheidet KEINE Rechte -- alle Konten koennen
   * dasselbe --, sondern haelt fest, welches am Anfang stand.
   */
  role: string;
  /**
   * ABGELEITET, nicht gespeichert. `ohne_zugang` heisst: Konto vorhanden,
   * aber weder Passwort noch Passkey -- also kein Weg hinein.
   */
  state: 'active' | 'without_access' | 'locked';
  deactivatedAt: string | null;
  lastLoginAt: string | null;
  /** Die eigene Zeile. Sie laesst sich hier nicht abschalten. */
  self: boolean;
}

/** Der Zugangslink — er erscheint GENAU EINMAL, in dieser Antwort. */
export interface AccessResult {
  user: UserRow;
  link: string;
  expiresAt: string;
}

export function fetchUser(): Promise<UserRow[]> {
  return apiFetch<UserRow[]>('/api/users');
}

/**
 * Traegt ein weiteres Konto ein. ES GIBT KEIN ROLLENFELD: Alle Konten koennen
 * dasselbe.
 */
export function registerUser(
  data: { name: string; email: string },
  evidence?: SecondFactorEvidence,
): Promise<AccessResult> {
  return apiFetch<AccessResult>('/api/users', {
    method: 'POST',
    body: JSON.stringify({ ...data, ...(evidence ?? {}) }),
  });
}

/**
 * Adresse eines Kontos ohne Zugang berichtigen — mit zweitem Faktor.
 * Der Einladungslink geht nicht per Mail hinaus; ein Tippfehler faellt erst
 * auf, wenn der Anmeldecode ins Leere geht.
 */
export function correctUserAddress(
  id: string,
  email: string,
  evidence?: SecondFactorEvidence,
): Promise<UserRow> {
  return apiFetch<UserRow>(
    `/api/users/${encodeURIComponent(id)}/address`,
    { method: 'PATCH', body: JSON.stringify({ email, ...(evidence ?? {}) }) },
  );
}

export function newAccessLink(
  id: string,
  evidence?: SecondFactorEvidence,
): Promise<{ link: string; expiresAt: string }> {
  return apiFetch<{ link: string; expiresAt: string }>(
    `/api/users/${encodeURIComponent(id)}/access-link`,
    { method: 'POST', body: JSON.stringify({ active: true, ...(evidence ?? {}) }) },
  );
}

/**
 * Zugang entziehen oder wieder erteilen.
 *
 * ES GIBT KEIN `DELETE`. Geloescht wird nichts (R4): Ein geloeschtes Konto
 * verloere die Zuordnung seiner Audit-Eintraege.
 */
export function setUserAccess(
  id: string,
  active: boolean,
  evidence?: SecondFactorEvidence,
): Promise<UserRow> {
  return apiFetch<UserRow>(
    `/api/users/${encodeURIComponent(id)}/access`,
    { method: 'PATCH', body: JSON.stringify({ active, ...(evidence ?? {}) }) },
  );
}

/**
 * Den Abgleich mit Coolify JETZT laufen lassen.
 *
 * Bis dahin lief er nur naechtlich, und die Karte auf „Heute" zeigte einen
 * Befund, den es womoeglich nicht mehr gab.
 */
export function startReconciliation(): Promise<unknown> {
  return apiFetch<unknown>('/api/companies/reconciliation', { method: 'POST' });
}

/** Eine Zeile des Sicherheitsprotokolls (`SicherheitsEreignis`). */
export interface SecurityEvent {
  id: string;
  /** ISO-Zeitstempel — hier zaehlt die Minute, nicht der Tag. */
  timestamp: string;
  action: string;
  /** Klartext; faellt auf die Aktionskennung zurueck, wenn keiner hinterlegt ist. */
  text: string;
  actor: string;
  /** Eine Abweichung vom Normalbetrieb — wird hervorgehoben. */
  suspicious: boolean;
  ip: string | null;
}

/** Die drei Zahlen der Reiterleiste im Rundmail-Bereich. */
export interface BroadcastCounter {
  templates: number;
  confirmed: number;
  blocked: number;
}

/**
 * Zahl und Liste — plus den Satz des Servers, dass beides eine Vorhersage ist.
 *
 * `hinweis` wird ANGEZEIGT und nicht durch eine eigene Formulierung ersetzt:
 * Der Server ist die Stelle, die weiss, wann die Prüfung wirklich stattfindet.
 */
export interface RecipientSelect {
  count: number;
  recipient: RecipientRow[];
  note: string;
}

/** Der vollständige Einwilligungsnachweis (`NachweisZeile`) — ohne die Token. */
export interface Evidence {
  consentId: string;
  email: string;
  status: ConsentStatus;
  origin: string | null;
  formText: string;
  subscribedAt: string | null;
  ipAtSubscription: string | null;
  confirmedAt: string | null;
  ipAtConfirmation: string | null;
  unsubscribedAt: string | null;
  deactivatedAt: string | null;
  /** DASS es einen Token gibt, nicht welchen. */
  confirmationTokenPresent: boolean;
  unsubscribeTokenPresent: boolean;
}

/** Was das Einreihen in die Warteschlange ergeben hat. */
export interface EnqueueResult {
  enqueued: number;
  template: string;
}

/** Was ein Versandlauf abgearbeitet hat (`VersandlaufErgebnis`). */
export interface SendRunResult {
  considered: number;
  sent: number;
  refused: number;
  repeat: number;
  failed: number;
  /** Zeilen aus einem abgebrochenen Lauf, nach 30 Minuten vermerkt. */
  cleanedUp: number;
}

/**
 * WIE WEIT DER VERSAND EINER VORLAGE IST (`VersandFortschritt`).
 *
 * Vier Zahlen, die zusammen `gesamt` ergeben. `abgewiesen` steht bewusst
 * neben `fehlgeschlagen` und nicht darin: Eine abgewiesene Zeile ist kein
 * Fehler, sondern die Prüfung beim Versand, die gegriffen hat — dort hat
 * jemand widerrufen.
 *
 * KEINE ADRESSEN. Die Antwort enthält ausschliesslich Zählwerte; sie entsteht
 * serverseitig über eine Gruppierung und kann gar keine Zeile herausgeben.
 */
export interface SendProgress {
  templateId: string;
  total: number;
  sent: number;
  open: number;
  failed: number;
  refused: number;
}

/** Testversand an die EIGENE Adresse. `grund` trägt den Zustellstatus. */
export interface TestSendResult {
  sent: boolean;
  reason?: string;
}

/** Höchstlänge des Vorlagennamens (`@MaxLength(120)`). */
export const TEMPLATE_NAME_MAX_LENGTH = 120;

/** Höchstlänge des Betreffs (`@MaxLength(300)`). */
export const TEMPLATE_SUBJECT_MAX_LENGTH = 300;

/** Mindestlänge des Inhalts (`@MinLength(20)`). */
export const TEMPLATE_CONTENT_MIN_LENGTH = 20;

/** Höchstlänge des Inhalts (`@MaxLength(20_000)`). */
export const TEMPLATE_CONTENT_MAX_LENGTH = 20_000;

/**
 * Obergrenze des formatierten Rumpfes. Groesszuegiger als beim Text, weil
 * Auszeichnungen Platz brauchen -- dieselbe Grenze wie im DTO. Die
 * INHALTLICHE Grenze prueft der Server auf der abgeleiteten Textfassung,
 * sonst scheiterte ein kurzer, stark formatierter Text am Markup statt am
 * Wortumfang.
 */
export const TEMPLATE_HTML_MAX_LENGTH = 60_000;

/** Höchstzahl selbstdeklarierter Platzhalter (`@ArrayMaxSize(30)`). */
export const PLACEHOLDERS_MAX_COUNT = 30;

/**
 * Platzhalter, die der Versand IMMER füllen kann — wortgleich mit
 * `STANDARD_PLATZHALTER` in `rundmail/platzhalter.ts`.
 *
 * Bewusst dupliziert statt importiert, wie `SPERRGRUND_TEXTE`: Die Oberfläche
 * zieht keine Symbole über die App-Grenze aus dem Nest-Teil.
 */
export const STANDARD_PLACEHOLDERS = ['company', 'abmeldelink'] as const;

export function fetchTemplates(): Promise<Template[]> {
  return apiFetch<Template[]>('/api/broadcast/templates');
}

export function fetchTemplate(id: string): Promise<Template> {
  return apiFetch<Template>(`/api/broadcast/templates/${encodeURIComponent(id)}`);
}

/**
 * Legt eine Vorlage an. NUR HIER lässt sich der Kanal setzen — danach nie
 * wieder (`VorlageAendernDto` kennt ihn nicht).
 */
export function createTemplate(data: {
  name: string;
  channel: MailChannel;
  subject: string;
  /**
   * Der formatierte Rumpf. Wird er mitgeschickt, hat er Vorrang und der
   * Server leitet den Textteil selbst ab -- zwei unabhaengig gelieferte
   * Fassungen liefen auseinander.
   */
  contentHtml: string;
  placeholders: string[];
}): Promise<Template> {
  return apiFetch<Template>('/api/broadcast/templates', {
    method: 'POST',
    body: JSON.stringify(data),
  });
}

/** Redigiert eine Vorlage. Kanal und Name bleiben, wie sie sind. */
export function updateTemplate(
  id: string,
  data: {
    subject?: string;
    contentText?: string;
    /** Hat Vorrang vor `inhaltText`; der Server leitet den Text daraus ab. */
    contentHtml?: string;
    placeholders?: string[];
    active?: boolean;
    /**
     * Die vier Strukturfelder. Was FEHLT, bleibt stehen; ein LEERER Text
     * loescht das Feld -- wer eine Ueberschrift herausnimmt, will sie weg
     * haben.
     */
    eyebrow?: string;
    heading?: string;
    buttonText?: string;
    buttonTarget?: string;
  },
): Promise<Template> {
  return apiFetch<Template>(
    `/api/broadcast/templates/${encodeURIComponent(id)}`,
    { method: 'PATCH', body: JSON.stringify(data) },
  );
}

/** Vorschau mit Beispielwerten. Verschickt nichts. */
export function fetchPreview(id: string): Promise<Preview> {
  return apiFetch<Preview>(
    `/api/broadcast/templates/${encodeURIComponent(id)}/preview`,
  );
}

/**
 * Der Stand einer eingestellten Rundmail. Zum wiederholten Abrufen gedacht,
 * solange `offen` grösser als null ist. Ändert nichts und stösst nichts an.
 */
export function fetchSendProgress(id: string): Promise<SendProgress> {
  return apiFetch<SendProgress>(
    `/api/broadcast/templates/${encodeURIComponent(id)}/progress`,
  );
}

/** Wer die Mail bekäme und wie viele es sind — eine Vorhersage, keine Zusage. */
export function fetchRecipients(): Promise<RecipientSelect> {
  return apiFetch<RecipientSelect>('/api/broadcast/recipients');
}

/** Jede Adresse, die nichts Werbliches mehr bekommt. Rein lesend. */
export function fetchBlocklist(): Promise<BlockRow[]> {
  return apiFetch<BlockRow[]>('/api/broadcast/blocklist');
}

/**
 * Das Sicherheitsprotokoll. Rein lesend; es gibt kein Gegenstueck zum
 * Loeschen oder Aendern -- ein Audit-Log, an dem sich etwas aendern laesst,
 * ist keines.
 */
export function fetchSecurityLog(
  limit?: number,
): Promise<SecurityEvent[]> {
  return apiFetch<SecurityEvent[]>(
    `/api/audit/security${limit === undefined ? '' : `?limit=${limit}`}`,
  );
}

/** Die drei Zahlen der Reiterleiste — ohne eine einzige Adresse. */
export function fetchBroadcastCounter(): Promise<BroadcastCounter> {
  return apiFetch<BroadcastCounter>('/api/broadcast/counters');
}

/**
 * Der Nachweis zu einer Adresse. `null` heisst: zu dieser Adresse gibt es
 * keinen Eintrag — der Server antwortet auch bei leerer Anfrage mit `null`.
 */
export function fetchEvidence(email: string): Promise<Evidence | null> {
  return apiFetch<Evidence | null>(
    `/api/broadcast/evidence?email=${encodeURIComponent(email)}`,
  );
}

/**
 * Stellt die Rundmail für alle bestätigten Adressen in die Warteschlange.
 *
 * ES GEHT DABEI NOCH NICHTS HINAUS — und es gibt kein Empfängerfeld. Wer die
 * Mail bekommt, entscheidet ausschliesslich die Einwilligungstabelle; der
 * Aufrufer kann daran nichts drehen (R3).
 */
export function arrangeBroadcast(
  templateId: string,
  evidence?: SecondFactorEvidence,
): Promise<EnqueueResult> {
  return apiFetch<EnqueueResult>(
    `/api/broadcast/templates/${encodeURIComponent(templateId)}/send`,
    { method: 'POST', body: JSON.stringify({ ...(evidence ?? {}) }) },
  );
}

/**
 * Testversand an die EIGENE Adresse des angemeldeten Kontos.
 *
 * KEIN ADRESSFELD, und das ist keine Auslassung: Ein Testversand an eine frei
 * wählbare Adresse wäre der Weg, R3 „durch Fehlbedienung" zu umgehen. Für die
 * eigene Adresse gilt dieselbe Prüfung wie für jede andere — ohne bestätigte
 * Einwilligung antwortet der Server mit `keine_werbefreigabe`.
 */
export function sendTestSend(
  templateId: string,
  evidence?: SecondFactorEvidence,
): Promise<TestSendResult> {
  return apiFetch<TestSendResult>(
    `/api/broadcast/templates/${encodeURIComponent(templateId)}/test-send`,
    { method: 'POST', body: JSON.stringify({ ...(evidence ?? {}) }) },
  );
}

/**
 * Stösst einen Versandlauf von Hand an.
 *
 * Der Aufruf kann LANGE dauern: Der Lauf nimmt bis zu `CONTROL_RUNDMAIL_JE_LAUF`
 * Zeilen auf (Vorgabe 20) und lässt zwischen zwei Mails
 * `CONTROL_RUNDMAIL_ABSTAND_MS` verstreichen (Vorgabe 5 Sekunden) — in der
 * Vorgabe also bis zu anderthalb Minuten. Die Oberfläche muss das sagen,
 * sonst sieht es aus, als hinge sie.
 */
export function startSendRun(
  evidence?: SecondFactorEvidence,
): Promise<SendRunResult> {
  return apiFetch<SendRunResult>('/api/broadcast/queue/run', {
    method: 'POST',
    body: JSON.stringify({ ...(evidence ?? {}) }),
  });
}

// ---------------------------------------------------------------------------
// Einstellungen → Preise
// ---------------------------------------------------------------------------

/** Eine Preisstufe der Preisliste; Beträge netto in ganzen Cent. */
export interface PriceListTier {
  key: string;
  label: string;
  /** Obere Schwelle einschließlich; `null` = nach oben offen. */
  maxPersons: number | null;
  monthlyCent: number;
  halfYearlyCent: number;
  yearlyCent: number;
  setupCent: number;
  archived: boolean;
}

export interface PriceList {
  taxRatePercent: number;
  paymentTermDays: number;
  averageDays: number;
  currency: string;
  /** Alle Stufen in Schwellenreihenfolge, archivierte eingeschlossen. */
  tiers: PriceListTier[];
  updatedAt: string | null;
}

export function fetchPrices(): Promise<PriceList> {
  return apiFetch<PriceList>('/api/settings/prices');
}

/**
 * Speichert die GESAMTE Preisliste. Hinter dem zweiten Faktor: ohne Nachweis
 * antwortet der Server (bei älterer Sitzung) mit `anmeldung_fehlgeschlagen`,
 * woraufhin die Oberfläche den Nachweis-Dialog zeigt.
 */
export function savePrices(
  list: Omit<PriceList, 'updatedAt'>,
  evidence?: SecondFactorEvidence,
): Promise<PriceList> {
  return apiFetch<PriceList>('/api/settings/prices', {
    method: 'PUT',
    body: JSON.stringify({
      taxRatePercent: list.taxRatePercent,
      paymentTermDays: list.paymentTermDays,
      averageDays: list.averageDays,
      currency: list.currency,
      tiers: list.tiers,
      ...(evidence ?? {}),
    }),
  });
}

// ---------------------------------------------------------------------------
// Einstellungen → Sicherung, Instanz-Sicherungen und Wiederherstellung
// ---------------------------------------------------------------------------

/** Metadaten des Sicherungsziels. Zugangsdaten sind WRITE-ONLY und kommen nie zurück. */
export interface BackupTargetMeta {
  type: 's3' | 'storagebox';
  endpoint: string | null;
  host: string | null;
  bucket: string | null;
  region: string | null;
  path: string | null;
  port: number | null;
  username: string | null;
  schedule: string;
  retentionDays: number;
  lastTestAt: string | null;
  lastTestOk: boolean | null;
  lastTestMessage: string | null;
  /** Vom Agent (nie Geheimnisse); null, solange der Agent nichts liefert. */
  prefix: string | null;
  pathStyle: boolean | null;
  authType: 'key' | 'password' | null;
  hostKeyFingerprint: string | null;
}

export interface BackupSettings {
  target: BackupTargetMeta | null;
  agent: {
    configured: boolean;
    reachable: boolean;
    version: string | null;
    targetConfigured: boolean | null;
    objectLock: boolean | null;
    ageRecipient: string | null;
  };
  /** Nur in der Antwort auf die ERSTE Einrichtung, genau einmal. */
  ageIdentity?: string;
}

export interface BackupSettingsInput {
  type: 's3' | 'storagebox';
  schedule: 'daily' | 'twice_daily';
  retentionDays: number;
  objectLock: boolean;
  s3?: {
    endpoint: string;
    region: string;
    bucket: string;
    prefix: string;
    pathStyle: boolean;
    /** Beide weglassen = der Agent behält die gespeicherten Werte. */
    accessKeyId?: string;
    secretAccessKey?: string;
  };
  storagebox?: {
    host: string;
    port: number;
    username: string;
    path: string;
    authType: 'key' | 'password';
    privateKey?: string;
    password?: string;
  };
}

export interface BackupTestResult {
  ok: boolean;
  message: string;
  testedAt: string;
}

export function fetchBackupSettings(): Promise<BackupSettings> {
  return apiFetch<BackupSettings>('/api/settings/backup');
}

/** Speichert das Sicherungsziel. Geheimnisse gehen durch zum Agent und werden nicht abgelegt. */
export function saveBackupSettings(
  input: BackupSettingsInput,
  evidence?: SecondFactorEvidence,
): Promise<BackupSettings> {
  return apiFetch<BackupSettings>('/api/settings/backup', {
    method: 'PUT',
    body: JSON.stringify({ ...input, ...(evidence ?? {}) }),
  });
}

export function testBackupTarget(
  evidence?: SecondFactorEvidence,
): Promise<BackupTestResult> {
  return apiFetch<BackupTestResult>('/api/settings/backup/test', {
    method: 'POST',
    body: JSON.stringify({ ...(evidence ?? {}) }),
  });
}

export interface InstanceBackupRow {
  id: string;
  date: string;
  sizeBytes: number;
  objectKey: string | null;
  sha256: string | null;
  verified: boolean;
  verifiedAt: string | null;
  restorable: boolean;
}

export interface BackupJobView {
  id: string;
  kind: 'backup' | 'backup-control' | 'verify' | 'restore';
  status: 'queued' | 'running' | 'succeeded' | 'failed';
  startedAt: string | null;
  finishedAt: string | null;
  message: string | null;
  result: { objectKey?: string; sizeBytes?: number; sha256?: string } | null;
}

/** provisioning | restoring | ready | failed | adopted */
export interface InstanceRestore {
  id: string;
  instanceId: string;
  backupId: string;
  newSubdomain: string;
  status: string;
  message: string | null;
  createdAt: string;
  adoptedAt: string | null;
}

export interface RestoreStartInput {
  backupId: string;
  newSubdomain: string;
  /** Privater age-Schlüssel: nur im Speicher, geht an den Agent, nie zurück. */
  ageIdentity: string;
  confirmName: string;
}

export function fetchInstanceBackups(
  instanceId: string,
): Promise<{ backups: InstanceBackupRow[] }> {
  return apiFetch<{ backups: InstanceBackupRow[] }>(
    `/api/instances/${encodeURIComponent(instanceId)}/backups`,
  );
}

export function startInstanceBackup(
  instanceId: string,
  evidence?: SecondFactorEvidence,
): Promise<{ jobId: string }> {
  return apiFetch<{ jobId: string }>(
    `/api/instances/${encodeURIComponent(instanceId)}/backups`,
    { method: 'POST', body: JSON.stringify({ ...(evidence ?? {}) }) },
  );
}

export function fetchBackupJob(
  instanceId: string,
  jobId: string,
): Promise<BackupJobView> {
  return apiFetch<BackupJobView>(
    `/api/instances/${encodeURIComponent(instanceId)}/backups/jobs/${encodeURIComponent(jobId)}`,
  );
}

export function fetchInstanceRestores(
  instanceId: string,
): Promise<InstanceRestore[]> {
  return apiFetch<InstanceRestore[]>(
    `/api/instances/${encodeURIComponent(instanceId)}/restores`,
  );
}

export function startInstanceRestore(
  instanceId: string,
  input: RestoreStartInput,
  evidence?: SecondFactorEvidence,
): Promise<InstanceRestore> {
  return apiFetch<InstanceRestore>(
    `/api/instances/${encodeURIComponent(instanceId)}/restores`,
    { method: 'POST', body: JSON.stringify({ ...input, ...(evidence ?? {}) }) },
  );
}

/** Übernahme: die alte Instanz wird gestoppt (nie gelöscht), die Adresse zeigt dann auf die wiederhergestellte. */
export function adoptInstanceRestore(
  instanceId: string,
  restoreId: string,
  evidence?: SecondFactorEvidence,
): Promise<InstanceRestore> {
  return apiFetch<InstanceRestore>(
    `/api/instances/${encodeURIComponent(instanceId)}/restores/${encodeURIComponent(restoreId)}/adopt`,
    { method: 'POST', body: JSON.stringify({ ...(evidence ?? {}) }) },
  );
}

// --- GoBD: Integrität, Verlauf, Export für die Betriebsprüfung ---------------

/** Rechnung samt Aufbewahrungsfrist (`retentionUntil` liefert das Backend ab Teil E). */
export type InvoiceWithRetention = Invoice & { retentionUntil?: string | null };

export interface IntegrityCheckLine {
  /** `pdf_sha256`, `xml_sha256`, `xrechnung_sha256`, `number_sequence`. */
  check: string;
  ok: boolean;
  status: string;
}

export interface IntegrityResult {
  invoiceId: string;
  invoiceNumber: string | null;
  finalized: boolean;
  ok: boolean;
  /** UTC, ISO-8601. */
  checkedAt: string;
  checks: IntegrityCheckLine[];
}

export interface InvoiceHistoryEntry {
  /** UTC, ISO-8601. */
  at: string;
  actor: string;
  action: string;
  format?: string;
}

export function fetchInvoiceIntegrity(id: string): Promise<IntegrityResult> {
  return apiFetch<IntegrityResult>(`/api/invoices/${id}/integrity`);
}

export function fetchInvoiceHistory(id: string): Promise<InvoiceHistoryEntry[]> {
  return apiFetch<InvoiceHistoryEntry[]>(`/api/invoices/${id}/history`);
}

/**
 * Lädt das GoBD-Archiv (ZIP) für einen Zeitraum — IMMER als POST.
 *
 * Passwort/Code gehören in den Body, nie in eine URL. Ohne Nachweis gilt das
 * Frischefenster der Sitzung; verlangt der Server den Nachweis, wirft der
 * Aufruf den üblichen `ApiError`, und der Aufrufer wiederholt mit Nachweis.
 */
export async function downloadGobdExport(
  range: { from: string; to: string },
  evidence?: SecondFactorEvidence,
): Promise<{ blob: Blob; fileName: string | null }> {
  const base = (import.meta.env['VITE_API_URL'] as string | undefined) ?? '';
  const response = await fetch(`${base}/api/invoices/export/gobd`, {
    method: 'POST',
    credentials: 'include',
    referrerPolicy: 'no-referrer',
    headers: {
      'Content-Type': 'application/json',
      'x-csrf-token': await fetchCsrf(),
    },
    body: JSON.stringify({ ...range, ...(evidence ?? {}) }),
  });
  if (!response.ok) {
    let error = { code: `HTTP_${response.status}`, message: `HTTP ${response.status}` };
    try {
      const body = (await response.json()) as { error?: typeof error };
      if (body?.error) error = body.error;
    } catch {
      // Antwort ohne JSON-Körper: Ersatz behalten.
    }
    throw new ApiError(error, response.status);
  }
  const disposition = response.headers.get('content-disposition') ?? '';
  const name = /filename="?([^";]+)"?/.exec(disposition)?.[1] ?? null;
  return { blob: await response.blob(), fileName: name };
}

// ---------------------------------------------------------------------------
// Firmendaten (Rechnungsstellerin), Logo und Akzentfarbe
// ---------------------------------------------------------------------------

export interface IssuerLogoInfo {
  present: boolean;
  mime: string;
  sha256: string;
}

/** Eine fehlende oder fehlerhafte Pflichtangabe, wie der Server sie meldet. */
export interface IssuerMissing {
  field: string;
  label: string;
  code: string;
}

export interface IssuerSettings {
  profile: IssuerProfile;
  accentColor: string;
  logo: IssuerLogoInfo | null;
  missing: IssuerMissing[];
}

export function fetchIssuer(): Promise<IssuerSettings> {
  return apiFetch<IssuerSettings>('/api/settings/issuer');
}

/** Speichert auch unvollständige Angaben; `missing` nennt, was für Rechnungen noch fehlt. */
export function saveIssuer(body: {
  profile: IssuerProfile;
  accentColor: string;
}): Promise<IssuerSettings> {
  return apiFetch<IssuerSettings>('/api/settings/issuer', {
    method: 'PUT',
    body: JSON.stringify(body),
  });
}

export function uploadIssuerLogo(file: File): Promise<unknown> {
  const form = new FormData();
  form.append('file', file);
  return apiFetch<unknown>('/api/settings/issuer/logo', { method: 'POST', body: form });
}

export function deleteIssuerLogo(): Promise<unknown> {
  return apiFetch<unknown>('/api/settings/issuer/logo', { method: 'DELETE' });
}

/** Öffentliche Logo-Adresse; `version` (z. B. der Hash) umgeht veraltete Browser-Zwischenspeicher. */
export function publicLogoUrl(version?: string | number | null): string {
  return version ? `/api/public/logo?v=${encodeURIComponent(String(version))}` : '/api/public/logo';
}
