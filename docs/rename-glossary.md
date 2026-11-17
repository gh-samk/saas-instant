# Rename-Glossar: Deutsch -> Englisch (verbindlich)

Dieses Dokument ist die einzige Quelle der Wahrheit fuer die Umbenennung von saas-instant
(`apps/control`, `packages/shared`, `packages/ui`). Alle Agenten halten sich daran. Fehlt ein Begriff,
waehlt der Agent einen naheliegenden englischen Begriff, haelt ihn im ganzen eigenen Bereich einheitlich
und meldet ihn zurueck, damit er hier nachgetragen wird.

Nicht anfassen: `<Pfad des Fremdprodukts>`. Keine Funktionsaenderung.
Regel R1 (kein Loeschpfad gegen Coolify/Instanzen, keine zweite DB-Verbindung) bleibt unveraendert;
`kein-loeschpfad.spec.ts` wird nur umbenannt/angepasst, nie abgeschwaecht.

---------------------------------------------------------------------------------------------------

## 1. Regeln

1. **Bezeichner englisch, Texte deutsch.** Code, Dateinamen, Prisma-Modelle/-Felder/-Enums, JSON-Felder der API,
   Routen, Audit-Aktionen, Cookies/Header, Tests (Dateinamen, `describe`-/`it`-Titel duerfen deutsch bleiben, wenn
   sie ein deutsches Verhalten beschreiben; Bezeichner im Testcode englisch).
2. **Deutsche Texte bleiben:** Fehlermeldungen, Mailtexte, HTML-Seiten des Backends, Oberflaechentexte. Einschraenkung
   v1 (in README/Doku vermerken): Backend-Meldungen und Mailtexte sind vorerst nur deutsch.
3. **UI-Texte in i18n-Schicht:** `apps/control/src/i18n/` mit Woerterbuch `de.ts` (Schluessel englisch, Werte deutsch),
   Zugriff ueber `t('namespace.key', params?)`. Frontend-Komponenten enthalten danach keine deutschen Literale mehr.
   `lib/texte.ts` wird in `i18n/` aufgeloest. Schluessel-Namespaces = Bereich (`login.`, `company.`, `invoice.` ...).
4. **Gesetzes-/Fachbegriffe im TEXT bleiben:** SEPA, Glaeubiger-ID, Lastschrift, Mandat, USt-IdNr., Leistungszeitraum,
   XRechnung/ZUGFeRD. Als Bezeichner werden sie englisch (`creditorId`, `sepaMandateReference`), der sichtbare Text bleibt.
5. **Datenbank:** Es gibt kein `@@map`/`@map`; Tabellen und Spalten heissen wie Modelle/Felder. Sie werden also direkt
   englisch. **Frische Baseline-Migration:** `apps/control/prisma/migrations/*` komplett loeschen und eine neue
   `<zeitstempel>_init` per `prisma migrate dev --name init` erzeugen (kein Datenbestand zu retten, Tests laufen auf
   frischer DB). `migrationen-zeitstempel.spec.ts` -> `migration-timestamps.spec.ts` entsprechend anpassen.
6. **Datums-Regel bleibt:** fachliche Daten `@db.Date`, technische Zeitstempel `DateTime`.
7. **Enum-Werte** bleiben snake_case/lowercase, werden englisch. **Modell-/Enum-Namen** PascalCase, **Felder** camelCase.
8. **Schreibweise Umlaute:** die deutschen ae/oe/ue/ss-Umschreibungen verschwinden komplett aus Bezeichnern.
9. **Dateinamen:** kebab-case fuer Backend (`invoice-payment.controller.ts`), PascalCase fuer React-Komponenten.
   Das deutsche Namenssuffix `.fehler.ts`/`.typen.ts`/`.antwort.ts` etc. wird gemaess Wortliste (Abschnitt 8) ersetzt.
10. **Wortreihenfolge 1:1 beibehalten:** `OrganisationLoeschenDialog` -> `CompanyDeleteDialog` (nicht umstellen).
11. **`@saas-instant/*` Paketnamen** und Ordnerstruktur `apps/control`, `packages/shared`, `packages/ui` bleiben.
12. **`packages/shared`** enthaelt zusaetzlich Altbestand aus einem anderen Produkt (Domaene/Governance/Beschluss ...).
    Diese Dateien werden mit denselben Regeln umbenannt (`domaene` -> `domain`, `vorgang` -> `process`, ...), aber
    nicht inhaltlich verbessert. Die vom Control genutzten Teile: `datum`, `mail-rahmen`, `organisationsname`.

---------------------------------------------------------------------------------------------------

## 2. Prisma: Enums (Name und Werte)

| Alt | Neu | Werte alt -> neu |
|---|---|---|
| `BenutzerRolle` | `UserRole` | `inhaber` -> `owner`, `administrator` -> `administrator`, `mitarbeitend` -> `staff` (UNBENUTZT, bleibt erhalten) |
| `NotfallArt` | `EmergencyKind` | `passkey` -> `passkey`, `passwort` -> `password` |
| `OrganisationStatus` | `CompanyStatus` | `anfrage` -> `inquiry`, `demo` -> `demo`, `pilot_beschlossen` -> `pilot_approved`, `pilot_laufend` -> `pilot_running`, `zahlend` -> `paying`, `ueberpruefung_offen` -> `review_pending`, `ruhend` -> `dormant`, `beendet` -> `ended`. Seit Version 1.2.0 nur noch fünf Werte: `inquiry`, `trial` (Testphase), `paying`, `exempt` (Beitragsbefreit), `ended`; Abbildung der Altwerte: `demo`, `pilot_approved`, `pilot_running` -> `trial`; `review_pending` -> `paying`; `dormant` -> `ended` |
| `Zahlungsweise` | `PaymentInterval` | `jaehrlich` -> `yearly`, `halbjaehrlich` -> `half_yearly`, `monatlich` -> `monthly` |
| `Zahlungsart` | `PaymentMethod` | `lastschrift` -> `direct_debit`, `ueberweisung` -> `bank_transfer` |
| `Herkunft` | `Source` | `formular` -> `form`, `telefon` -> `phone`, `empfehlung` -> `referral`, `veranstaltung` -> `event` |
| `InstanzStatus` | `InstanceStatus` | `wird_erstellt` -> `provisioning`, `aktiv` -> `active`, `gestoppt` -> `stopped`, `archiviert` -> `archived` |
| `RechnungStatus` | `InvoiceStatus` | `entwurf` -> `draft`, `festgeschrieben` -> `finalized`, `versendet` -> `sent`, `bezahlt` -> `paid`, `teilweise_bezahlt` -> `partially_paid`, `ueberfaellig` -> `overdue`, `storniert` -> `cancelled` |
| `MailKanal` | `MailChannel` | `transaktion` -> `transactional`, `werblich` -> `marketing` |
| `Zustellstatus` | `DeliveryStatus` | `in_warteschlange` -> `queued`, `in_zustellung` -> `sending`, `gesendet` -> `sent`, `abgewiesen` -> `rejected`, `fehlgeschlagen` -> `failed` |
| `EinwilligungStatus` | `ConsentStatus` | `unbestaetigt` -> `unconfirmed`, `bestaetigt` -> `confirmed`, `abgemeldet` -> `unsubscribed`, `hart_abgewiesen` -> `hard_bounced`, `spam_gemeldet` -> `spam_reported` |
| `AnfrageArt` | `InquiryKind` | `demo` -> `demo`, `pilot` -> `pilot` |
| `AnfrageFolge` | `InquiryOutcome` | `zugangsdaten_gesendet` -> `credentials_sent`, `bestaetigung_gesendet` -> `confirmation_sent`, `bereits_ausgeloest` -> `already_triggered`, `kontingent_erschoepft` -> `quota_exhausted`, `versand_fehlgeschlagen` -> `send_failed` |

Frontend-/API-Typen mit gleichen Namen (`OrganisationStatus`, `Zahlungsweise`, `InstanzStatus` ...) folgen derselben Tabelle.
Weitere String-Unions im Frontend/Backend: `FaktorArt` -> `FactorKind`, `GeraetArt` -> `DeviceKind`,
`AnmeldungSchritt` -> `LoginStep`, `AufgabenArt` -> `TaskKind`, `Dringlichkeit` -> `Urgency`
(Werte nach Wortliste Abschnitt 8), `HandlungsArt` -> `ActionKind`, `Zahlungsstand` -> `PaymentState`,
`VorschlagHindernis` -> `SuggestionBlocker`.

## 3. Prisma: Modelle und Felder

### Modelle

| Alt | Neu |
|---|---|
| `Benutzer` | `User` |
| `PasskeyAnmeldedaten` | `PasskeyCredential` |
| `Wiederherstellungscode` | `RecoveryCode` |
| `EmailAnmeldecode` | `EmailLoginCode` |
| `Geraet` | `Device` |
| `NotfallRegistrierung` | `EmergencyEnrollment` |
| `Organisation` | `Company` |
| `Instanz` | `Instance` |
| `Sicherung` | `Backup` |
| `InstanzVorschau` | `InstancePreview` |
| `AbgleichLauf` | `ReconciliationRun` |
| `Kennzahl` | `Metric` |
| `AufnahmeZugang` | `IntakeAccess` |
| `Notiz` | `Note` |
| `Rechnung` | `Invoice` |
| `Rechnungsposten` | `InvoiceLine` |
| `MailVorlage` | `MailTemplate` |
| `MailVersand` | `MailDelivery` |
| `Einwilligung` | `Consent` |
| `AuditLog` | `AuditLog` (bleibt) |
| `Anfrage` | `Inquiry` |
| `Funktionsschalter` | `FeatureFlag` |

### Felder (modell-uebergreifend gleiche Namen -> gleiche Uebersetzung)

Allgemein: `id` bleibt. `erstelltAm` -> `createdAt`, `aktualisiertAm` -> `updatedAt`, `datum` -> `date`,
`status` -> `status`, `name` -> `name`, `email` -> `email`, `bezeichnung` -> `label`, `meldung` -> `message`,
`notizen` -> `notes`, `text` -> `text`, `art` -> `kind`, `folge` -> `outcome` (bei `Notiz.folge` -> `sequence`, BigInt autoincrement),
`quelle` -> `origin`, `ip` -> `ip`, `userAgent` -> `userAgent`, `tokenHash` -> `tokenHash`, `codeHash` -> `codeHash`,
`<x>Id` bleibt Muster (`benutzerId` -> `userId`, `organisationId` -> `companyId`, `instanzId` -> `instanceId`,
`rechnungId` -> `invoiceId`, `einwilligungId` -> `consentId`, `vorlageId` -> `templateId`).
Zeit-Muster: `...Am` -> `...At`, `...Bis` -> `...Until`, `...Von` -> `...From`, `laeuftAbAm` -> `expiresAt`,
`gueltigBis` -> `validUntil`, `verbrauchtAm` -> `consumedAt`, `eingeloestAm` -> `redeemedAt`, `zurueckgezogenAm` -> `revokedAt`.
Relationsfelder: Pluralnamen englisch (`rechnungen` -> `invoices`, `notizeintraege` -> `notes`, `aufnahmeZugaenge` -> `intakeAccesses`,
`instanzVorschauen` -> `instancePreviews`, `mailVersande` -> `mailDeliveries`, `einwilligungen` -> `consents`, `anfragen` -> `inquiries`,
`auditEintraege` -> `auditEntries`, `geraete` -> `devices`, `passkeys` -> `passkeys`, `wiederherstellungscodes` -> `recoveryCodes`,
`emailAnmeldecodes` -> `emailLoginCodes`, `notfallRegistrierungen` -> `emergencyEnrollments`, `kennzahlen` -> `metrics`,
`sicherungen` -> `backups`, `posten` -> `lines`, `versande` -> `deliveries`).

**User** (`Benutzer`): `nutzername` -> `username`, `rolle` -> `role`, `passwortHash` -> `passwordHash`,
`totpGeheimnis` -> `totpSecret`, `totpGeheimnisVorlaeufig` -> `totpSecretPending`, `totpVorlaeufigGueltigBis` -> `totpPendingValidUntil`,
`anmeldecodeEmail` -> `loginCodeEmail`, `anmeldecodeAktiv` -> `loginCodeEnabled`, `letzteAnmeldungAm` -> `lastLoginAt`,
`deaktiviertAm` -> `deactivatedAt`, `sitzungsGeneration` -> `sessionGeneration`, `anmeldevorgangGeneration` -> `loginFlowGeneration`,
`fehlversuche` -> `failedAttempts`, `gesperrtBis` -> `lockedUntil`.

**PasskeyCredential**: `credentialId`, `publicKey`, `counter`, `transports` bleiben; `zuletztGenutztAm` -> `lastUsedAt`.
**RecoveryCode**: `verbrauchtAm` -> `consumedAt`. **EmailLoginCode**: `zielEmail` -> `targetEmail`, `zurEinrichtung` -> `forSetup`,
`laeuftAbAm` -> `expiresAt`, `fehlversuche` -> `failedAttempts`.
**Device**: `zuletztGesehenAm` -> `lastSeenAt`, `gueltigBis` -> `validUntil`.
**EmergencyEnrollment**: `eingeloestAm` -> `redeemedAt`.

**Company** (`Organisation`):
`rechtsform` -> `legalForm`, `strasse` -> `street`, `hausnummer` -> `houseNumber`, `plz` -> `postalCode`, `ort` -> `city`, `land` -> `country` (Default `"Deutschland"` bleibt als Wert),
`rechnungName/Strasse/Hausnummer/Plz/Ort/Land/Email` -> `billingName/Street/HouseNumber/PostalCode/City/Country/Email`,
`ansprechpartnerin{Name,Email,Telefon,Funktion}` -> `contact{Name,Email,Phone,Role}`,
`stellvertretung{...}` -> `deputy{Name,Email,Phone,Role}`,
`letzterStatuswechselAm` -> `lastStatusChangeAt`, `preisstufe` -> `priceTier`, `abweichenderBetrag` -> `customAmount`,
`zahlungsweise` -> `paymentInterval`, `zahlungsart` -> `paymentMethod`,
`sepaMandatsreferenz` -> `sepaMandateReference`, `sepaMandatsdatum` -> `sepaMandateDate`, `iban`/`bic` bleiben,
`kontoinhaberin` -> `accountHolder`, `sepaMandatTextImWortlaut` -> `sepaMandateText`, `sepaMandatErteiltAm` -> `sepaMandateGrantedAt`,
`sepaMandatIp` -> `sepaMandateIp`, `aufnahmeAbgeschlossenAm` -> `intakeCompletedAt`, `aufnahmelinkVersendetAm` -> `intakeLinkSentAt`,
`beschlussdatumPilot` -> `pilotDecisionDate`, `ueberpruefungsterminAm` -> `reviewDueDate`, `ueberpruefungErledigtAm` -> `reviewDoneAt` (diese drei Spalten sind seit 1.2.0 ungenutzt),
`instanzStartAm` -> `instanceStartDate`, `newsletterEinwilligungStatus` -> `newsletterConsentStatus`, `herkunft` -> `source`, `notizen` -> `notes`.
Relationen: `instanz` -> `instance`, `instanzVorschauen` -> `instancePreviews`, `aufnahmeZugaenge` -> `intakeAccesses`, `notizeintraege` -> `noteEntries`.

**Instance**: `subdomain` bleibt, `coolifyAnwendungId` -> `coolifyApplicationId`, `coolifyDatenbankId` -> `coolifyDatabaseId`,
`kennzahlenTokenVerschluesselt` -> `metricsTokenEncrypted`, `setupTokenVerschluesselt` -> `setupTokenEncrypted`,
`archiviertAm` -> `archivedAt`, `appVersion` bleibt, `letzteKennzahlenAbfrageAm` -> `lastMetricsFetchAt`,
`einrichtungAbgeschlossenAm` -> `setupCompletedAt`, `meldung` -> `message`.
**Backup** (`Sicherung`): `groesseBytes` -> `sizeBytes`, `datum` -> `date`.
**InstancePreview**: `verwendetAm` -> `usedAt`, `gueltigBis` -> `validUntil`.
**ReconciliationRun** (`AbgleichLauf`): `ausgefuehrtAm` -> `executedAt`, `verwaisteAnwendungen` -> `orphanedApplications`,
`abweichungen` -> `deviations`, `erfolgreich` -> `successful`.
**Metric** (`Kennzahl`): `aktivePersonen` -> `activePersons`, `kreise` -> `circles`, `letzterEintragAm` -> `lastEntryAt`,
`letzteAnmeldungAm` -> `lastLoginAt`, `abfrageErfolgreich` -> `fetchSuccessful`, `fehlerart` -> `errorKind`,
`datenbankZustand` -> `databaseState`, `organisationsnameStimmt` -> `companyNameMatches`.
**IntakeAccess**: `zuletztVersendetAm` -> `lastSentAt`, `versandZaehler` -> `sendCount`.
**Note** (`Notiz`): `vomSystem` -> `bySystem`, `folge` -> `sequence`.

**Invoice** (`Rechnung`): `rechnungsnummer` -> `invoiceNumber`, `rechnungsdatum` -> `invoiceDate`,
`leistungszeitraumVon/Bis` -> `servicePeriodFrom/Until`, `faelligkeitsdatum` -> `dueDate`, `zahldatum` -> `paymentDate`,
`gezahlterBetrag` -> `paidAmount`, `festgeschriebenAm` -> `finalizedAt`, `stornierteRechnungId` -> `cancelledInvoiceId`,
`stornierteRechnung` -> `cancelledInvoice`, `stornorechnung` -> `cancellationInvoice` (Relationsname `"Storno"` -> `"Cancellation"`),
`stornogrund` -> `cancellationReason`, `einleitung` -> `introduction`, `zahlungshinweis` -> `paymentNote`,
`interneNotiz` -> `internalNote`, `pdfPfad`/`xmlPfad` -> `pdfPath`/`xmlPath`, `pdfInhalt`/`xmlInhalt` -> `pdfContent`/`xmlContent`,
`uebertragungsstatus` -> `transferStatus`, `empfaengerName/Anschrift/Email` -> `recipientName/Address/Email`,
Aussteller-Snapshot: `aussteller*` -> `issuer*`: `ausstellerFirmierung` -> `issuerCompanyName`, `ausstellerAnschrift` -> `issuerAddress`,
`ausstellerSitz` -> `issuerSeat`, `ausstellerUstIdNr` -> `issuerVatId`, `ausstellerRegistergericht` -> `issuerRegisterCourt`,
`ausstellerHra` -> `issuerCommercialRegisterA`, `ausstellerKomplementaerin` -> `issuerGeneralPartner`,
`ausstellerKomplementaerinSitz` -> `issuerGeneralPartnerSeat`, `ausstellerKomplementaerinRegistergericht` -> `issuerGeneralPartnerRegisterCourt`,
`ausstellerKomplementaerinHrb` -> `issuerGeneralPartnerCommercialRegisterB`, `ausstellerGeschaeftsfuehrer` -> `issuerManagingDirector`,
`lastschriftMandatsreferenz` -> `directDebitMandateReference`, `ausstellerBankverbindung` -> `issuerBankDetails`.
**InvoiceLine** (`Rechnungsposten`): `einheit` -> `unit`, `beschreibung` -> `description`, `zeitraumVon/Bis` -> `periodFrom/Until`,
`menge` -> `quantity`, `einzelpreisNetto` -> `unitPriceNet`, `steuersatz` -> `taxRate`, `nettobetrag` -> `netAmount`,
`steuerbetrag` -> `taxAmount`, `bruttobetrag` -> `grossAmount`.

**MailTemplate**: `kanal` -> `channel`, `betreff` -> `subject`, `inhaltText` -> `contentText`, `inhaltHtml` -> `contentHtml`,
`platzhalter` -> `placeholders`, `aktiv` -> `active`, `vorueberschrift` -> `eyebrow`, `ueberschrift` -> `heading`,
`knopfText` -> `buttonText`, `knopfZiel` -> `buttonTarget`.
**MailDelivery** (`MailVersand`): `empfaengerAdresse` -> `recipientAddress`, `inhaltSchnappschuss(Html)` -> `contentSnapshot(Html)`,
`versendetAm` -> `sentAt`, `zustellstatus` -> `deliveryStatus`, `fehlerzaehler` -> `errorCount`, `letzteFehlerklasse` -> `lastErrorClass`,
`letzterVersuchAm` -> `lastAttemptAt`, `naechsterVersuchAb` -> `nextAttemptFrom`.
**Consent** (`Einwilligung`): `angemeldetAm` -> `subscribedAt`, `ipBeiAnmeldung` -> `ipAtSubscription`,
`formulartextImWortlaut` -> `formText`, `bestaetigtAm` -> `confirmedAt`, `bestaetigungsToken` -> `confirmationToken`,
`abgemeldetAm` -> `unsubscribedAt`, `abmeldeToken` -> `unsubscribeToken`, `ipBeiBestaetigung` -> `ipAtConfirmation`,
`quelle` -> `origin`, `bestaetigungsmailAm` -> `confirmationMailAt`, `bestaetigungsmailZaehler` -> `confirmationMailCount`,
`stillgelegtAm` -> `deactivatedAt`, `sperrAnlass` -> `blockReason`.
**AuditLog**: `zeitpunkt` -> `timestamp`, `akteur` -> `actor`, `aktion` -> `action`, `objektTyp` -> `objectType`,
`objektId` -> `objectId`, `vorherWert` -> `beforeValue`, `nachherWert` -> `afterValue`.
**Inquiry** (`Anfrage`): `art` -> `kind`, `folge` -> `outcome`, `eingegangenAm` -> `receivedAt`.
**FeatureFlag**: `schluessel` -> `key`, `aktiv` -> `enabled`, `geaendertAm` -> `changedAt`, `geaendertVonId` -> `changedById`.

## 4. API-Routen (Praefix `/api` bleibt), JSON-Felder

Die JSON-Felder der API folgen 1:1 den Prisma-Feldnamen aus Abschnitt 3 (DTOs, Antwort-Typen, `lib/api.ts`).
Berechnete Felder: nach Wortliste Abschnitt 8 uebersetzen.

| Alt (Controller) | Neu |
|---|---|
| `audit` | `audit` |
| `aufgaben` | `tasks` |
| `aufnahme` (oeffentlich, `:token`, `:token/absenden`) | `intake` (`:token`, `:token/submit`) |
| `auth` | `auth` |
| `benutzer` | `users` |
| `einwilligung` (`bestaetigung/:token`, `abmeldung/:token`, `sperrliste`, `nachweis`, `anmeldung`) | `consent` (`confirmation/:token`, `unsubscribe/:token`, `blocklist`, `evidence`, `subscription`) |
| `funktionsschalter` | `feature-flags` |
| `schalter` (oeffentlich, `GET /`) | `flags` |
| `instanzen` | `instances` |
| `navigation` | `navigation` (`zaehler` -> `counters`) |
| `notizen` | `notes` |
| `oeffentlich` (`anfrage`) | `public` (`inquiry`) |
| `organisationen` | `companies` |
| `postausgang` | `outbox` |
| `public-config` | `public-config` |
| `rechnungen` | `invoices` |
| `rundmail` | `broadcast` |
| `sicherungen` | `backups` |
| `zeitplan` | `schedule` |
| `zugang` | `access` |
| `app.controller`: `gesundheit` | `health` (`version`, `robots.txt` bleiben) |

Route-Segmente (alle Controller): `ich` -> `me`, `faktoren` -> `factors`, `geraete` -> `devices`, `alle-abmelden` -> `sign-out-all`,
`abmelden` -> `logout`, `anmeldung` -> `login`, `anmeldecode/anfordern` -> `login-code/request`, `wiederherstellungscode(s)` -> `recovery-code(s)`,
`passwort` -> `password`, `notfall` -> `emergency` (`pruefen` -> `check`, `registrierung/start|abschluss` -> `enrollment/start|complete`, `passwort/setzen` -> `password/set`),
`passkey/abschluss` -> `passkey/complete`, `totp/einrichten|bestaetigen` -> `totp/setup|confirm`, `email-code/einrichten|bestaetigen` -> `email-code/setup|confirm`,
`:id/loeschen` -> `:id/delete`, `:id/status` -> `:id/status`, `:id/adresse` -> `:id/address`, `:id/zahlungsdaten(/anzeigen)` -> `:id/payment-details(/reveal)`,
`:id/zugang` -> `:id/access`, `:id/zugangslink` -> `:id/access-link`, `:id/ansprechpartnerin` -> `:id/contact-person`,
`:id/kontaktdaten-loeschen` -> `:id/delete-contact-data`, `:id/aufnahmezugang` -> `:id/intake-access`,
`:id/aufnahmelink/anzeigen|senden` -> `:id/intake-link/reveal|send`, `:id/anfragen` -> `:id/inquiries`, `:id/zahlung` -> `:id/payment`,
`:id/uebertragung` -> `:id/transfer`, `:id/instanz` -> `:id/instance`, `instanz/subdomain-verfuegbar|-vorschlag` -> `instance/subdomain-available|-suggestion`,
`instanz/archivieren|verwerfen|vorschau` -> `instance/archive|discard|preview`, `instanz/einladungslink/anzeigen|senden` -> `instance/invitation-link/reveal|send`,
`instanz/erreichbarkeit-pruefen` -> `instance/check-reachability`, `instanz/kennzahlen-abrufen` -> `instance/fetch-metrics`,
`rechnungen/:id/entwurf|dokument|xml|erinnerung|festschreiben|stornieren|versenden` -> `invoices/:id/draft|document|xml|reminder|finalize|cancel|send`,
`rechnungen/kennzahlen` -> `invoices/metrics`, `organisationen/:id/preisvorschlag` -> `companies/:id/price-suggestion`,
`vorlagen` -> `templates` (`:id/vorschau|fortschritt|testversand|versand` -> `:id/preview|progress|test-send|send`), `empfaenger` -> `recipients`,
`warteschlange/lauf` -> `queue/run`, `lauf` -> `run`, `abgleich` -> `reconciliation`, `sicherheit` -> `security`.
`GET :id` etc. bleiben. `@Put(':schluessel')` -> `@Put(':key')`.

Controller-Klassen: `OrganisationController` -> `CompanyController`, `InstanzenController` -> `InstancesController` usw. (Wortliste).

## 5. Cookies, Header, Env, Konstanten

| Alt | Neu |
|---|---|
| Cookie `sitzung` (`COOKIE_SITZUNG`) | `session` (`COOKIE_SESSION`) |
| Cookie `anmeldung` (`COOKIE_ANMELDUNG`) | `login` (`COOKIE_LOGIN`) |
| Cookie `merkgeraet` (`COOKIE_MERKGERAET`) | `trusted_device` (`COOKIE_TRUSTED_DEVICE`) |
| Cookie `csrf` | `csrf` (bleibt) |
| Header `x-anfrage-schluessel` | `x-inquiry-key` |
| Header `x-sicherung-schluessel` | `x-backup-key` |
| Header `x-csrf-token`, `x-request-id`, `x-forwarded-for` | bleiben |
| Header `x-sender-ip` | NEU (Brand-Neutralisierung; nginx muss denselben Header setzen) |
| `SITZUNG_MAX_ALTER_MS`, `SITZUNG_ERNEUERUNG_AB_MS`, `MERKGERAET_MAX_ALTER_MS`, `ANMELDUNG_MAX_ALTER_MS` | `SESSION_MAX_AGE_MS`, `SESSION_RENEWAL_AFTER_MS`, `TRUSTED_DEVICE_MAX_AGE_MS`, `LOGIN_MAX_AGE_MS` |

**Env-Variablen.** Entscheidung: Das Praefix `CONTROL_` BLEIBT (benennt die App "control", Deploy-Umgebungen und Coolify-Konfiguration
sind darauf aufgebaut; Umbenennung auf `SAAS_INSTANT_` bringt keinen Nutzen). Nur der deutsche Rest wird englisch.
Externe/generische Namen (`DATABASE_URL`, `JWT_SECRET`, `NODE_ENV`, `PORT`, `COOKIE_SECURE`, `TZ`, `SMTP_*`, `MANIFEST_PATH`,
`RECHNUNGSDIENST_URL`, `APP_BUILD_TIME`, `APP_GIT_SHA`, `DEMO_*`) bleiben, ausser unten genannt.

| Alt | Neu |
|---|---|
| `CONTROL_ABGLEICH_AKTIV` | `CONTROL_RECONCILIATION_ENABLED` |
| `CONTROL_ANFRAGE_EMPFAENGER` | `CONTROL_INQUIRY_RECIPIENT` |
| `CONTROL_ANFRAGE_SCHLUESSEL` | `CONTROL_INQUIRY_KEY` |
| `CONTROL_ANFRAGE_TRUST_PROXY` | `CONTROL_INQUIRY_TRUST_PROXY` |
| `CONTROL_COOLIFY_EIGENE_ANWENDUNGEN` | `CONTROL_COOLIFY_OWN_APPLICATIONS` |
| `CONTROL_EINWILLIGUNG_AUFRAEUMEN` | `CONTROL_CONSENT_CLEANUP` |
| `CONTROL_KENNZAHLEN_ABRUF_AKTIV` | `CONTROL_METRICS_FETCH_ENABLED` |
| `CONTROL_POSTAUSGANG_PROBE_AKTIV` | `CONTROL_OUTBOX_PROBE_ENABLED` |
| `CONTROL_RUNDMAIL_ABSTAND_MS` | `CONTROL_BROADCAST_INTERVAL_MS` |
| `CONTROL_RUNDMAIL_AKTIV` | `CONTROL_BROADCAST_ENABLED` |
| `CONTROL_RUNDMAIL_JE_LAUF` | `CONTROL_BROADCAST_PER_RUN` |
| `CONTROL_RUNDMAIL_WIEDERHOLUNG_MINUTEN` | `CONTROL_BROADCAST_RETRY_MINUTES` |
| `CONTROL_SEED_ERLAUBT` | `CONTROL_SEED_ALLOWED` |
| `CONTROL_SICHERUNG_SCHLUESSEL` | `CONTROL_BACKUP_KEY` |
| `CONTROL_ZEITPLAN_AKTIV` | `CONTROL_SCHEDULE_ENABLED` |
| `CONTROL_TOTP_AUSSTELLER` | `CONTROL_TOTP_ISSUER` |
| `CONTROL_APP_URL`, `CONTROL_CONFIG_KEY`, `CONTROL_RP_ID`, `CONTROL_RP_NAME`, `CONTROL_TRUST_PROXY`, `CONTROL_MAIL_BASIS_URL` | `CONTROL_MAIL_BASIS_URL` -> `CONTROL_MAIL_BASE_URL`; Rest bleibt |
| `MAIL_ABSENDER_RECHNUNG` | `MAIL_SENDER_INVOICE` |
| `MAIL_ABSENDER_RUNDMAIL` | `MAIL_SENDER_BROADCAST` |
| `MAIL_ANTWORT_AN` | `MAIL_REPLY_TO` |
| `MAIL_RUECKWEG` | `MAIL_RETURN_PATH` |
| `MAIL_DOMAENE` | `MAIL_DOMAIN` |
| `MAIL_ABMELDUNG_MAILTO` | `MAIL_UNSUBSCRIBE_MAILTO` |

Env-Aenderungen schlagen durch in: Code, `.env.example`, `Dockerfile*`, `docker-entrypoint.sh`, `scripts/*`, `docs/**`, Tests.
Jede Gruppe benennt die Variablen in IHREM Code um; die Gruppe B1 aktualisiert zusaetzlich `.env.example`, Docker-Dateien, Skripte und `docs/`.

## 6. Audit-Aktionsnamen

Format bleibt `<objekt>.<unterobjekt>.<ereignis>` in snake_case. Jedes Segment wird gemaess Tabelle uebersetzt.
Gespeicherte Strings aendern sich; Tests, Audit-Auswertung (`audit-lesen.ts`) und Aufgaben-Quellen, die darauf filtern, ziehen mit.

Objekt-Segmente: `anmeldung` -> `login`, `anmeldecode` -> `login_code`, `aufnahme` -> `intake`, `benutzer` -> `user`,
`coolify` -> `coolify`, `einwilligung` -> `consent`, `faktor` -> `factor`, `funktionsschalter` -> `feature_flag`, `geraet` -> `device`,
`instanz` -> `instance`, `kennzahlen` -> `metrics`, `konto` -> `account`, `notfall` -> `emergency`, `notiz` -> `note`,
`oeffentlich` -> `public`, `organisation` -> `company`, `passkey` -> `passkey`, `passwort` -> `password`, `rechnung` -> `invoice`,
`mail` -> `mail`, `rundmail` -> `broadcast`, `postausgang` -> `outbox`, `vorlage` -> `template`, `sitzung` -> `session`, `zeitplan` -> `schedule`.

Ereignis-/Unter-Segmente: `erfolg` -> `success`, `fehler` -> `failure`, `angelegt` -> `created`, `geaendert` -> `updated`,
`geloescht` -> `deleted`, `erzeugt` -> `generated`, `versendet` -> `sent`, `eingegangen` -> `received`, `abgelehnt` -> `rejected`,
`abgewiesen` -> `refused`, `eingeloest` -> `redeemed`, `gesperrt` -> `locked`, `entsperrt` -> `unlocked`, `gewechselt` -> `changed`,
`automatisch` -> `automatic`, `gelesen` -> `read`, `archiviert` -> `archived`, `bereit` -> `ready`, `aufbau` -> `provisioning`,
`erstellung.verworfen` -> `creation.discarded`, `angefordert` -> `requested`, `eingerichtet` -> `set_up`, `entfernt` -> `removed`,
`nicht_versendet` -> `not_sent`, `adresswechsel_angefordert` -> `address_change_requested`, `zweiter_faktor_noetig` -> `second_factor_required`,
`letztes_konto_abgelehnt` -> `last_account_rejected`, `adresse.berichtigt` -> `address.corrected`, `deaktiviert` -> `deactivated`,
`eingetragen` -> `registered`, `reaktiviert` -> `reactivated`, `abgleich` -> `reconciliation`, `abruf` -> `fetch`,
`abgemeldet` -> `unsubscribed`, `angemeldet` -> `subscribed`, `bestaetigt` -> `confirmed`, `ungueltig` -> `invalid`,
`stillgelegt` -> `deactivated`, `unbestaetigt.geloescht` -> `unconfirmed.deleted`, `von_hand_gesperrt` -> `blocked_manually`,
`geaendert` (Funktionsschalter) -> `changed`, `alle_widerrufen` -> `all_revoked`, `erneuert` -> `renewed`, `widerrufen` -> `revoked`,
`registriert` -> `registered`, `aenderung.fehler` -> `change.failure`, `gesetzt` -> `set`, `dublette` -> `duplicate`,
`mail_fehlgeschlagen` -> `mail_failed`, `verworfen` -> `discarded`, `vorschau` -> `preview`, `einladungslink` -> `invitation_link`,
`ansprechpartnerin.gewechselt` -> `contact_person.changed`, `kontaktdaten.geloescht` -> `contact_data.deleted`,
`zahlungsdaten.geaendert|gelesen` -> `payment_details.updated|read`, `status.gewechselt|automatisch` -> `status.changed|automatic`,
`entwurf.angelegt` -> `draft.created`, `dokument.erzeugt|ungueltig` -> `document.generated|invalid`.
Weitere, hier nicht aufgefuehrte Rechnungs-/Mail-Aktionen (`festgeschrieben`, `storniert`, `bezahlt`, `erinnerung`, `versand` ...)
folgen Abschnitt 8: `finalized`, `cancelled`, `paid`, `reminder`, `sent`.
Der Anzeigetext (deutsch) einer Aktion (z.B. in `SicherheitsProtokoll`) wandert in die i18n-Schicht (`audit.action.<name>`).

## 7. Ordner-/Dateinamen-Muster

### Backend-Ordner (`apps/control/src`)

| Alt | Neu |
|---|---|
| `aufgaben` (`quellen/`) | `tasks` (`sources/`) |
| `aufnahme` | `intake` |
| `auth`, `audit`, `common`, `cli`, `coolify`, `mail`, `manifest`, `navigation`, `prisma`, `utils` | bleiben |
| `benutzer` | `users` |
| `einwilligung` | `consent` |
| `funktionsschalter` | `feature-flags` |
| `instanz` | `instances` |
| `krypto` | `crypto` |
| `notiz` | `notes` |
| `oeffentlich` | `public` |
| `organisation` | `companies` |
| `postausgang` | `outbox` |
| `rechnung` (`dokument/`) | `invoices` (`document/`) |
| `rundmail` | `broadcast` |
| `zeitplan` | `schedule` |
| `test-support` | `test-support` |
| `components`, `context`, `lib`, `pages` | bleiben; Inhalt nach Wortliste |
| `common/{decorators,fehler,filters,guards,interceptors,middleware,pipes,validatoren}` | `.../{decorators,errors,filters,guards,interceptors,middleware,pipes,validators}` |
| `mail/rahmen` | `mail/layout` |
| `rechnung/dto` etc. `dto` | `dto` bleibt |
| `/public/schriften` + `scripts/schriften-kopieren.mjs` | `/public/fonts` + `scripts/copy-fonts.mjs` (inkl. Referenzen in `index.css`, `package.json`, `packages/ui/src/schriften.ts` -> `fonts.ts`) |
| `scripts/integrationslauf.mjs` | `scripts/integration-run.mjs` |
| `tsconfig.pruefung.json` | `tsconfig.check.json` |

### Dateimuster (gilt ueberall)

`*.fehler.ts` -> `*.errors.ts`, `*.typen.ts` -> `*.types.ts`, `*.antwort.ts` -> `*.response.ts`, `*.antwort.spec.ts` -> `*.response.spec.ts`,
`*.konfig.ts` -> `*.config.ts`, `*.quelle.ts` -> `*.source.ts`, `*.daten.ts` -> `*.data.ts`, `*.regeln.ts` -> `*.rules.ts`,
`*.integration.spec.ts` bleibt, `*.vorschau.ts` -> `*.preview.ts`, `*.abfrage.ts` -> `*.query.ts`, `*.schnappschuss.ts` -> `*.snapshot.ts`,
`*.betrag.ts` -> `*.amount.ts`, `*.stufe.ts` -> `*.tier.ts`, `*.tor.ts` -> `*.gate.ts`, `*.guard.ts`/`*.service.ts`/`*.controller.ts`/`*.module.ts`/`*.dto.ts` bleiben.
Controller: `*-oeffentlich.controller.ts` -> `*-public.controller.ts`, `*-vertraulich.controller.ts` -> `*-confidential.controller.ts`,
`instanzen.controller.ts` -> `instances.controller.ts`.
Frontend: `*Seite.tsx` -> `*Page.tsx`, `*Karte.tsx` -> `*Card.tsx`, `*Abzeichen.tsx` -> `*Badge.tsx`, `*Dialog.tsx` bleibt, `*Kontext.tsx` -> `*Context.tsx`,
`*Verwaltung.tsx` -> `*Management.tsx`, `*Eingabe.tsx` -> `*Input.tsx`, `*Liste.tsx` -> `*List.tsx`, `*Schaltflaeche.tsx` -> `*Button.tsx`,
`*Auswahl.tsx` -> `*Select.tsx` (UI-Paket: `Auswahl` -> `Select`), `*Formular.tsx` -> `*Form.tsx`, `*Ansicht.tsx` -> `*View.tsx`,
`*Felder.tsx`/`*Feld.tsx` -> `*Fields.tsx`/`*Field.tsx`, `*Reiter.tsx` -> `*Tabs.tsx`.
`lib/`: `instanz-status.ts` -> `instance-status.ts`, `organisation-status.ts` -> `company-status.ts`, `rechnung-status.ts` -> `invoice-status.ts`,
`einwilligung-status.ts` -> `consent-status.ts`, `aufgaben.ts` -> `tasks.ts`, `dichte.ts` -> `density.ts`, `stile.ts` -> `styles.ts`,
`rundmail-zahlen.ts` -> `broadcast-numbers.ts`, `instanz-adresse.ts` -> `instance-address.ts`, `passwort-staerke.ts` -> `password-strength.ts`,
`zweitfaktor.ts` -> `second-factor.ts`, `email-code-fehler.ts` -> `email-code-error.ts`, `texte.ts` -> aufgeloest in `i18n/`.
`api.ts`, `api-client.ts`, `countdown.ts`, `webauthn.ts` bleiben.

Beispiele Einzeldateien: `organisation.service.ts` -> `companies/company.service.ts` (Singular im Dateinamen, Plural nur im Ordner),
`kein-loeschpfad.spec.ts` -> `no-delete-path.spec.ts`, `instanz-aufbau.service.ts` -> `instance-provisioning.service.ts`,
`mandatsnummernkreis.ts` -> `mandate-number-sequence.ts`, `nummernkreis.ts` -> `number-sequence.ts`, `glaeubiger-id.spec.ts` -> `creditor-id.spec.ts`,
`mandatstext.ts` -> `mandate-text.ts`, `formular-seiten.ts` -> `form-pages.ts`, `systemnotiz.ts` -> `system-note.ts`,
`gleichlange-antwort.ts` -> `constant-time-response.ts`, `sperre.service.ts` -> `lockout.service.ts`, `haertung.service.spec.ts` -> `hardening.service.spec.ts`,
`einmal-token.ts` -> `one-time-token.ts`, `zeitzone.spec.ts` -> `timezone.spec.ts`.

### Klassen-/Funktions-/Variablenpraefixe

Klassen: `<Wort>Service/Controller/Module/Guard` mit uebersetztem Wort (`AuthController` bleibt, `ZugangService` -> `AccessService`,
`SperreService` -> `LockoutService`, `SitzungService` -> `SessionService`, `GeraetService` -> `DeviceService`, `NotfallService` -> `EmergencyService`,
`BenutzerService` -> `UserService`, `ErstkontoService` -> `FirstAccountService`, `OrganisationService` -> `CompanyService`,
`InstanzService` -> `InstanceService`, `SicherungService` -> `BackupService`, `AbgleichService` -> `ReconciliationService`,
`KennzahlenAbrufService` -> `MetricsFetchService`, `RechnungService` -> `InvoiceService`, `PreisService` -> `PricingService`,
`ZahlungService` -> `PaymentService`, `VersandService` -> `SendService`, `DokumentService` -> `DocumentService`,
`AufnahmeService` -> `IntakeService`, `OeffentlichService` -> `PublicService`, `EinwilligungService` -> `ConsentService`,
`KryptoService` -> `CryptoService`, `FunktionsschalterService` -> `FeatureFlagService`, `AufgabenService` -> `TasksService`,
`ZeitplanService` -> `ScheduleService`, `PostausgangService` -> `OutboxService`, `VorlageService` -> `TemplateService`,
`WarteschlangeService` -> `QueueService`, `WerbemailService` -> `MarketingMailService`, `NotizService` -> `NoteService`).
Funktionen/Variablen: deutsche Verben/Nomen nach Wortliste; Praefixe `hole` -> `get`/`fetch`, `setze` -> `set`, `pruefe` -> `check`,
`erzeuge` -> `create`, `lege...an` -> `create...`, `aendere` -> `update`, `loesche` -> `delete`, `sende` -> `send`, `zeige` -> `show`,
`archiviere` -> `archive`, `verwerfe` -> `discard`, `widerrufe` -> `revoke`, `ist...` -> `is...`, `normalisiere` -> `normalize`.
Konstanten UPPER_SNAKE: gleiche Uebersetzung (`SITZUNG_` -> `SESSION_`).
Frontend-Funktionen in `lib/api.ts`: `holeOrganisationen` -> `fetchCompanies`, `holeOrganisation` -> `fetchCompany`, `legeOrganisationAn` -> `createCompany`,
`aktualisiereOrganisation` -> `updateCompany`, `aendereOrganisationStatus` -> `changeCompanyStatus`, `loescheOrganisation` -> `deleteCompany`,
`holeInstanzen` -> `fetchInstances`, `legeInstanzAn` -> `createInstance`, `archiviereInstanz` -> `archiveInstance`, `anmelden` -> `login`,
`abmelden` -> `logout`, `holeStand` -> `fetchState`.

## 8. Wortliste (Wurzeln, fuer alles Nicht-Aufgefuehrte)

abgleich reconciliation; abmeldung unsubscribe; abweichung deviation; adresse address; akteur actor; anfrage inquiry; angelegt created;
anmeldung login; ansprechpartnerin contactPerson; anwendung application; aufbau provisioning; aufgabe task; aufnahme intake;
aufraeumen cleanup; aussteller issuer; auth auth; backup backup; benutzer user; bestaetigung confirmation; beschluss decision;
betrag amount; bezahlt paid; bezeichnung label; datum date; demo demo; dringlichkeit urgency; einladung invitation; einladungslink invitationLink;
einrichtung setup; einwilligung consent; empfaenger recipient; entwurf draft; erinnerung reminder; erstkonto firstAccount;
faelligkeit due/dueDate; faktor factor; fehler error; festschreiben finalize; frist deadline; funktionsschalter featureFlag;
geraet device; glaeubiger creditor; groesse size; haertung hardening; herkunft source; inhaber owner; instanz instance; kanal channel;
kennzahl(en) metric(s); konto account; kontingent quota; krypto crypto; leistungszeitraum servicePeriod; loeschen delete; mail mail;
mandat mandate; marke brand; menge quantity; notfall emergency; notiz note; nummernkreis numberSequence; oeffentlich public;
organisation company; passwort password; person person; posten line; postausgang outbox; preis pricing/price; pruefen check;
rahmen layout; rechnung invoice; rundmail broadcast; saeuberer sanitizer; schalter switch/flag; schluessel key; schnappschuss snapshot;
seite page; sicherung backup; sitzung session; sperre lockout/block; sperrliste blocklist; status status; storno cancellation;
stufe tier; subdomain subdomain; testversand testSend; token token; ueberfaellig overdue; ueberpruefung review; uebertragung transfer;
verlauf history/timeline; versand send/delivery; vorlage template; vorschau preview; warteschlange queue; werbe(mail) marketing;
wiederherstellung recovery; zahlung payment; zahlungsdaten paymentDetails; zeitkanal timingChannel (Timing-Angriffs-Schutz); zeitplan schedule;
zeitraum period; zeitspanne timespan; zugang access; zweitfaktor secondFactor; dringend urgent; offen open; gesperrt blocked; aktiv active.

Dringlichkeit-Werte (aufgaben): falls als String-Literal vorhanden `jetzt` -> `now`, `bald` -> `soon`, `spaeter` -> `later`, `info` -> `info`;
andere Literale nach Wortliste. Aufgaben-Quellen-Dateien: `kein-eintrag-lange` -> `no-entry-for-long`, `postausgang-gestoert` -> `outbox-disrupted`,
`organisationsname-abweichung` -> `company-name-mismatch`, `rechnung-faellig` -> `invoice-due`, `rechnung-ueberfaellig` -> `invoice-overdue`,
`audit-aufbewahrung` -> `audit-retention`, `backup-ausgeblieben` -> `backup-missing`, `stufe-pruefen` -> `tier-check`,
`kennzahlen-fehlgeschlagen` -> `metrics-failed`, `anfrage-ohne-reaktion` -> `inquiry-unanswered`, `loeschung-vorschlagen` -> `deletion-suggestion`,
`abgleich-abweichung` -> `reconciliation-deviation`, `statuswechsel-automatisch` -> `status-change-automatic`,
`preisangabe-fehlt` -> `price-missing`; `etappe3-quellen.spec.ts` -> `stage3-sources.spec.ts`.

---------------------------------------------------------------------------------------------------

## 9. Arbeitsgruppen (disjunkt, vollstaendig)

Pfade relativ zu `<Repo-Wurzel>`. `SRC` = `apps/control/src`.
Bereichsgrenzen: Importe aus fremden Gruppen werden auf den Zielnamen nach diesem Glossar umgestellt (auch wenn die Datei noch nicht
umbenannt ist); Restfehler behebt die Reparaturschleife.

### Backend

**B1 - Identitaet, Plattform, Schema** (Auth, Nutzer, Audit, Querschnitt, Prisma, Shared)
- `apps/control/prisma/` (schema.prisma, seed.ts, migrations -> frische Baseline)
- `SRC/auth`, `SRC/benutzer`, `SRC/audit`, `SRC/common`, `SRC/krypto`, `SRC/prisma`, `SRC/cli`, `SRC/navigation`, `SRC/manifest`, `SRC/funktionsschalter`
- Root-Dateien in `SRC`: `main.ts`, `app.module.ts`, `app.module.spec.ts`, `app.module.routen.spec.ts`, `app.controller.ts`, `app.controller.spec.ts`, `version.ts`, `build-inhalt.spec.ts`, `migrationen-zeitstempel.spec.ts`
- `SRC/test-support/anmeldung-aufbau.ts`, `SRC/test-support/prisma-doppel.ts`
- `apps/control` Konfig/Skripte: `package.json`, `tsconfig*.json`, `nest-cli.json`, `jest*.ts`, `Dockerfile`, `Dockerfile.web`, `docker-entrypoint.sh`, `.env.example`, `nginx.conf`, `scripts/`, `public/` (fonts-Ordner)
- `packages/shared/` (gesamt)
- `docs/` (Env-/Routen-Verweise nachziehen, Einschraenkung v1 vermerken)

**B2 - Unternehmen, Aufnahme, Einwilligung**
- `SRC/organisation`, `SRC/notiz`, `SRC/aufnahme`, `SRC/oeffentlich`, `SRC/einwilligung`
- `SRC/test-support/organisation-aufbau.ts`

**B3 - Instanzen, Aufgaben, Zeitplan**
- `SRC/instanz`, `SRC/coolify`, `SRC/aufgaben` (inkl. `quellen/`, `dto/`), `SRC/zeitplan`
- `SRC/test-support/coolify-attrappe.ts`
- R1-Wache: `coolify/kein-loeschpfad.spec.ts` nur umbenennen, Pruefregeln unveraendert.

**B4 - Rechnungen, Mail, Rundmail**
- `SRC/rechnung` (inkl. `dokument/`, `dto/`), `SRC/mail` (inkl. `rahmen/`), `SRC/rundmail`, `SRC/postausgang`, `SRC/utils`

### Frontend

**F1 - Grundgeruest, API-Schicht, i18n, UI-Paket**
- `SRC/lib/` (alle Dateien, inkl. `api.ts`, `api-client.ts`; `texte.ts` -> `i18n/`), neu: `SRC/i18n/` (`index.ts`, `de.ts`, Namespaces)
- `SRC/context/`
- `SRC/App.tsx`, `SRC/App.test.tsx`, `SRC/a11y.test.tsx`, `SRC/browser.tsx`, `SRC/setupTests.ts`, `SRC/vitest-axe.d.ts`, `SRC/index.css`, `SRC/print.css`
- `apps/control/index.html`, `vite.config.mts`, `tsconfig.web.json`
- `packages/ui/` (gesamt; `Auswahl` -> `Select`, `schriften.ts` -> `fonts.ts`, `eintrag-farben.ts` -> `entry-colors.ts` usw.)
- `lib/api.ts` legt die englischen API-Typen/-Funktionen fest, alle anderen F-Gruppen richten sich nach Abschnitt 3-7 (nicht nach Rueckfrage).

**F2 - Anmeldung, Einstellungen, Einwilligung, Dashboard**
- Pages: `AnmeldeSeite`, `NeuesPasswortSeite`, `ErsteinrichtungSeite`, `EinstellungenSeite`, `DashboardSeite`, `EinwilligungenSeite`, `NewsletterSperreSeite` (+ jeweilige `.test.tsx`)
- Components: `AppShell`(+test), `Fehlergrenze`(+test), `Formularfelder`, `Detailblock`, `SchrittIndikator`, `PasskeySchaltflaeche`(+test), `PasswortMitStaerke`, `PasswortStaerkeanzeige`, `TotpEingabe`, `EmailCodeEingabe`, `WiederherstellungscodeEingabe`, `WiederherstellungscodeListe`, `ZweitfaktorAuswahl`, `ZweitfaktorNachweisDialog`, `NutzerVerwaltung`, `SicherheitsProtokoll`, `FunktionsschalterVerwaltung`(+test), `AufgabenAktion`(+test), `EinwilligungNachweis`, `EinwilligungNachweisDialog`, `EinwilligungStatusAbzeichen`, `WortlautFeld`(+test), `MailKanalAbzeichen`

**F3 - Unternehmen und Instanzen**
- Pages: `OrganisationenSeite`, `OrganisationDetailSeite`, `InstanzenSeite` (+ jeweilige `.test.tsx`)
- Components: `OrganisationAnlegenDialog`, `OrganisationLoeschenDialog`, `OrganisationStatusAbzeichen`, `OrganisationUeberblick`, `OrganisationVerlauf`, `VerlaufZeile`, `StatuswechselDialog`, `AnsprechpartnerinDialog`, `KontaktdatenLoeschenDialog`, `ZahlungsdatenKarte`, `AufnahmeKarte`(+test), `AbgleichKarte`, `InstanzAnlegenDialog`, `InstanzArchivierenDialog`, `InstanzKarte`(+test), `InstanzStatusAbzeichen`

**F4 - Rechnungen und Rundmail**
- Pages: `RechnungenSeite`, `RechnungDetailSeite`, `RundmailSeite`, `RundmailVorlageSeite` (+ jeweilige `.test.tsx`)
- Components: `RechnungAnsicht`, `RechnungEntwurfFormular`, `RechnungFestschreibenDialog`, `RechnungPreisvorschlag`, `RechnungStatusAbzeichen`, `RechnungStornierenDialog`, `RechnungenKarte`(+test), `UebertragungVermerkenDialog`, `ZahlungErfassenDialog`, `waehrungszeichen.test.tsx`, `EmpfaengerAuswahlKarte`, `RundmailFortschritt`, `RundmailReiter`, `RundmailTestversandKarte`, `RundmailVersandDialog`, `RundmailVersandlaufKarte`, `RundmailVorschau`, `VorlageAnlegenDialog`, `VorlageFelder`, `VorlageVorschauDialog`

Vollstaendigkeitspruefung: jede Datei unter `apps/control/src/` (Backend-Ordner -> B1-B4, Frontend-Ordner `pages`, `components`, `lib`,
`context`, Root-`.tsx`/`.css` -> F1-F4), `apps/control/prisma`, `packages/shared`, `packages/ui` gehoert genau einer Gruppe.
Neue Dateien (z.B. `i18n/`) gehoeren der Gruppe, die sie anlegt (F1). Tests liegen bei der Gruppe ihres Testobjekts.
