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
| **R1** | **Kein Löschpfad für Instanzen.** Auf Kundeninstanzen gibt es genau zwei Schreibvorgänge: anlegen und stoppen/archivieren, beide nur nach ausdrücklicher Bestätigung. Es gibt keinen Codepfad, der ein Deployment oder eine Datenbank löscht, weder in der Oberfläche noch in der API noch in einem Skript. Die Verwaltung hat genau **eine** Datenbank (die eigene), keine zweite `DATABASE_URL` und keinen SQL-Zugang zu Kundeninstanzen. Das Datenvolumen einer Instanz überlebt jedes Stoppen. | `coolify/no-delete-path.spec.ts` prüft die abschließende Methodenliste der Schnittstelle, sucht HTTP-DELETE und Löschaufrufe gegen Instanz, Kennzahl, Sicherung und Audit-Log; `build-content.spec.ts` hält Prüfcode aus dem Produktionsartefakt |
| **R2** | **Festgeschriebene Rechnungen sind unveränderlich.** Nach dem Festschreiben existiert kein Lösch- und kein Änderungsbefehl. Der Nummernkreis ist lückenlos. | `invoices/invoice-immutable.spec.ts` (Quellbaum), `invoice.integration.spec.ts` (laufender Nachweis) |
| **R3** | **Transaktions- und Werbemails laufen über getrennte Codepfade.** Eine Abmeldung vom Newsletter darf keine Rechnung und keinen Anmeldecode verhindern, und werbliche Mails nutzen keine Einstellung der Transaktionswege. | getrennte Dienste im Modul `mail`, Tests dazu |
| **R4** | **Nichts wird automatisch gelöscht.** Aufgaben wie „Löschung prüfen“ sind Vorschläge, keine Handlung. | Aufgabenquellen im Modul `tasks` lesen nur und schreiben nichts |
| **R5** | **Kein automatischer Schreibvorgang mit Geldfolge.** Zeitgesteuerte Läufe wechseln nur Zustände ohne Geldfolge. Überfälligkeit wird abgeleitet statt geschrieben, Preisvorschläge werden nie ungefragt übernommen. | Modul `schedule` (nur Zustandswechsel ohne Geldfolge) und `tasks` |
| **R6** | **Alles Relevante steht im Audit-Log**, auch gescheiterte Versuche. Schreiben und Protokollieren geschehen in derselben Transaktion: Was nicht protokolliert werden konnte, gilt nicht. | `audit/audit.service.spec.ts` |

**Was R1 nicht ausschließt:** Entwürfe von Rechnungen sind löschbar, Konten und
Geräte lassen sich entfernen, und personenbezogene Kontaktdaten einer
Organisation können auf Anfrage gelöscht werden. Der Satz „kein Löschpfad“ gilt für
Deployments, Datenbanken und Instanzen von Kundschaft sowie für die Nachweise
(Audit-Log, Sicherungsmeldungen, Kennzahlen, festgeschriebene Rechnungen).

Wiederherstellung ist ebenfalls bewusst kein Knopf, sondern Handarbeit auf dem
Server ([backup-and-recovery.md](backup-and-recovery.md)).

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

## 3. Geheimnisse

**Was nie ins Repository gehört:** Werte aus `.env`, Tokens, Schlüssel, Zugangsdaten.
Im Repository liegen nur Beispieldateien mit Platzhaltern (`.env.example`).
`.gitignore` schließt `.env`, `installations/`, `portal/registry.json`,
`.saas-instant-mode` und `backups` aus.

| Geheimnis | Zweck | Besonderheit |
|---|---|---|
| `JWT_SECRET` | signiert Sitzungs- und Vorgangs-Token | wird beim Start geprüft: mindestens 32 Zeichen und kein Beispielwert, sonst startet die Anwendung nicht |
| `CONTROL_CONFIG_KEY` | Schlüssel für ruhende Geheimnisse (Abschnitt 4) | mindestens 32 Zeichen, **kein Entwicklungs-Fallback**; ohne ihn startet die Anwendung nicht |
| `CONTROL_POSTGRES_PASSWORD` | Datenbank der Verwaltung | nur bei der ersten Einrichtung wirksam |
| `CONTROL_BACKUP_KEY` | Meldeweg des Sicherungswerkzeugs | mindestens 32 Zeichen; ungesetzt existiert die Route nicht (404) |
| `CONTROL_INQUIRY_KEY` | Ausweis des Webserver-Proxys für das öffentliche Anfrageformular | derselbe Wert im Proxy der Webseite, mindestens 32 Zeichen; ungesetzt existiert die Route nicht (404) |
| `CONTROL_COOLIFY_TOKEN` | Zugriff auf Coolify | eigenes Token, siehe [coolify-setup.md](coolify-setup.md) |
| `SMTP_PASS`, `CONTROL_INSTANCE_SMTP_PASS` | Postausgang | je Rolle getrennt |
| `SETUP_TOKEN`, `METRICS_TOKEN` je Instanz | Erst-Setup und Kennzahlen | von der Verwaltung erzeugt, je Instanz eigen, verschlüsselt gespeichert |

Grundsätze:

- **Erzeugt wird mit `openssl rand -hex`**, nicht von Hand und nicht von Coolify.
  `install.sh` erzeugt zufällige Werte und schreibt sie in `installations/<slug>/.env`
  mit Rechten 600.
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
  (`x-inquiry-key`) und des Sicherungswegs (`x-backup-key`). Ein Test schickt eine
  echte Anfrage durch den echten Logger und prüft, dass das Geheimnis nicht in der
  Logzeile steht. Tokens in URLs (Bestätigungs- und Abmeldelinks) werden maskiert.
  Container-Logs sind über Coolify einsehbar, ein Geheimnis darin ist kein
  Geheimnis mehr.
- **Nicht ins Audit-Log:** Codes, Passwörter, Wiederherstellungscodes, IBAN. Es wird
  protokolliert, *dass* ein Code angefordert wurde, nie welcher.
- **Rotation:** Wer ein Geheimnis tauscht, muss wissen, was daran hängt. `JWT_SECRET`
  beendet alle Sitzungen. `CONTROL_CONFIG_KEY` macht alle damit verschlüsselten Werte
  unlesbar (siehe unten). Der `CONTROL_BACKUP_KEY` und der Anfrageschlüssel müssen
  gleichzeitig bei der Gegenstelle geändert werden.

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
- **Sicherungszugang auf dem Host.** Die Zugangsdaten zum Sicherungsspeicher liegen
  nicht in Kundencontainern und nicht in der Verwaltung.
- **Seed nur in der Entwicklung.** Das Seed-Skript legt ein Konto mit bekanntem
  Passwort an und läuft nur mit `CONTROL_SEED_ALLOWED=ja`, nie bei
  `NODE_ENV=production`.

## 6. Was in Ihrer Verantwortung bleibt

- Der Server, das Betriebssystem, die Firewall und der Zugriff auf Docker. Wer
  Zugriff auf den Container hat, kann über `emergency` jedes Konto übernehmen.
- Das Coolify-Konto und das Token der Verwaltung.
- Verschlüsselte Datenträger und Backups, der private Backup-Schlüssel im
  Passwortmanager, regelmäßige Rückspielproben.
- DNS und Mail-Authentifizierung (SPF, DKIM, DMARC), siehe [billing.md](billing.md).
- Updates des Betriebssystems, von Docker, Coolify und dieser Software. Die
  Abhängigkeiten werden über `pnpm-workspace.yaml` überschrieben, wo bekannte
  Sicherheitsbefunde es verlangen. Jede dieser Zeilen ist eine Behauptung, die bei
  Updates erneut geprüft gehört.
