# Coolify einrichten

saas-instant legt Instanzen über eine Schnittstelle (`Provisioner`) an. In v1
gibt es genau einen Anbieter: **Coolify** (v4, API unter `/api/v1`). Dieses
Dokument beschreibt zwei Dinge: wie die Verwaltung selbst in Coolify läuft und wie
sie Coolify bedient, um Kundeninstanzen anzulegen.

Die Anbindung spricht Coolify über die HTTP-API an und kennt nur diese Aufrufe:
Anwendungen und Version lesen, Anwendung anlegen, Umgebungsvariablen setzen,
Domäne setzen, ausrollen, Deployment abfragen, Anwendung stoppen. Einen Aufruf
zum Löschen gibt es nicht (Regel R1, siehe [security-model.md](security-model.md)).
Die Pfade stammen aus `reference/provision-tenant.py`, dem Referenzskript für den
Ablauf. Die automatischen Tests laufen gegen eine Attrappe von Coolify. **Das
erste echte Anlegen ist deshalb zugleich der Testfall.** Abschnitt 5 beschreibt,
wie man das Risiko klein hält.

## 1. Was vorher stehen muss

- Eine laufende Coolify-Installation mit einem Server, einem Projekt und einer
  Umgebung (üblicherweise `production`).
- Ein **Deploy-Key** in Coolify, der lesend am Git-Repository mit der
  Instanz-Compose hängt.
- Ein **Wildcard-DNS-Eintrag** `*.<basisdomäne>` auf den Server.
- Die **Instanz-Compose** im Git-Repository (Vorlage: `docker-compose.coolify.yml`,
  angepasst auf die Software). Der Dienst, an dem die Domäne hängt, heißt `web`.
- Die Software erfüllt den Instanz-Vertrag ([../instance-contract.md](../instance-contract.md)).
- Ein Postausgang, den alle Instanzen gemeinsam nutzen (Abschnitt 3).

## 2. Die Verwaltung in Coolify bereitstellen

Vorlage ist `reference/docker-compose.control.coolify.yml`. Coolifys Traefik
terminiert TLS und routet die am Dienst `control-web` gesetzte Domain auf
`control-web:80`. Der nginx dort liefert die Oberfläche und leitet `/api` an
`control-api` weiter. `control-db` und `control-api` bleiben intern.

1. Anwendung in Coolify aus dem Compose-Typ anlegen, Domain am Dienst
   `control-web` setzen.
2. **Vor dem ersten Ausrollen** alle Geheimnisse selbst setzen (siehe Abschnitt 4,
   „Pflichtform“). Erzeugen mit `openssl rand -hex 32`:
   `CONTROL_POSTGRES_PASSWORD`, `JWT_SECRET`, `CONTROL_CONFIG_KEY`
   (mindestens 32 Zeichen, die Anwendung startet sonst nicht).
3. Adressen passend zur Domain setzen: `CONTROL_APP_URL=https://<verwaltung>`,
   `CONTROL_RP_ID=<verwaltung ohne Schema und Port>`. Passt die RP-ID nicht,
   lassen sich bestehende Passkeys nicht mehr verwenden.
4. `COOKIE_SECURE=1` und `CONTROL_TRUST_PROXY=2` (Traefik, dann nginx). Ein zu
   hoher Wert ist gefährlich: Ein selbst gesetzter `X-Forwarded-For` würde
   geglaubt, die IP im Audit-Log wäre erfunden und das Rate-Limit umgehbar.
5. Postausgang `SMTP_*` setzen. Ohne ihn gehen keine Anmeldecodes für weitere
   Konten hinaus. Das erste Konto kommt über den Passkey-Weg auch ohne Mail hinein.
6. Ausrollen. Beim Start laufen die Migrationen von selbst.
7. **Erstes Konto anlegen**, im Container der Verwaltung:
   `node dist/cli/emergency.js first-account <email> <name>`
   ([emergency-access.md](emergency-access.md)).

**Nach dem Ausrollen prüfen:**

- `GET /api/health` antwortet. Ist der Postausgang gestört, steht dort
  `status: "beeintraechtigt"` mit dem letzten Fehler.
- Die Oberfläche lädt, die Sicherheits-Kopfzeilen sind da (CSP, HSTS,
  `X-Content-Type-Options`, `X-Frame-Options`, `Referrer-Policy`,
  `Permissions-Policy`).
- Geschützte Routen antworten ohne Anmeldung mit 401.
- Das Rate-Limit der Anmeldung greift (fünf Versuche je Minute).

## 3. Coolify an die Verwaltung anbinden

Je Wert gilt die Rangfolge **Umgebungsvariable, dann Manifest (Abschnitt
`provisioning`), dann neutrale Vorgabe**. Fehlen Token oder Adresse, antwortet die
Instanzverwaltung sichtbar mit `503` (`coolify_nicht_eingerichtet`), statt still
nichts zu tun.

| Variable | Bedeutung |
|---|---|
| `CONTROL_COOLIFY_API_URL` | API-Adresse, z. B. `http://<host>:8000/api/v1`; muss mit `http://` oder `https://` beginnen |
| `CONTROL_COOLIFY_TOKEN` | API-Token, **eigenes** für die Verwaltung |
| `CONTROL_COOLIFY_PROJECT_UUID` | Projekt, in dem Instanzen entstehen (keine Vorgabe) |
| `CONTROL_COOLIFY_SERVER_UUID` | Server der Instanzen (keine Vorgabe) |
| `CONTROL_COOLIFY_DEPLOY_KEY_UUID` | Deploy-Key des Compose-Repositories (keine Vorgabe) |
| `CONTROL_COOLIFY_REPO` | Git-Adresse der Instanz-Compose, alternativ `provisioning.repository` im Manifest |
| `CONTROL_COOLIFY_COMPOSE` | Pfad der Compose-Datei, alternativ `provisioning.composePath` |
| `CONTROL_COOLIFY_BRANCH` | Branch, Vorgabe `main` |
| `CONTROL_COOLIFY_UMGEBUNG` | Coolify-Umgebung, üblicherweise `production` |
| `CONTROL_INSTANCE_BASE_DOMAIN` | Basisdomäne der Instanzen, alternativ `provisioning.instanceDomainBase` |
| `CONTROL_INSTANCE_PREFIX` | Präfix der Coolify-Anwendungen: `<präfix>-<subdomain>` |
| `CONTROL_INSTANCE_SMTP_HOST`, `_PORT`, `_USER`, `_PASS`, `_FROM` | Postausgang, den die Verwaltung an **jede** neue Instanz weiterreicht |
| `CONTROL_COOLIFY_OWN_APPLICATIONS` | eigene Anwendungen (mit Präfix), die der Abgleich nicht als verwaist meldet |

Fehlen `_SMTP_HOST` oder `_SMTP_FROM`, **lehnt die Verwaltung das Anlegen ab**,
schon bei der Vorschau. Eine Instanz ohne Mailversand wäre stumm, weil weder
Einladungen noch Passwort-Zurücksetzen ankämen. `_FROM` muss eine Adresse sein,
die der Postausgang für das angemeldete Konto zulässt.

### API-Token

In Coolify unter *Keys & Tokens → API tokens* ein **eigenes Token für die
Verwaltung** anlegen. Nicht das persönliche des Betreibers oder das eines Skripts
wiederverwenden: Sonst lässt sich später nicht unterscheiden, wer was angelegt
hat, und ein Widerruf träfe immer beide.

- Rechte so klein wie möglich: lesen, schreiben, deployen. **Kein `root`.**
- **Kein `read:sensitive`.** Dann sieht das Token keine Geheimnisse anderer
  Anwendungen. Die Verwaltung ist darauf eingerichtet (siehe unten, „Das Token
  sieht die Compose-Datei nicht“).
- Coolify-Tokens unterscheiden Schreiben und Löschen nicht fein. Dass nichts
  gelöscht wird, garantiert deshalb der Code der Verwaltung und nicht das Token.
  Das Token trotzdem nur dafür ausgeben, nicht weiter.
- Ablegen im Passwortmanager und als Geheimnis in der Umgebung der Verwaltung,
  nie im Repository.

### Erreichbarkeit der API aus dem Container

`localhost` zeigt im Container auf den Container selbst. Zwei Wege tragen, je
nach Server:

1. `http://host.docker.internal:8000/api/v1`. Die Compose bringt dafür
   `extra_hosts: host.docker.internal:host-gateway` mit. Das trägt nur, wenn
   Coolify auf dem Host nicht ausschließlich an `127.0.0.1` lauscht und die
   Firewall Container-zu-Host nicht sperrt.
2. `http://coolify:8080/api/v1` über Coolifys eigenes Docker-Netz. Dafür die
   Anwendung der Verwaltung an das Netz `coolify` hängen („Connect to predefined
   network“).

Ist die Coolify-API von außen gesperrt, lässt sich für **Prüfungen von Hand** ein
SSH-Tunnel nutzen (`ssh -fN -L 8000:localhost:8000 <server>`). Er dient nur dem
Trockenlauf, nicht dem Betrieb der Verwaltung.

## 4. Fallen, die Coolify aufstellt

Jede dieser Fallen hat bei der ersten Inbetriebnahme einen Ausfall verursacht und
ist inzwischen im Code oder in Tests abgefangen. Sie gelten genauso für jede
neue Compose-Datei.

### Pflichtform `${VAR:?Meldung}`: die Meldung wird zum Wert

Coolify liest die Compose-Datei und legt für jede erwähnte Variable einen Eintrag
an. Bei der Pflichtform nimmt es **die Fehlermeldung als Wert** und erzeugt keinen
Zufallswert. Ein Datenbankpasswort, das aus einem Satz der Compose-Datei besteht,
hat null Entropie. Eine Prüfung „mindestens 32 Zeichen“ gibt dabei keine
Entwarnung: Länge ist keine Zufälligkeit.

Regel für jedes Anlegen über Oberfläche oder API:

1. Nach dem Anlegen und **vor dem ersten Ausrollen** jeden Wert überschreiben, der
   in der Compose-Datei als `:?` geführt ist.
2. Gegenprüfen, dass kein Wert den Wortlaut einer Fehlermeldung (zum Beispiel
   „muss gesetzt sein“) enthält.
3. Geheimnisse mit `openssl rand -hex 32` erzeugen, nicht von Coolify.

Postgres übernimmt sein Passwort nur bei der **ersten** Einrichtung. Fällt der
Fehler erst nach dem Ausrollen auf, genügt das Ändern der Variable nicht, die
Anwendung muss samt Volume neu angelegt werden.

Für die Instanzen sichert das ein Test: `compose-required.spec.ts` liest die
Instanz-Compose und prüft, dass die Verwaltung **jede** `:?`-Variable selbst
setzt. Kommt dort eine hinzu, fällt der Test. Wer eine Pflichtvariable ergänzt,
ergänzt sie auch in `ENVIRONMENT_VARIABLES` (`instance.rules.ts`).

### Der Präfix `COOLIFY_` gehört Coolify

Coolify setzt in jeden verwalteten Container eigene Variablen mit dem Präfix
`COOLIFY_`, darunter `COOLIFY_BRANCH` mit Anführungszeichen im Wert. Hießen die
eigenen Variablen genauso, würde die Verwaltung Coolifys Wert lesen und etwa
`git_branch: "\"main\""` senden, was Coolify mit `422` abweist. Das Anlegen
scheiterte dann, obwohl kein Wert falsch gesetzt war.

Deshalb heißen alle Variablen `CONTROL_COOLIFY_*`. Alte Namen ohne `CONTROL_`
werden mit Warnung weiter gelesen, `COOLIFY_BRANCH` gar nicht mehr. Zusätzlich
werden Anführungszeichen abgestreift, und Branch und API-Adresse werden geprüft.
Passt etwas nicht, bleibt die Instanzverwaltung sichtbar aus, statt Coolify eine
Anfrage zu schicken, die es ablehnt.

### Coolify liest die Compose-Datei erst beim ersten Ausrollen

Nach dem Anlegen über die API parst Coolify die Compose-Datei in einem
eingereihten Hintergrundjob, ohne verlässliche Frist. Bis dahin weist es jede
Domäne mit `422 … without docker_compose_raw` ab. Eine API-Route, die das Lesen
auslöst, gibt es nicht. Beim Ausrollen liest Coolify die Datei dagegen
synchron. Der Aufbau einer Instanz läuft deshalb so:

1. Anwendung anlegen, Umgebungsvariablen setzen
2. **erstes Ausrollen ohne Domäne** (liest die Compose-Datei, startet die
   Container mit allen Geheimnissen, noch ohne Route und Zertifikat)
3. Domäne setzen (bei genau dem 422 alle 3 Sekunden erneut, höchstens 40-mal)
4. **zweites Ausrollen** mit Domäne und Zertifikat
5. Health-Check, dann Status `aktiv`

Das kostet einige Minuten, hängt dafür an nichts, was sich nicht nachlesen lässt.
Ein später nachkommender Hintergrundjob stört nicht.

### Das Token sieht die Compose-Datei nicht

`docker_compose_raw` ist bei Coolify ein sensibles Feld. Ohne `read:sensitive`
fehlt es in den Antworten ganz. Die Verwaltung fragt deshalb nie nach dem Zustand
der Compose-Datei, sondern lässt das Setzen der Domäne selbst antworten (siehe
oben). `provisioning-without-read-access.spec.ts` hält fest, dass der Aufbau kein
Feld liest, dessen Sichtbarkeit das Token bestimmt.

**Regel für jeden Nachweis gegen Coolify:** immer mit dem Token der Verwaltung
prüfen, nicht mit einem Voll-Token. Sonst bleibt die Berechtigung ungeprüft, auf
die es ankommt.

### Eigene Anwendungen im Abgleich ausblenden

Der tägliche Abgleich liest alle Anwendungen von Coolify und **meldet** (nie
korrigiert) Abweichungen zum Register. Eigene Anwendungen, die nach dem
Namensschema `<präfix>-<name>` heißen, etwa die Verwaltung selbst, würden dort
dauerhaft als „keine passende Organisation“ erscheinen. Sie gehören in
`CONTROL_COOLIFY_OWN_APPLICATIONS` (kommagetrennt, mit Präfix) oder in
`provisioning.ownApplications` im Manifest. Die Variable **ersetzt** die Liste im
Manifest, sie ergänzt sie nicht. Gesetzt und leer heißt „nichts ausblenden“.
Wie viele Anwendungen ein Lauf ausgeblendet hat, steht in dessen Logzeile.

Eine Kundeninstanz kann diese Liste nicht verdecken: Beim Vergeben einer
Subdomain wird auch gegen die Anwendungsnamen in Coolify geprüft, und ist Coolify
nicht erreichbar, gilt die Subdomain vorsorglich als vergeben.

## 5. Erste Inbetriebnahme: Trockenlauf und Wegwerf-Instanz

**Schritt 1, rein lesend.** Mit dem Token der Verwaltung nur die lesenden Aufrufe
prüfen und die **Feldnamen** der Antworten mit dem vergleichen, was
`apps/control/src/coolify` ausliest. Ein umbenanntes Feld fällt hier auf und nicht
beim ersten echten Kunden.

| Aufruf | Zweck |
|---|---|
| `GET /api/v1/version` | Token und Erreichbarkeit stehen (`401` = Token falsch) |
| `GET /api/v1/servers` | die Server-UUID existiert |
| `GET /api/v1/projects` | die Projekt-UUID existiert |
| `GET /api/v1/applications` | Namensschema und Statusfelder stimmen mit dem Abgleich überein |

Meldet der Abgleich dabei Abweichungen, ist das kein Fehlschlag, sondern sein
Zweck.

**Schritt 2, eine Wegwerf-Instanz.** Der Trockenlauf beweist das Anlegen selbst
nicht. Dagegen helfen die Pflicht-Vorschau (zeigt Subdomain, Datenbankname,
Umgebungsvariablen und Kennzahlen-Token **bevor** etwas passiert und gilt
15 Minuten) und die sichtbare Fehlerführung. Wer das Risiko klein halten will,
legt beim ersten Mal bewusst eine Wegwerf-Instanz an und archiviert sie danach.
Archivieren heißt stoppen und Status setzen, gelöscht wird nichts. Das kostet
einen belegten Namen im Register und ist der einzige Weg, den ganzen Pfad zu
sehen, ohne einen echten Kunden zu benutzen.

## 6. Wenn das Anlegen scheitert

Der Zustand bleibt sichtbar statt still halb. Die Instanzkarte zeigt, welcher Fall
vorliegt:

| Ausgang | Was die Karte anbietet |
|---|---|
| gescheitert, in Coolify ist nichts entstanden | „Erstellung verwerfen“ |
| gescheitert, in Coolify steht eine Anwendung | dort von Hand löschen, dann „Erstellung verwerfen“ |
| ausgerollt, antwortet noch nicht (meist Zertifikat unterwegs) | „Erneut prüfen“ (reiner Lesezugriff auf die Instanz) |
| fertig | Status `aktiv`, Einladungslink |

Die Verwaltung löscht in Coolify nie etwas (R1), deshalb ist das Aufräumen
einer halben Anwendung ein Handgriff in Coolify. „Erstellung verwerfen“ **fragt
Coolify**: Kennt es die Anwendung nicht mehr (404), gilt der Zustand als „nie
angelegt“. Ein Ausfall von Coolify zählt **nicht** als gelöscht, dann bleibt es
bei der Ablehnung. Eine laufende Instanz wird archiviert, nicht verworfen.

Eine Erstellung, die länger als 15 Minuten läuft, gilt als hängend
(`STUCK_MINUTES` in `instance.rules.ts`). Zeitgrenzen: 600 Sekunden je Ausrollen, 180 Sekunden für den
Health-Check danach.

## 7. Prüfliste

- [ ] Eigenes Token ohne `root` und ohne `read:sensitive`
- [ ] Alle `:?`-Variablen der Verwaltung vor dem ersten Ausrollen überschrieben
- [ ] `CONTROL_CONFIG_KEY` getrennt vom Datenbank-Dump gesichert
- [ ] `CONTROL_COOLIFY_API_URL` aus dem Container erreichbar
- [ ] Projekt-, Server- und Deploy-Key-UUID gesetzt, Repository und Compose-Pfad stimmen
- [ ] Postausgang für Instanzen gesetzt (`CONTROL_INSTANCE_SMTP_*`)
- [ ] Eigene Anwendungen in `CONTROL_COOLIFY_OWN_APPLICATIONS` eingetragen
- [ ] Trockenlauf lesend bestanden, danach Wegwerf-Instanz angelegt und archiviert
- [ ] Sicherung und Rückspielprobe eingerichtet ([backup-and-recovery.md](backup-and-recovery.md))
