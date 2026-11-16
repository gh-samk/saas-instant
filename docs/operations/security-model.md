# Sicherheitsmodell

Was saas-instant über Zugriff, Geheimnisse und Verschlüsselung zusagt und wie
diese Zusagen geprüft werden. Wo etwas **nicht** zugesagt wird, steht das
ausdrücklich dabei. Eine Sicherheitslücke melden: [SECURITY.md](../../SECURITY.md).

## 1. Harte Regeln

Diese Regeln gelten unabhängig von Konfiguration. Die wichtigsten sind als
**Abwesenheit** getestet: Die Tests durchsuchen den Quellbaum, statt sich auf eine
Erinnerung oder ein Versprechen zu verlassen. Dazu gehört auch Prüfcode in
`test-support`, der mitgeprüft wird und Ausnahmen benennen muss.

| Regel | Inhalt | Prüfung |
|---|---|---|
| **R1** | **Kein Löschpfad für Instanzen.** Auf Kundeninstanzen gibt es genau zwei Schreibvorgänge der Verwaltung: anlegen und stoppen/archivieren, beide nur nach ausdrücklicher Bestätigung. Es gibt keinen Codepfad, der ein Deployment oder eine Datenbank löscht, weder in der Oberfläche noch in der API noch in einem Skript, **auch nicht im Backup-Agent** (er löscht nur eigene, alte Sicherungsdateien außerhalb von `invoices/`, nie eine Instanz und nie eine Datenbank). Die Verwaltung hat genau **eine** Datenbank (die eigene), keine zweite `DATABASE_URL` und keinen SQL-Zugang zu Kundeninstanzen. Die Wiederherstellung einer Sicherung legt eine **neue** Instanz an und überschreibt nie eine bestehende; die Übernahme **stoppt** die alte, löscht sie nicht. Das Datenvolumen einer Instanz überlebt jedes Stoppen. | `coolify/no-delete-path.spec.ts` prüft die abschließende Methodenliste der Schnittstelle, sucht HTTP-DELETE und Löschaufrufe gegen Instanz, Kennzahl, Sicherung und Audit-Log; `backup-settings/no-delete-backup.spec.ts` prüft dasselbe für den Sicherungsweg; `build-content.spec.ts` hält Prüfcode aus dem Produktionsartefakt; im Agent hält ein Löschwächter (`storage/guard.ts`) Rechnungsarchive (`invoices/`) vom Löschen aus |
| **R2** | **Festgeschriebene Rechnungen sind unveränderlich.** Nach dem Festschreiben existiert kein Lösch- und kein Änderungsbefehl. Der Nummernkreis ist lückenlos. Zusätzlich sperren **Datenbank-Trigger** jede Änderung und Löschung festgeschriebener Rechnungen und des Audit-Logs, unabhängig vom Anwendungscode ([gobd.md](gobd.md)). | `invoices/invoice-immutable.spec.ts` (Quellbaum), `invoice.integration.spec.ts` und `gobd.integration.spec.ts` (laufender Nachweis gegen eine echte Datenbank) |
| **R3** | **Transaktions- und Werbemails laufen über getrennte Codepfade.** Eine Abmeldung vom Newsletter darf keine Rechnung und keinen Anmeldecode verhindern, und werbliche Mails nutzen keine Einstellung der Transaktionswege. | getrennte Dienste im Modul `mail`, Tests dazu |
| **R4** | **Nichts wird automatisch gelöscht, was Kundendaten oder Nachweise trägt.** Aufgaben wie „Löschung prüfen“ sind Vorschläge, keine Handlung. Einzige maschinelle Löschung im Sicherungsweg: der Agent räumt **alte Sicherungsdateien** der Instanzen und der Verwaltung nach der eingestellten Aufbewahrung auf, **nur nach einem gelungenen Lauf**, nie den neuesten Satz und **nie** Rechnungsarchive. | Aufgabenquellen im Modul `tasks` lesen nur und schreiben nichts; Agent-Tests zur Aufbewahrung und zum Löschwächter |
| **R5** | **Kein automatischer Schreibvorgang mit Geldfolge.** Zeitgesteuerte Läufe wechseln nur Zustände ohne Geldfolge. Überfälligkeit wird abgeleitet statt geschrieben, Preisvorschläge werden nie ungefragt übernommen. | Modul `schedule` (nur Zustandswechsel ohne Geldfolge) und `tasks` |
| **R6** | **Alles Relevante steht im Audit-Log**, auch gescheiterte Versuche. Schreiben und Protokollieren geschehen in derselben Transaktion: Was nicht protokolliert werden konnte, gilt nicht. | `audit/audit.service.spec.ts` |

**Was R1 nicht ausschließt:** Entwürfe von Rechnungen sind löschbar, Konten und
Geräte lassen sich entfernen, und personenbezogene Kontaktdaten einer
Organisation können auf Anfrage gelöscht werden. Der Satz „kein Löschpfad“ gilt für
Deployments, Datenbanken und Instanzen von Kundschaft sowie für die Nachweise
(Audit-Log, Sicherungsmeldungen, Kennzahlen, festgeschriebene Rechnungen).

**Sicherung und Wiederherstellung (neu gefasst).** Früher war die Wiederherstellung
reine Handarbeit auf dem Server, und die Verwaltung konnte nichts auslösen. Jetzt
**löst die Verwaltung Sicherung und Wiederherstellung aus, führt sie aber nicht
aus**; das tut der Backup-Agent (Abschnitt 6). Begründet ist die Änderung so: Wer
Sicherungen nie zurückspielt, hat keine. Eine Bedienung in der Oberfläche macht die
Rückspielprobe alltagstauglich. Die Gefahr, die der alte Satz „kein Knopf“
abwehren sollte (ein Fehlgriff überschreibt die Arbeit einer Organisation), ist
auf anderem Weg ausgeschlossen:

- Die Wiederherstellung geht **nur in eine NEUE Instanz** unter neuer Subdomain, nie in
  eine bestehende. Der Agent lehnt den eigenen Stack und den der Verwaltung ab.
- Sie verlangt den zweiten Faktor, das **Eintippen des Instanznamens** und den
  privaten Schlüssel; sie ist gedrosselt (5 je Minute) und auditiert.
- Die **Übernahme** ist ein eigener, bewusst getrennter Schritt: Die alte Instanz wird
  gestoppt, nie gelöscht, und die alten Werte stehen im Audit-Log.

## 2. Anmeldung

**Zwei Wege, kein dritter:**

1. **Benutzername oder E-Mail plus Passwort, danach zwingend ein zweiter Faktor.**
   Der Benutzer wählt bei der Einrichtung unter drei Faktoren: achtstelliger
   Code per E-Mail, TOTP aus einer Authenticator-App oder Passkey. Mindestens einer
   muss eingerichtet sein, und der letzte lässt sich serverseitig nicht entfernen.
   Ersatzweise gilt ein Wiederherstellungscode (acht Stück, einmal verwendbar).
2. **Passkey als einstufige Alternative.** Er ersetzt Passwort und zweiten Faktor
   zugleich.

Ein **Merk-Gerät** überspringt 30 Tage lang nur den zweiten Faktor, nie das
Passwort. Es gibt bewusst **kein „Passwort vergessen“ per E-Mail**. Der
E-Mail-Code ist ein zweiter Faktor und ersetzt das Passwort nie. Ein verlorenes
Anmeldemittel ersetzt der Betreiber im Container ([emergency-access.md](emergency-access.md)).

| Maßnahme | Wert |
|---|---|
| Passwort | mindestens 12 Zeichen, Hash mit **argon2id** |
| Fehlversuche | ab dem fünften Fehlversuch 15 Minuten Kontosperre, selbstheilend (sonst wäre die Sperre ein Denial-of-Service gegen den bekannten Benutzer) |
| E-Mail-Code | 8 Stellen, 10 Minuten gültig, nach 3 Fehleingaben verbrannt; die Zahl liegt bewusst unter der Kontosperre, damit man sich nicht durch Raten aussperrt |
| Anmelderoute | 5 Versuche je Minute; übrige Routen 100 je Minute |
| Antworten der Anmeldung | gleich für bekannte und unbekannte Konten, mit Scheinhash gegen Zeitunterschiede: die Anmeldeseite ist kein Kontoverzeichnis |
| Sitzung | httpOnly-Cookie, `SameSite=Strict`, `Secure` hinter TLS, 30 Tage und erneuert sich bei Nutzung einmal je Tag; absolute Obergrenze 90 Tage ab der Anmeldung, auch bei laufender Erneuerung |
| laufender Anmeldevorgang | eigenes kurzlebiges Cookie, 10 Minuten |
| Beenden aller Sitzungen | „Abmelden“, „Alle abmelden“, Passwortwechsel und jede Passkey-Änderung beenden sofort alle laufenden Sitzungen des Kontos |
| TOTP-Codes | einmalig verwendbar: der Zeitschritt des zuletzt angenommenen Codes wird gespeichert (atomar), derselbe Code wird nicht ein zweites Mal akzeptiert |
| CSRF | Double-Submit-Cookie, ein Ausnahmeweg muss begründet sein (`@WithoutCsrf`) |

**Zweiter Faktor für sensible Aktionen.** Zahlungsdaten ansehen, Zahlungen
vermerken, Übertragung an die Buchhaltung vermerken und weitere unumkehrbare
Vorgänge verlangen zusätzlich den Nachweis (Passwort oder TOTP-Code) im Request.
Eine frische Sitzung (unter zehn Minuten) ist davon ausgenommen. Das Kriterium:
Alltägliche Arbeit, die sichtbare Spuren hinterlässt, nicht, aber alles, was
lautlos wirkt. `auth/access-routes.spec.ts` hält fest, welche Routen der
Kontoverwaltung den Nachweis verlangen, damit keine vergessen wird.

**Notfallzugang** erzeugt nur **Links** (15 Minuten, einmalig), nie ein Passwort.
Ein Passkey kann nur im Browser entstehen.

## 2a. Anmeldung über das Portal (Modus portal)

Im Modus `portal` ersetzt der Anmeldedienst `portal-auth` die lokale Anmeldung der
Verwaltungen; Ablauf, Rollen, Step-up und Betrieb stehen in [sso.md](sso.md). Die
Sicherheitsannahmen:

- **Ein Anbieter, eine Prüfung.** Die Verwaltung nimmt nur ein ID-Token an, das sie
  selbst über Authorization Code mit PKCE S256 geholt hat: `state` (Cookie) und `nonce`
  sind einmalig, Signatur nur EdDSA über das JWKS des Portals, dazu `iss`, `aud`, `exp`,
  `iat` (60 s) und ein nicht leeres `amr`. Fehler nach außen immer `401 sso_invalid`.
- **Rolle aus dem Token, bei jedem Login.** `roles[<Kennung>]` entscheidet. Ohne Rolle
  kein Konto und kein Zugang. `staff` kann nichts an Einstellungen, Tresor und
  Wiederherstellung schreiben (`403 forbidden_role`); im Modus `single` ist jedes
  Konto `admin`.
- **Step-up.** Wo ein zweiter Faktor verlangt wird, braucht eine Portal-Sitzung einen
  frischen Durchlauf mit zweitem Faktor (höchstens 5 Minuten alt).
- **Notzugang ohne Portal nur für markierte Konten.** Lokal anmelden darf nur
  `emergency=true` (`403 local_login_disabled` sonst); gesetzt wird das nur durch die
  Notfallkommandos im Container.
- **Sitzungen** einer Portal-Anmeldung gelten höchstens 12 Stunden; die
  Front-Channel-Abmeldung beendet alle Sitzungen einer Portal-Sitzung.
- **Geheimnisse des Portals:** `PORTAL_KEY_SECRET` (verschlüsselt Signaturschlüssel und
  TOTP-Geheimnisse, nicht wechselbar), `PORTAL_DB_PASSWORD`, je Verwaltung ein eigenes
  `PORTAL_CLIENT_SECRET` (argon2id-Hash im Portal, Klartext nur in der `.env` der
  Verwaltung). Alle von `install.sh` mit `openssl rand -hex` erzeugt, in Dateien mit
  Rechten 600, nie als Argument einer Prozessliste (`client upsert` liest über stdin).
  Der Einrichtungslink des ersten Kontos wird nur einmal angezeigt und nicht gespeichert.
- **Netz.** `portal-auth` hat keinen veröffentlichten Port; die Verwaltungen erreichen
  es über das Docker-Netz `saas-instant-portal-auth`. Die Datenbank des Anmeldedienstes
  liegt nicht in diesem Netz. Verwaltungen am selben Portal sehen sich in dem Netz
  untereinander (gleicher Betreiber vorausgesetzt).
- **Portalausfall:** laufende Sitzungen bleiben bis zum Ablauf, neue Anmeldungen und
  Step-ups fehlen; der Notzugang bleibt.

## 3. Geheimnisse

**Was nie ins Repository gehört:** Werte aus `.env`, Tokens, Schlüssel, Zugangsdaten.
Im Repository liegen nur Beispieldateien mit Platzhaltern (`.env.example`).
`.gitignore` schließt `.env`, `installations/`, `portal/registry.json`, `portal/registry/`,
`.saas-instant-mode` und `backups` aus.

| Geheimnis | Zweck | Besonderheit |
|---|---|---|
| `JWT_SECRET` | signiert Sitzungs- und Vorgangs-Token | wird beim Start geprüft: mindestens 32 Zeichen und kein Beispielwert, sonst startet die Anwendung nicht |
| `CONTROL_CONFIG_KEY` | Schlüssel für ruhende Geheimnisse (Abschnitt 4) | mindestens 32 Zeichen, **kein Entwicklungs-Fallback**; ohne ihn startet die Anwendung nicht |
| `CONTROL_POSTGRES_PASSWORD` | Datenbank der Verwaltung | nur bei der ersten Einrichtung wirksam |
| `CONTROL_BACKUP_KEY` | Meldeweg und Sicherungsplan: Ausweis des Agents bei der Verwaltung (Header `x-backup-key`) | mindestens 32 Zeichen, gleich dem `BACKUP_REPORT_KEY` des Agents; ungesetzt existieren `POST /api/backups` und `GET /api/internal/backup-plan` nicht (404) |
| `BACKUP_AGENT_SECRET` | signiert die Aufträge der Verwaltung an den Agent (HMAC-SHA256) | von `install.sh` erzeugt; Verwaltung und Agent kennen ihn, sonst niemand |
| `AGENT_STATE_KEY` | verschlüsselt (AES-256-GCM) die Zugangsdaten zum Sicherungsziel im State-Volume des Agents | nur der Agent kennt ihn; die Verwaltung nicht |
| `BACKUP_REPORT_KEY` | Umgebungsvariable des Agents für denselben Wert wie `CONTROL_BACKUP_KEY` | siehe oben |
| `CONTROL_INQUIRY_KEY` | Ausweis des Webserver-Proxys für das öffentliche Anfrageformular | derselbe Wert im Proxy der Webseite, mindestens 32 Zeichen; ungesetzt existiert die Route nicht (404) |
| `CONTROL_COOLIFY_TOKEN` | Zugriff auf Coolify | eigenes Token, siehe [coolify-setup.md](coolify-setup.md) |
| `SMTP_PASS`, `CONTROL_INSTANCE_SMTP_PASS` | Postausgang | je Rolle getrennt |
| `PORTAL_KEY_SECRET`, `PORTAL_DB_PASSWORD` (`portal/portal.env`, nur Modus portal) | Anmeldedienst: Schlüsselmaterial und Datenbank | nicht wechseln, siehe [sso.md](sso.md) |
| `PORTAL_CLIENT_SECRET` je Verwaltung (Modus portal) | Ausweis der Verwaltung beim Token-Endpunkt des Portals | je Verwaltung eigen; Wechsel mit `portal register <slug> --force` |
| `SETUP_TOKEN`, `METRICS_TOKEN` je Instanz | Erst-Setup und Kennzahlen | von der Verwaltung erzeugt, je Instanz eigen, verschlüsselt gespeichert |

Grundsätze:

- **Erzeugt wird mit `openssl rand -hex`**, nicht von Hand und nicht von Coolify.
  `install.sh` erzeugt zufällige Werte und schreibt sie in `installations/<slug>/.env`
  (im Modus `portal` zusätzlich in `portal/portal.env`) mit Rechten 600.
- **Der Portal-nginx sieht nur die Registry.** In ihn wird allein
  `portal/registry/` (mit `registry.json`, ohne Geheimnisse) schreibgeschützt
  gemountet, nicht das Verzeichnis `portal/`. `portal/portal.env` mit
  `PORTAL_KEY_SECRET`, `PORTAL_DB_PASSWORD` und den Client-Secrets bleibt außerhalb;
  Dateirechte und `cap_drop` sind damit nicht mehr die einzige Schutzschicht.
  Eine ältere `portal/registry.json` verschiebt `install.sh` bzw. `bin/saas-instant`
  beim nächsten Lauf dorthin (idempotent, ohne neue Geheimnisse).
- **Pflichtschlüssel sind bei Fehlen ein Startfehler**, kein stiller Rückfall auf
  einen bekannten Wert. Dasselbe gilt für eine fehlerhafte Preistafel, eine
  Absenderadresse auf der falschen Domäne und `SMTP_TLS_ERZWINGEN=0` in Produktion:
  Was sich abschalten ließe, bliebe nach der nächsten Fehlersuche abgeschaltet.
- **Die Schlüsselprüfung der Zugänge ohne Sitzung** (Anfrage- und Sicherungsweg)
  vergleicht in konstanter Zeit über SHA-256-Abdrücke und `timingSafeEqual`.
- **Das Setup-Token ist einmalig.** Nach erfolgreichem Setup lehnt die Instanz es
  ab (`410`). Das Kennzahlen-Token liest nur, es schaltet nichts anderes frei. Beide
  werden nie geloggt ([../instance-contract.md](../instance-contract.md)).
- **Nicht ins Log:** Der Request-Logger schwärzt `Cookie`, `X-CSRF-Token`,
  `Authorization`, `Set-Cookie` sowie die Schlüssel-Header des Anfragewegs
  (`x-inquiry-key`) und des Sicherungswegs (`x-backup-key`); der Agent
  schwärzt seine Zugangsdaten und den privaten Schlüssel in jeder Meldung und jedem Log. Ein Test schickt eine
  echte Anfrage durch den echten Logger und prüft, dass das Geheimnis nicht in der
  Logzeile steht. Tokens in URLs (Bestätigungs- und Abmeldelinks) werden maskiert.
  Container-Logs sind über Coolify einsehbar, ein Geheimnis darin ist kein
  Geheimnis mehr.
- **Nicht ins Audit-Log:** Codes, Passwörter, Wiederherstellungscodes, IBAN. Es wird
  protokolliert, *dass* ein Code angefordert wurde, nie welcher.
- **Rotation:** Wer ein Geheimnis tauscht, muss wissen, was daran hängt. `JWT_SECRET`
  beendet alle Sitzungen. `CONTROL_CONFIG_KEY` macht alle damit verschlüsselten Werte
  unlesbar (siehe unten). Der `CONTROL_BACKUP_KEY` (= `BACKUP_REPORT_KEY` des Agents)
  und der Anfrageschlüssel müssen gleichzeitig bei der Gegenstelle geändert werden.
  Ein neuer `BACKUP_AGENT_SECRET` muss in Verwaltung und Agent zugleich gesetzt werden.
  Wer `AGENT_STATE_KEY` tauscht, macht die gespeicherten Zugangsdaten im Agent
  unlesbar; das Ziel muss dann neu eingerichtet werden.

## 4. Verschlüsselung

**Ruhende Geheimnisse:** TOTP-Geheimnisse und die Tokens der Instanzen (Setup,
Kennzahlen) werden anwendungsseitig mit **AES-256-GCM** verschlüsselt. Der
Schlüssel wird aus `CONTROL_CONFIG_KEY` abgeleitet (scrypt, fester Salt, damit er
über Neustarts stabil bleibt). Jeder Wert bekommt einen frischen Initialisierungs-
vektor. Entschlüsseln wirft bei falschem Schlüssel oder manipuliertem Wert einen
Fehler, es gibt kein stilles `null`, das als „kein TOTP eingerichtet“ durchginge.
**Wird der Schlüssel getauscht, sind diese Werte unlesbar**, TOTP muss neu
eingerichtet werden, Instanz-Tokens müssen neu gesetzt werden.

**Was nicht anwendungsseitig verschlüsselt ist:** Kundenstammdaten und Bankdaten
(IBAN, BIC, Mandat) liegen als normale Datenbankfelder. Der Schutz ist die
Zugriffskontrolle (zweiter Faktor, Audit) und die Verschlüsselung außerhalb der
Anwendung: verschlüsselter Datenträger des Servers und verschlüsselte, asymmetrisch
gesicherte Backups. Das ist Aufgabe des Betreibers.

**Transport:**

- Die Oberfläche läuft nur hinter TLS (`COOKIE_SECURE=1`). HSTS und eine strenge
  Content-Security-Policy (`default-src 'self'`, `frame-ancestors 'none'`,
  `object-src 'none'`) setzt der mitgelieferte nginx, dazu `X-Content-Type-Options`,
  `X-Frame-Options`, `Referrer-Policy` und `Permissions-Policy`.
  `X-Robots-Tag: noindex` hält die Verwaltung aus Suchmaschinen.
- Mailversand: `SMTP_TLS_ERZWINGEN=1` (Vorgabe) bricht den Versand ab, wenn die
  Gegenseite kein STARTTLS anbietet, sonst könnten Anmeldecode und Zugangsdaten im
  Klartext über die Leitung gehen. In Produktion mit Wert 0 startet die Anwendung
  nicht.
- Aufrufe an Instanzen (Health, Setup-Status, Kennzahlen) laufen über HTTPS mit
  kurzer Zeitgrenze. Antworten, die nicht der erwarteten Form entsprechen, werden
  verworfen, nicht halb übernommen.
- Der Rechnungsdienst hat weder Anmeldung noch Rechteprüfung und gehört
  ausschließlich ins interne Netz, ohne Domain und ohne veröffentlichten Port.
- Der Docker-Port von `control-web` ist standardmäßig an `127.0.0.1` gebunden (`CONTROL_WEB_BIND`). Wer ihn auf eine öffentliche Adresse legt, muss ihn per Firewall außerhalb von Docker schützen, weil `X-Forwarded-For` sonst frei wählbar ist.
- `CONTROL_TRUST_PROXY` muss genau zur Zahl der Proxys passen (0, 1 oder 2; `CONTROL_INQUIRY_TRUST_PROXY` für den Anfrageweg je nach Kette 2 bis 4, siehe [installation.md](../installation.md)). Zu hoch
  macht die IP im Audit-Log und das Rate-Limit fälschbar, zu niedrig bewirkt nur,
  dass die Adresse des Proxys im Log steht.

## 5. Trennung

- **Eine Verwaltung je Software.** Im Modus `portal` hat jede Verwaltung eigene
  Datenbank, eigenes Volume, eigenes Netz und eigene Anmeldung. Das Portal ist nur
  eine Liste mit Links, ohne Kundendaten und ohne Anmeldung. Der Modus ist nach der
  Erstinstallation unveränderlich (`.saas-instant-mode`).
- **Pull statt Push.** Die Verwaltung fragt Kennzahlen bei den Instanzen ab, keine
  Instanz schickt etwas an die Verwaltung. Fällt die Verwaltung aus, merken die
  Kundeninstanzen davon nichts. Der einzige Weg ohne Sitzung **in** die Verwaltung
  sind der Anfrageweg und der Sicherungsmeldeweg, beide hinter einem Schlüssel,
  beide ohne Schlüssel gar nicht vorhanden.
- **Kein Aufzählungsorakel.** Der Sicherungsmeldeweg antwortet für bekannte und
  unbekannte Subdomains gleich, damit sich mit dem Schlüssel keine Kundenliste
  abfragen lässt.
- **Sicherungszugang nur im Agent.** Die Zugangsdaten zum Sicherungsspeicher liegen
  nicht in Kundencontainern und nicht in der Verwaltung, sondern ausschließlich
  verschlüsselt im State-Volume des Backup-Agents (Abschnitt 6).
- **Seed nur in der Entwicklung.** Das Seed-Skript legt ein Konto mit bekanntem
  Passwort an und läuft nur mit `CONTROL_SEED_ALLOWED=ja`, nie bei
  `NODE_ENV=production`.

## 6. Backup-Agent

Der Backup-Agent (`apps/backup-agent`) ist der **einzige** Ort mit Zugangsdaten zum
Sicherungsspeicher und mit Docker-Zugriff. Aufbau und Betrieb:
[backup-and-recovery.md](backup-and-recovery.md). Was er zusagt:

| Zusage | Umsetzung |
|---|---|
| Nur die Verwaltung darf Aufträge geben | jede Anfrage ist **HMAC-signiert** (`BACKUP_AGENT_SECRET`) mit Zeitstempel und Nonce: Abweichung über 60 s, wiederholte Nonce (5 Minuten Gedächtnis), falsche Signatur (zeitkonstanter Vergleich) und Body über 1 MiB werden abgelehnt (`apps/backup-agent/src/hmac.ts`) |
| Kein Weg von außen | kein veröffentlichter Port; erreichbar nur im Compose-Netz; `read_only`, ohne Linux-Capabilities, `no-new-privileges`, läuft nicht als root |
| Docker nur mit Mindestrechten | Zugriff nur über **`docker-socket-proxy`** mit Allowlist: `CONTAINERS`, `EXEC` und `POST` an; `IMAGES`, `NETWORKS`, `VOLUMES`, `SERVICES`, `SWARM` und weitere aus; der Socket ist nur dort und nur lesend gemountet (geprüft von `tests/install.test.sh`) |
| Geheimnisse nur im Agent | Zugangsdaten zum Ziel liegen im Agent mit AES-256-GCM verschlüsselt (`AGENT_STATE_KEY`); die Verwaltung hält und liefert sie nie |
| Geheimnisse **write-only** in der Oberfläche | Eingabe geht über die Verwaltung an den Agent und kommt nie zurück; weder Datenbank noch Audit-Log noch Log der Verwaltung sehen sie |
| Sicherungen sind nur mit dem Betreiberschlüssel lesbar | Verschlüsselung mit **age** (nur der öffentliche Schlüssel im Agent); der private Schlüssel wird einmal angezeigt und nirgends gespeichert; bei der Wiederherstellung kommt er write-only, nur im Arbeitsspeicher |
| Wiederherstellung nur in neue, fremde Stacks | Zielprojekt muss das Compose-Label tragen und darf weder der Stack des Agents noch der der Verwaltung sein; nicht ermittelbarer eigener Stack bedeutet Ablehnung |
| Der Dump enthält keinen Klartext sensibler Felder | die Verwaltungs-Datenbank hält Chiffretext; wer den Dump hat, braucht zum Lesen Passphrase oder Wiederherstellungsschlüssel (Tresor). Das Rechnungsarchiv ist davon getrennt und mit age lesbar |
| Der Agent hat keinen SQL-Zugriff auf Rechnungen | er holt das Archiv über `GET /api/internal/invoice-archive` (nur mit `x-backup-key`, nur im entsperrten Zustand, sonst 423), prüft je Dokument die SHA-256 und verschlüsselt mit age; bei 423 meldet er den Lauf als `deferred` und versucht es erneut. `CONTROL_DATABASE_URL` dient nur dem `pg_dump` |
| Rechnungsarchive bleiben | der Agent löscht nie unter `invoices/`; bei S3 mit Object Lock (GOVERNANCE) versehen |

**Das Restrisiko:** Auch durch den Proxy bleibt `EXEC` auf Containern des Hosts ein
mächtiges Recht. Wer den Agent übernimmt, kann Befehle in anderen Containern
ausführen. Schutz sind die fehlende Erreichbarkeit von außen, die Signatur und ein
gepflegter Host; gelöst ist das Risiko nicht.

**Nicht zugesichert:** Der Agent ist gegen eine kleine Compose-Attrappe getestet,
nicht gegen eine echte Coolify-Installation. Die Verifikation in der Verwaltung ist
eine Prüfsumme der verschlüsselten Datei, kein Entschlüsselungstest (der Schlüssel
liegt nicht auf dem Server).

## 7. Was in Ihrer Verantwortung bleibt

- Der Server, das Betriebssystem, die Firewall und der Zugriff auf Docker. Wer
  Zugriff auf den Container hat, kann über `emergency` jedes Konto übernehmen.
- Das Coolify-Konto und das Token der Verwaltung.
- Verschlüsselte Datenträger und Backups, der private Backup-Schlüssel im
  Passwortmanager (er wird nur einmal angezeigt), regelmäßige Rückspielproben mit
  diesem Schlüssel; die Einrichtung von Object Lock am Bucket.
- Die Datenbankrolle der Anwendung (kein `TRUNCATE`, nicht Eigentümerin der Tabellen),
  damit die GoBD-Trigger greifen ([gobd.md](gobd.md), Abschnitt 10).
- DNS und Mail-Authentifizierung (SPF, DKIM, DMARC), siehe [billing.md](billing.md).
- Updates des Betriebssystems, von Docker, Coolify und dieser Software. Die
  Abhängigkeiten werden über `pnpm-workspace.yaml` überschrieben, wo bekannte
  Sicherheitsbefunde es verlangen. Jede dieser Zeilen ist eine Behauptung, die bei
  Updates erneut geprüft gehört.
