# Software-Manifest

Das Manifest beschreibt die Software, die eine Verwaltung betreut: Name, Mail-Absender, Abrechnung, Provisionierung, Oberfläche. Es ist eine YAML-Datei (oder JSON, wenn die Endung `.json` ist). Die Vorlage ist `saas-instant.manifest.example.yaml`. Maßgeblich für alles hier ist `apps/control/src/manifest/` (Typen in `sections/*.ts`, Prüfung in `manifest.loader.ts`).

## Wo es liegt und wann es gilt

- Pfad: Umgebungsvariable `MANIFEST_PATH`, sonst `./saas-instant.manifest.yaml`. Im Container ist es `/app/saas-instant.manifest.yaml`; der Compose bindet dorthin die Datei, auf die `MANIFEST_FILE` zeigt (`install.sh` setzt sie auf `installations/<slug>/saas-instant.manifest.yaml`, die Datei wird nur lesend eingehängt).
- **Geladen wird einmal beim Start.** Änderungen wirken erst nach einem Neustart der Verwaltung.
- **Ungültig = kein Start.** Alle Fehler werden gesammelt und mit Pfad ausgegeben (z. B. `billing.tiers[1].key: fehlt`).
- **Fehlt die Datei,** gelten neutrale Vorgaben, und beim Start erscheint eine Warnung.
- Alle fünf Abschnitte (`product`, `mail`, `billing`, `provisioning`, `ui`) sind optional, ebenso jedes Feld, das unten nicht als Pflicht bezeichnet ist. Ein **unbekannter Abschnitt auf oberster Ebene** ist ein Fehler. **Unbekannte Felder innerhalb eines Abschnitts** werden dagegen nicht gemeldet, sondern ignoriert; ein Tippfehler im Feldnamen fällt deshalb nicht auf.
- Rangfolge je Wert, wo es mehrere Quellen gibt: Umgebungsvariable vor Manifest vor neutraler Vorgabe. Das gilt für `provisioning` (Coolify), für `mail` (Absender) und für `billing`; die Ausnahmen stehen bei den Feldern.
- Das Manifest enthält **keine Geheimnisse** (kein API-Token, kein SMTP-Passwort). Jene stehen in der `.env`.
- Nach außen gibt die Verwaltung unter `GET /api/public-config` ohne Anmeldung nur `productName`, `logoUrl` und `bound` heraus, nie Mail-, Abrechnungs- oder Provisionierungsdaten.

## `product`

| Feld | Typ | Vorgabe | Bedeutung |
|---|---|---|---|
| `name` | Text, nicht leer | `SAAS Verwaltung` | Anzeigename der Software. **Einzige Namensquelle** für Oberfläche, Mails (Betreff, Rahmen, Absendername), Rechnungen und Portal-Eintrag (`install.sh` liest ihn mit einer einfachen Heuristik aus der Datei). `install.sh --name "<Name>"` setzt ihn. |
| `slug` | Text, `a-z`, `0-9`, Bindestriche (nicht am Rand, nicht doppelt) | `saas-instant` | Kurzname für Bezeichner. `install.sh` setzt ihn beim Kopieren der Vorlage auf Ihre `--software`-Kennung. **Pflicht, sobald `name` gesetzt ist** (sonst Manifestfehler). |

**Bindung an genau eine Software.** Ohne `product.name` heißt die Verwaltung „SAAS Verwaltung" (nicht angebunden, `bound: false`). Sobald das Manifest `name` und `slug` setzt, ist sie angebunden (`bound: true`) und zeigt den Namen der Software. Beim ersten Start schreibt `control-api` den Slug in die Tabelle `Installation`; jeder spätere Start mit einem anderen `product.slug` bricht mit klarer Meldung ab. Dasselbe gilt, wenn die Umgebungsvariable `SAAS_INSTANT_SLUG` (vom mitgelieferten Compose aus der `.env` durchgereicht) vom Manifest-Slug abweicht. Wer eine andere Software betreuen will, richtet dafür eine eigene Verwaltung mit eigener Datenbank ein.

## `mail`

Absender und Rahmen aller Mails der Verwaltung (Anmeldecodes, Rechnungen, Rundmails, Instanz-Einladungen). Die Mailtexte selbst sind in v1 deutsch und nicht über das Manifest änderbar.

| Feld | Typ | Vorgabe | Bedeutung |
|---|---|---|---|
| `senderName` | Text, nicht leer | `product.name` | Absendername. Wirkt nur, wenn die Umgebungsvariable `SMTP_FROM` nicht gesetzt ist (siehe unten). |
| `senderAddress` | E-Mail-Adresse | `noreply@example.com` | Absenderadresse. Wirkt nur, wenn `SMTP_FROM` nicht gesetzt ist (siehe unten); liefert außerdem die Maildomäne, wenn `domain` fehlt. |
| `footer` | Text, Zeilenumbrüche erlaubt | leer | Fußzeile jeder Mail; jede Zeile wird eine Zeile im Mailrahmen. |
| `imprint` | Text | keiner | Anbieterangaben, stehen im Mailrahmen unter `footer`. |
| `domain` | Domain | Domain von `senderAddress` | Maildomäne. In Produktion (`NODE_ENV=production`) müssen alle Absenderadressen darauf liegen (DMARC-Ausrichtung), sonst startet die Verwaltung nicht. Überschreibbar mit `MAIL_DOMAIN`. |
| `replyTo` | E-Mail-Adresse | `senderAddress` bzw. Konto des Postausgangs | Antwortadresse. Überschreibbar mit `MAIL_REPLY_TO`. |
| `websiteUrl` | `https`-Adresse | keine | Webseite des Betreibers im Mailrahmen. |
| `legalLinks` | Liste aus `text` und `url` (`https`) | leer | Verweise der Mailfußzeile (z. B. Impressum, Datenschutz). Ohne Einträge gibt es keine Verweiszeile. |
| `inquiryTo` | E-Mail-Adresse | keine | Ziel, an das Anfragen aus dem öffentlichen Anfrageweg gemeldet werden. Überschreibbar mit `CONTROL_INQUIRY_RECIPIENT`. Fehlen beide, wird die Anfrage trotzdem gespeichert, aber nicht gemeldet (Fehler im Log). |

Die Umgebung hat bei Absendern Vorrang: `SMTP_FROM`, `MAIL_SENDER_INVOICE`, `MAIL_SENDER_BROADCAST`, `MAIL_RETURN_PATH`. **Achtung:** Das mitgelieferte `docker-compose.yml` gibt `SMTP_FROM` immer an den Container weiter, bei fehlendem Wert in der `.env` als leeren Text, und ein leerer Wert gilt als gesetzt. Dann greifen `senderName` und `senderAddress` nicht. Tragen Sie `SMTP_FROM` deshalb in der `.env` ein.

## `billing`

Grundlage der Rechnungen.

### `billing.issuer`, der Rechnungsaussteller

| Feld | Vorgabe | Bedeutung |
|---|---|---|
| `name` (nicht leer) | `Example Company` | Name des Ausstellers |
| `address` | `Example Street 1, 12345 Example City` | Anschrift als Freitext; sofern `street`/`postalCode`/`city` fehlen, wird sie nach dem Muster „Straße 1, 12345 Ort“ zerlegt |
| `taxId` | keine | Umsatzsteuer-Identnummer |
| `email` | keine | Kontakt-Adresse auf der Rechnung |
| `bankDetails` | keine | Freitext, aus dem IBAN, BIC und Institut gelesen werden, wenn `iban`/`bic`/`bankName` fehlen (Muster: `Institut, IBAN DE00 …, BIC XXXXXXXX`) |
| `street`, `postalCode`, `city`, `country` | aus `address` | strukturierte Anschrift |
| `seat` | `city` | Sitz der Gesellschaft, falls abweichend |
| `phone`, `contactName` | keine | Kontakt |
| `creditorId` | keine | SEPA-Gläubiger-Identifikationsnummer |
| `bankName`, `iban`, `bic` | aus `bankDetails` | Bankverbindung |
| `registerCourt`, `registerNumber` | keine | Registergericht und -nummer |
| `legalNotice` | wird aus Name, Sitz und Register abgeleitet | Rechtlicher Zusatz (Geschäftsbriefangaben) als Fließtext |
| `generalPartnerName`, `generalPartnerSeat`, `generalPartnerRegisterCourt`, `generalPartnerRegisterNumber`, `managingDirectors` | keine | Persönlich haftende Gesellschafterin und Geschäftsführung, siehe unten |

Reihenfolge je Angabe: Umgebungsvariable `CONTROL_INVOICE_*` (z. B. `CONTROL_INVOICE_ISSUER`, `_STREET`, `_IBAN`), dann Manifest, dann neutrale Platzhalter. **Fehlt eine Angabe überall, steht auf der Rechnung ein Platzhalter** (Example Company, Beispiel-IBAN, Beispiel-Anschrift). Füllen Sie alle Felder, die auf Ihren Rechnungen stehen sollen.

**Persönlich haftende Gesellschafterin (optional):** `generalPartnerName`, `generalPartnerSeat`, `generalPartnerRegisterCourt`, `generalPartnerRegisterNumber` und `managingDirectors` (Namen durch Komma getrennt). Ist `generalPartnerName` gesetzt, druckt das Rechnungs-PDF den Block „Persönlich haftende Gesellschafterin“ (nur die gesetzten Zeilen), nimmt sie in den rechtlichen Zusatz auf und verlangt beim Festschreiben Sitz, Registergericht, Registernummer und Geschäftsführung. Ist er nicht gesetzt, erscheint kein Block und nichts davon wird verlangt. Umgebungsvariablen `CONTROL_INVOICE_GENERAL_PARTNER*` und `CONTROL_INVOICE_MANAGING_DIRECTOR` haben Vorrang. Die Länderangabe im Fuß stammt aus `country` (`DE` wird als „Deutschland“ ausgeschrieben); ist sie leer, steht dort kein Land. Prüfen Sie ein erzeugtes PDF, bevor Sie Rechnungen versenden.

### `billing.tiers`, Preisstufen

Liste; leer oder fehlend = neutrale Vorgaben des Codes (drei Stufen, 19 %, Zahlungsziel 14 Tage). Mit Einträgen ersetzt sie diese vollständig. Die Umgebungsvariable `CONTROL_PRICE_TABLE` (JSON) hat Vorrang vor dem Manifest.

| Feld | Typ | Bedeutung |
|---|---|---|
| `key` (Pflicht) | Text, eindeutig | technischer Schlüssel der Stufe |
| `label` | Text | Bezeichnung auf Rechnung und in der Oberfläche; Vorgabe: `key` |
| `priceCents` | Zahl >= 0, Vorgabe 0 | Preis je Monat in Cent, netto; Grundlage für die abgeleiteten Werte |
| `maxPersons` | Zahl >= 1 oder weggelassen | obere Schwelle aktiver Personen (einschließlich). Die **letzte** Stufe lässt sie weg (nach oben offen); genau eine Stufe muss offen sein, die Schwellen müssen streng steigen |
| `monthlyCents` | Zahl >= 0 | netto je Monat; Vorgabe `priceCents` |
| `halfYearlyCents` | Zahl >= 0 | netto je Halbjahr; Vorgabe 5,5 Monatsraten |
| `yearlyCents` | Zahl >= 0 | netto je Jahr; Vorgabe 11 Monatsraten |
| `setupCents` | Zahl >= 0 | einmalige Einrichtung; Vorgabe 0 |

Die Stufen werden gegen die von der Instanz gemeldete Kennzahl „aktive Personen“ (siehe [Instanz-Vertrag](instance-contract.md)) gehalten. Wird die Preistafel beim Start als fehlerhaft erkannt, startet die Verwaltung nicht, statt falsche Beträge zu berechnen.

### Weitere Felder

Rechnungsnummern haben das feste Format `JJJJ-NNN` (Jahr, fortlaufend, lückenlos je Jahr, vergeben beim Festschreiben); das Rechnungsdokument ist fest auf EUR. Ein Präfix oder eine Währung lassen sich im Manifest nicht einstellen; alte Einträge `billing.invoiceNumberPrefix` und `billing.currency` werden ignoriert.

| Feld | Typ | Vorgabe | Bedeutung |
|---|---|---|---|
| `taxRatePercent` | Zahl >= 0 | 19 | Umsatzsteuersatz in Prozent |
| `paymentTermDays` | Zahl >= 0 | 14 | Zahlungsziel in Tagen |
| `averageDays` | Zahl >= 1 | 90 | Tage für den Durchschnitt aktiver Personen |
| `retentionYears` | ganze Zahl 1 bis 30 | 8 | Aufbewahrungsfrist festgeschriebener Rechnungen in Jahren: `retentionUntil` = 31.12. des Festschreibejahres plus diese Zahl. Wirkt nur auf künftig festgeschriebene Rechnungen. Die Dauer klärt der Betreiber mit der Steuerberatung ([gobd.md](operations/gobd.md)). |

## `provisioning`

Wie Instanzen angelegt, benannt und angesprochen werden. Der Teil des Instanz-Vertrags (Pfade) ist in [instance-contract.md](instance-contract.md) beschrieben.

| Feld | Typ | Vorgabe | Bedeutung |
|---|---|---|---|
| `instanceDomainBase` | Domain | `example.com` | Basisdomain der Instanzen. Überschreibbar mit `CONTROL_INSTANCE_BASE_DOMAIN`. |
| `subdomainPattern` | Text, muss `{slug}` enthalten; nur `{slug}` und `{base}` erlaubt | `{slug}.{base}` | Hostname der Instanz; `{slug}` = gewählte Subdomain, `{base}` = `instanceDomainBase`. |
| `composeSource` | Text | leer | Compose-Quelle: eine Git-URL (wirkt wie `repository`) oder ein Dateipfad (wirkt wie `composePath`). `repository` und `composePath` haben Vorrang, wenn beides angegeben ist. |
| `repository` | Text | leer | Git-URL des Repositories mit der Instanz-Compose (Coolify-Quelle). Leer = per `CONTROL_COOLIFY_REPO` setzen. |
| `composePath` | Text, nicht leer | `/docker-compose.coolify.yml` | Pfad der Compose-Datei im Repository. |
| `instanceEnv` | Zuordnung Name zu Text | leer | Umgebungsvariablen, die jede Instanz bekommt. Platzhalter: `{subdomain}`, `{domain}` (voller Hostname), `{setupToken}`, `{metricsToken}`. Namen müssen gültige Variablennamen sein; `SETUP_TOKEN` und `METRICS_TOKEN` setzt die Verwaltung selbst und sind hier verboten; unbekannte Platzhalter sind ein Fehler. Werte aus `instanceEnv` überschreiben die Grundwerte der Verwaltung (`APP_URL`, `COOKIE_SECURE`, `NODE_ENV`, Zufallsgeheimnisse, SMTP). |
| `healthPath` | Pfad mit `/` am Anfang | `/api/health` | Instanz-Vertrag: Gesundheitsprüfung (Pflicht-Endpunkt). Nicht in der Beispieldatei, aber im Code vorhanden. |
| `setupPath` | Pfad mit `/` | `/api/setup/start` | Instanz-Vertrag: Pfad des Einladungslinks `<Pfad>?token=<SETUP_TOKEN>`. Überschreibbar mit `CONTROL_INSTANCE_SETUP_PATH`. |
| `setupStatusPath` | Pfad mit `/` | keiner | Instanz-Vertrag, optional: Einrichtungsstand. Ohne Angabe wird er nie abgefragt. Überschreibbar mit `CONTROL_INSTANCE_SETUP_STATUS_PATH`. |
| `metricsPath` | Pfad mit `/` | keiner | Instanz-Vertrag, optional: Kennzahlen (durch `METRICS_TOKEN` geschützt). Ohne Angabe überspringt der Abruf die Instanzen ohne Fehler und ohne Alarm. Überschreibbar mit `CONTROL_INSTANCE_METRICS_PATH`. |
| `instancePrefix` | Text, `a-z`, `0-9`, Bindestrich | `instance` | Coolify-Anwendungen heißen `<instancePrefix>-<subdomain>`. Überschreibbar mit `CONTROL_INSTANCE_PREFIX`. |
| `ownApplications` | Liste von Texten | leer | Eigene Coolify-Anwendungen (z. B. die Verwaltung selbst), die der Abgleich nicht als verwaist meldet. Namen mit demselben Präfix-Schema. `CONTROL_COOLIFY_OWN_APPLICATIONS` hat Vorrang, auch wenn es leer ist (leer = nichts ausschließen). |

Fehlen `metricsPath` oder `setupStatusPath`, gilt der jeweilige Endpunkt als nicht vorhanden und wird nie abgefragt. Die Pfade `/api/intern/kennzahlen` und `/api/setup/status` aus der Beispieldatei sind Vorschläge für Ihre Software, keine Pflicht.

**Nicht im Manifest:** Coolify-Token, UUIDs von Projekt, Server und Deploy-Key sowie die SMTP-Daten der Instanzen stehen in der Umgebung (siehe [installation.md](installation.md), Abschnitt 7).

## `ui`

| Feld | Typ | Vorgabe | Bedeutung |
|---|---|---|---|
| `productName` | Text, nicht leer | keiner (gilt `product.name`) | Nur optionaler Override des Namens in der Oberfläche (Anmeldeseite, Kopfzeile). Wirkt erst, wenn die Verwaltung angebunden ist. Kommt über `GET /api/public-config`. Der Untertitel „Verwaltung" entfällt, wenn der Name schon auf „Verwaltung" endet. |
| `logoUrl` | Text, beginnt mit `http://`, `https://` oder `/` | keines | Logo in der Oberfläche. |

Die volle Instanz-Adresse (`https://<subdomain>.<basis>`) zeigt die Oberfläche nur, wenn beim **Build** `VITE_INSTANCE_BASE_DOMAIN` gesetzt ist. Der Docker-Build setzt sie aus `CONTROL_INSTANCE_BASE_DOMAIN` der `.env`; `install.sh` übernimmt dafür `provisioning.instanceDomainBase` aus dem Manifest (den Platzhalter `example.com` nicht). Eine spätere Änderung wirkt erst nach `docker compose up -d --build`. Ohne Wert steht in der Oberfläche nur die Subdomain, ohne Verweis.

## Beispiel (Kurzform)

```yaml
product:
  name: Mein Produkt
  slug: mein-produkt

mail:
  senderName: Mein Produkt
  senderAddress: noreply@example.com
  replyTo: hello@example.com

billing:
  issuer:
    name: Example Company
    street: Example Street 1
    postalCode: "12345"
    city: Example City
    taxId: DE123456789
    iban: DE00000000000000000000
  tiers:
    - key: basic
      label: Basic
      priceCents: 1900
      maxPersons: 10
    - key: pro
      label: Pro
      priceCents: 4900

provisioning:
  instanceDomainBase: example.com
  subdomainPattern: "{slug}.{base}"
  repository: git@git.example.com:example/instance-compose.git
  composePath: /docker-compose.coolify.yml
  instancePrefix: instanz
  metricsPath: /api/intern/kennzahlen
  setupPath: /api/setup/start
  setupStatusPath: /api/setup/status
  instanceEnv:
    INSTANCE_MODE: production

ui:
  # productName: Mein Produkt   # optional: Override; sonst gilt product.name
  logoUrl: https://example.com/logo.svg
```

Die vollständige Vorlage mit allen Feldern: `saas-instant.manifest.example.yaml`.
