# Anmeldung über das Portal (SSO)

Im Modus `portal` melden sich alle Verwaltungen über **einen** Anmeldedienst an,
den Dienst `portal-auth` des Portals. Er ist ein OIDC-Anbieter (Authorization Code
mit PKCE S256, ID-Token mit Ed25519). Ein Konto, ein Passwort, ein zweiter Faktor;
welche Verwaltung das Konto öffnen darf und mit welcher Rolle, steht im Portal.
Im Modus `single` gibt es das alles nicht, dort ändert sich nichts.

Die technischen Einzelheiten des Dienstes stehen in
[apps/portal-auth/README.md](../../apps/portal-auth/README.md), die
Sicherheitsüberlegungen in [security-model.md](security-model.md) (Abschnitt 2a).

## Aufbau

```
Browser ──► Portal-nginx ──► portal-auth ──► portal-auth-db (eigene Postgres)
                │  /auth/** Seiten, /api, /oauth, /.well-known
                │
Browser ──► Verwaltung A (control-web ► control-api) ──┐
Browser ──► Verwaltung B                               ├─► http://portal-auth:3100
                                                       ┘   (Token, JWKS; Netz saas-instant-portal-auth)
```

- `portal-auth` und seine Datenbank gehören zum Compose-Profil `auth` des Portals
  (`apps/portal/docker-compose.portal.yml`). Die Datenbank hat ein eigenes Volume
  (`portal-auth-db`) und hängt nur am Netz des Portals.
- `control-api` jeder Verwaltung hängt zusätzlich am Docker-Netz
  `saas-instant-portal-auth` (`docker-compose.portal-net.yml`, nur wenn
  `AUTH_MODE=portal` in deren `.env` steht). Darüber erreicht sie `portal-auth` intern
  als `http://portal-auth:3100`. Das Netz legen `install.sh` und `bin/saas-instant`
  an. **Beachten:** Verwaltungen am selben Portal können sich in diesem Netz
  gegenseitig auf Port 3001 erreichen; die API verlangt dort ihre eigene Anmeldung.
  Alle Verwaltungen eines Portals gehören demselben Betreiber.
- Öffentlich ist nur das Portal (`/auth/**`, `/oauth/**`, `/.well-known/**`, `/api/**`).
  `portal-auth` selbst veröffentlicht keinen Port.

## Einrichtung

```bash
# lokal zum Ausprobieren (http, nur an 127.0.0.1)
./install.sh --mode portal --software produkt-a --admin-email ich@example.org --admin-name "Vorname Nachname"

# Betrieb hinter TLS
./install.sh --mode portal --software produkt-a \
  --portal-url https://portal.example.com --app-url https://verwaltung-a.example.com \
  --admin-email ich@example.org --admin-name "Vorname Nachname"
```

`install.sh` erledigt im Modus `portal`, in dieser Reihenfolge:

1. `portal/portal.env` (Rechte 600) mit `PORTAL_ISSUER`, `PORTAL_COOKIE_SECURE`,
   `PORTAL_TRUST_PROXY`, `PORTAL_KEY_SECRET` (64 Hex-Zeichen), `PORTAL_DB_PASSWORD`
   und `COMPOSE_PROFILES=auth` ergänzen. Die Registry liegt getrennt davon in
   `portal/registry/registry.json`; nur dieses Verzeichnis sieht der Portal-nginx.
   Eine ältere `portal/registry.json` wird dorthin verschoben. **Es wird nur ergänzt, was fehlt;
   vorhandene Werte und alle Geheimnisse bleiben bei jedem weiteren Lauf unverändert.**
2. Die Verwaltung anlegen und ihre `.env` mit `AUTH_MODE=portal`, `PORTAL_ISSUER`,
   `PORTAL_INTERNAL_URL=http://portal-auth:3100`, `PORTAL_CLIENT_ID` (= Kennung) und
   einem eigenen `PORTAL_CLIENT_SECRET` (64 Hex-Zeichen) schreiben.
3. Das Netz `saas-instant-portal-auth` anlegen, das Portal samt Anmeldedienst
   starten und warten, bis `portal-auth` antwortet.
4. Die Verwaltung beim Anmeldedienst registrieren (`client upsert`; das Secret geht
   über stdin, nie als Argument) und die Verwaltung starten.
5. Beim ersten Mal das erste Portal-Konto anlegen (Portal-Administration) und ihm in
   der ersten Verwaltung die Rolle `admin` geben. **Der Einrichtungslink steht am
   Ende der Ausgabe in einem Kasten.** Er gilt 3 Tage, lässt sich einmal einlösen und
   wird nirgends gespeichert (nur die Adresse des Kontos in `portal/.first-account`).
   Ohne `--admin-email` fragt `install.sh` interaktiv; nicht-interaktiv zeigt es den
   Befehl für später (`bin/saas-instant portal first-account`).

Mit `--no-start` entstehen alle Dateien, ohne dass Docker läuft; Registrierung und
erstes Konto holt man dann mit `bin/saas-instant up` und den `portal`-Befehlen nach.
`--dry-run` zeigt nur, was geschähe.

### Weitere Verwaltung

```bash
bin/saas-instant add produkt-b --name "Produkt B" --app-url https://verwaltung-b.example.com
bin/saas-instant portal set-role ich@example.org produkt-b admin
```

`add` erzeugt ein eigenes Client-Secret, trägt die Portal-Anmeldung in die `.env` ein
und registriert die Verwaltung. Rollen vergibt man danach (oder in der Oberfläche
„Konten und Zugriffe“).

### Bestehende Portal-Installation umstellen

Eine Verwaltung, die vor der SSO-Funktion angelegt wurde, bleibt bei der lokalen
Anmeldung, bis man sie bewusst umstellt (`install.sh` warnt beim erneuten Lauf):

```bash
./install.sh --mode portal --software produkt-a --portal-url https://portal.example.com   # ergänzt portal.env, startet den Anmeldedienst
bin/saas-instant portal enable produkt-a      # AUTH_MODE=portal und Secret in die .env, fragt nach
bin/saas-instant portal register produkt-a
bin/saas-instant up produkt-a
```

Bestehende lokale Konten bleiben `admin`. Danach darf sich lokal nur noch ein
Notzugang anmelden (siehe unten). Wer sich vorher noch nicht über das Portal
angemeldet hat, legt ein Portal-Konto an (`portal first-account` bzw. in „Konten und
Zugriffe“); die Verwaltung verknüpft ein vorhandenes lokales Konto mit derselben
E-Mail-Adresse beim ersten Portal-Login. **Ausgenommen sind Notzugangskonten**
(`emergency=true`): sie werden nie automatisch verknüpft, und ein Portal-Login mit ihrer
Adresse wird mit `401 sso_invalid` abgewiesen. Ein Notzugang soll auch dann
funktionieren, wenn das Portal ausfällt oder falsch eingerichtet ist; ein verknüpftes
Konto bekäme zudem bei jeder Anmeldung die Rolle aus dem Portal. Wer einen Notzugang
auch über das Portal nutzen will, legt dafür ein eigenes, zweites Konto an.

## Ablauf der Anmeldung

1. Das Portal verlinkt auf `{verwaltung}/api/auth/sso/start?return=/&stepup=0`.
2. Die Verwaltung merkt sich `state`, `nonce` und den PKCE-Verifier (einmalig) und
   leitet auf `{portal}/oauth/authorize`.
3. Ist im Portal eine Sitzung offen, kommt der Code ohne Rückfrage; sonst erscheint
   die Anmeldeseite des Portals (Passwort und Authenticator-App oder Passkey).
4. Die Verwaltung tauscht den Code über das interne Netz gegen das ID-Token und
   prüft `state`, Verifier, Signatur (JWKS, nur EdDSA), `iss`, `aud`, `exp`, `iat`
   (60 s Toleranz), `nonce` und `amr`. Fehler geben `401 sso_invalid` ohne Details;
   der Grund steht im Audit-Log.
5. Die Verwaltung legt beim ersten Login das Konto an, übernimmt bei **jedem** Login
   die Rolle aus dem Token und setzt ihre Sitzung. Sie gilt höchstens 12 Stunden,
   damit ein Rollenentzug im Portal bemerkt wird; danach läuft der Login still neu.

Fehlt dem Konto die Rolle in dieser Verwaltung, erscheint die Seite „Kein Zugriff auf
diese Verwaltung“ (403). Es wird weder ein Konto angelegt noch verknüpft.

**Abmelden** beendet die Portal-Sitzung. Das Portal lädt für jede Verwaltung, in der
diese Sitzung angemeldet war, deren Front-Channel-Adresse
(`/api/auth/sso/frontchannel-logout`) in einem unsichtbaren Rahmen; die Verwaltung
beendet alle eigenen Sitzungen mit dieser Portal-Sitzung.

## Rollen

| Rolle | Darf |
|---|---|
| `admin` | alles, auch Einstellungen, Tresor (Einrichten und Entsperren), Wiederherstellung und Übernahme |
| `staff` | Tagesgeschäft: Organisationen, Rechnungen, Zahlungen, Rundmail |

`staff` bekommt `403 forbidden_role` auf den schreibenden Wegen von Firmendaten,
Preisen, Sicherung, Nutzern und Funktionen sowie auf den ganzen Tresor und die
Wiederherstellung. Lesen bleibt erlaubt. Das Entsperren des Tresors nach einem Neustart
darf nur ein `admin`. Im Modus `single` ist jedes Konto `admin`.

Die Rollen pflegt man im Portal („Konten und Zugriffe“, Rolle `portal-admin`) oder auf
der Kommandozeile:

```bash
bin/saas-instant portal set-role <email> <slug> admin|staff|none
```

Eine geänderte Rolle gilt in der Verwaltung beim nächsten Login (spätestens nach 12
Stunden); `none` entzieht den Zugang zu dieser Verwaltung.

## Step-up

Wo bisher ein zweiter Faktor nachzuweisen war (Zahlung, Preise, Sicherung, Tresor, …),
verlangt die Verwaltung in einer Portal-Sitzung einen **frischen Durchlauf** beim
Portal (`max_age=0`). Die Oberfläche öffnet dafür ein Fenster mit der Portal-Anmeldung
und wiederholt danach die Aktion. Gezählt wird nur, wenn die Anmeldung nach dem Start
des Step-ups erfolgte und mit einem zweiten Faktor (Authenticator-App oder Passkey);
der Nachweis gilt 5 Minuten. Ein normaler Login zählt nicht, die erste heikle Aktion
braucht also immer einen Step-up.

## Notzugang

Fällt das Portal aus oder ist der Zugang verloren, kommt man über den Notzugang in die
Verwaltung:

```bash
bin/saas-instant emergency <slug> first-account <email> <name>   # nur in einer leeren Verwaltung
bin/saas-instant emergency <slug> password <kennung>             # Link für ein neues Passwort
bin/saas-instant emergency <slug> enrollment <kennung>           # Link für einen Passkey
```

Diese Kommandos setzen das Konto zugleich auf `emergency=true`. Im Modus `portal` darf
sich lokal **nur** ein solches Konto anmelden; jede andere lokale Anmeldung scheitert
wie ein falsches Passwort (`401 login_failed`, auch bei richtigem Passwort, damit die
Antwort nichts über das Passwort verrät). Die
Anmeldeseite zeigt „Mit dem Portal anmelden“ und einen kleinen Link „Notzugang“. Weitere
Einzelheiten: [emergency-access.md](emergency-access.md). Die Notzugänge sind bewusst
wenige; sie gehören ins Audit-Log wie alle anderen Anmeldungen.

## Wenn das Portal ausfällt

| Was | Folge |
|---|---|
| Laufende Sitzungen der Verwaltungen | bleiben bis zu ihrem Ablauf (höchstens 12 Stunden) gültig |
| Neue Anmeldung, Ablauf einer Sitzung, Step-up | nicht möglich; die Verwaltung zeigt einen Fehler |
| Aktionen mit Step-up | scheitern, solange das Portal fehlt |
| Zugang trotzdem nötig | Notzugang (siehe oben) |
| Launcher | das Portal fällt auf die einfache Liste zurück, wenn `/api/me` nicht antwortet |
| Betrieb der Verwaltungen (Rechnungen, Sicherung, Mails) | läuft unabhängig weiter |

Anmeldedienst prüfen und neu starten:

```bash
docker compose --env-file portal/portal.env -f apps/portal/docker-compose.portal.yml ps
docker compose --env-file portal/portal.env -f apps/portal/docker-compose.portal.yml logs portal-auth
bin/saas-instant up           # startet Verwaltungen und Portal (legt das Netz bei Bedarf an)
```

**Sichern:** Die Datenbank `portal-auth-db` (Konten, Rollen, Schlüssel) und
`portal/portal.env` gehören in die Sicherung, z. B.
`docker compose --env-file portal/portal.env -f apps/portal/docker-compose.portal.yml exec -T portal-auth-db pg_dump -U portal_auth portal_auth > portal-auth.sql`.
Ohne `PORTAL_KEY_SECRET` sind die gespeicherten Signaturschlüssel und TOTP-Geheimnisse
unlesbar; dann müssten alle Konten ihren zweiten Faktor neu einrichten.

## Schlüssel und Geheimnisse wechseln

| Was | Vorgehen | Wirkung |
|---|---|---|
| Signaturschlüssel des Portals | `bin/saas-instant portal key-rotate` | neuer Schlüssel signiert ab sofort; der alte bleibt 15 Minuten im JWKS, damit gerade ausgestellte Token gültig bleiben. Die Verwaltungen laden das JWKS bei unbekannter `kid` nach (höchstens alle 30 s). Kein Neustart nötig. |
| Client-Secret einer Verwaltung | `PORTAL_CLIENT_SECRET` in `installations/<slug>/.env` durch `openssl rand -hex 32` ersetzen, `bin/saas-instant portal register <slug> --force`, `bin/saas-instant up <slug>` | bis zum Neustart schlagen Anmeldungen dieser Verwaltung fehl |
| `PORTAL_KEY_SECRET` | **nicht tauschen.** | macht Signaturschlüssel und TOTP-Geheimnisse unlesbar |
| `PORTAL_DB_PASSWORD` | wirkt nur bei der ersten Einrichtung des Volumes | Wechsel nur zusammen mit `ALTER USER` in der Datenbank |

Ein Konto, das gesperrt ist (fünf Fehlversuche), entsperrt
`bin/saas-instant portal unlock <email>`; einen neuen Einrichtungs- oder
Zurücksetzen-Link gibt `portal setup-link <email>` aus.

## Betrieb hinter TLS

- `--portal-url https://…` setzt `PORTAL_ISSUER` (zugleich der Aussteller `iss` und die
  WebAuthn-Domäne), `PORTAL_COOKIE_SECURE=true` und `PORTAL_TRUST_PROXY=2`. Die Adresse
  lässt sich später nicht mehr ändern, ohne alle Anmeldungen und Passkeys zu
  entwerten; `install.sh` übernimmt eine abweichende `--portal-url` deshalb nicht.
- Die Kette Portal-nginx und TLS-Proxy (`PORTAL_TRUST_PROXY`) muss zur Zahl der Proxys
  passen, sonst ist die Adresse im Audit-Log und im Rate-Limit falsch.
- Das Portal ist an `127.0.0.1` gebunden (`PORTAL_BIND`); der TLS-Proxy steht davor.
- Der TLS-Proxy jeder Verwaltung darf `/api/auth/sso/frontchannel-logout` nicht mit
  `X-Frame-Options` sperren; `apps/control/nginx.conf` erlaubt das Einbetten durch das
  Portal bereits.
- `--app-url https://…` setzt für die Verwaltung `COOKIE_SECURE=1`, `CONTROL_RP_ID` und
  `CONTROL_TRUST_PROXY=2`. Die Redirect-Adresse beim Portal ist `<app-url>/api/auth/sso/callback`.

## Grenzen

- Mehrere Instanzen von `portal-auth` hinter einem Lastverteiler sind nicht vorgesehen
  (das Rate-Limit liegt im Speicher des Prozesses; die Kontosperre in der Datenbank
  schützt trotzdem).
- Einladungen gehen nur als Link (Oberfläche oder Kommandozeile), das Portal versendet
  keine Mails.
- Aktionen in „Konten und Zugriffe“ verlangen keinen frischen zweiten Faktor, nur die
  gültige Sitzung eines Portal-Administrators.
