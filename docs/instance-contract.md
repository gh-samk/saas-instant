# Instanz-Vertrag

Was eine Software erfüllen muss, damit saas-instant ihre Instanzen anlegen,
überwachen und (optional) auswerten kann. Die Pfade stehen im Abschnitt
`provisioning` des Software-Manifests (`saas-instant.manifest.example.yaml`).

*English summary: a software gets three environment variables per instance
(`APP_URL`, `SETUP_TOKEN`, `METRICS_TOKEN`) and must serve one endpoint
(`GET <healthPath>`). A setup-status and a metrics endpoint are optional; if the
manifest does not declare them, the control app never calls them (no error, no
alert). Details below.*

## 1. Umgebungsvariablen (Pflicht, setzt die Verwaltung)

| Variable        | Inhalt                                                                  |
|-----------------|-------------------------------------------------------------------------|
| `APP_URL`       | Öffentliche Adresse der Instanz, z. B. `https://muster.example.com` (Domain) |
| `SETUP_TOKEN`   | Einmal-Geheimnis für das Erst-Setup (siehe 2.2)                          |
| `METRICS_TOKEN` | Nur-Lese-Geheimnis für den Kennzahlen-Endpunkt (siehe 2.3)               |

Zusätzlich setzt die Verwaltung Postausgang (`SMTP_*`), `NODE_ENV`,
`COOKIE_SECURE` und frische Zufallsgeheimnisse (`POSTGRES_PASSWORD`,
`JWT_SECRET`, `SESSION_SECRET`, `CONFIG_KEY`). Eigene Variablen kommen aus
`provisioning.instanceEnv` mit den Platzhaltern `{subdomain}`, `{domain}`,
`{setupToken}`, `{metricsToken}`; `SETUP_TOKEN` und `METRICS_TOKEN` selbst lassen
sich dort nicht überschreiben.

## 2. Endpunkte

### 2.1 Health (Pflicht) — `provisioning.healthPath`, Vorgabe `/api/health`

`GET`, ohne Anmeldung. `2xx` = bereit. Die Verwaltung wartet nach dem Ausrollen
darauf, bevor sie die Instanz auf „aktiv" setzt.

```json
{ "status": "ok" }
```

### 2.2 Setup-Status (optional) — `provisioning.setupStatusPath`

`GET`, ohne Anmeldung. Nicht deklariert = wird nie gefragt. Die Verwaltung
liest nur, ob das Erst-Setup noch offen ist; sie hält den Einladungslink so
aktuell.

```json
{ "benoetigtSetup": true }
```

`true` = offen, `false` = eingerichtet; alles andere gilt als „unbekannt".

Der Einladungslink an Kundschaft lautet `https://<host><setupPath>?token=<SETUP_TOKEN>`
(`provisioning.setupPath`). Die Instanz prüft das Token und lässt das Setup
genau einmal zu.

### 2.3 Kennzahlen (optional) — `provisioning.metricsPath`

`GET`, Kopfzeile `Authorization: Bearer <METRICS_TOKEN>`; Anfrageparameter
`nameAbdruck` (Abdruck des erwarteten Organisationsnamens). Ohne gültiges Token:
`401`/`403`. Nicht deklariert = die Verwaltung überspringt die Instanz ohne
Fehler und ohne Alarm.

```json
{
  "datenbank": "erreichbar",
  "aktivePersonen": 34,
  "kreise": 6,
  "letzterEintragAm": "2026-08-19",
  "letzteAnmeldungAm": "2026-08-28",
  "appVersion": "0.5.2",
  "organisationsnameStimmt": true
}
```

`datenbank`: `erreichbar` | `gestoert`. Zahlen: ganze Zahlen ≥ 0 oder `null`.
Tage: `YYYY-MM-DD` oder `null`. `organisationsnameStimmt` darf fehlen oder `null`
sein („nicht gemessen"). Nur Kennzahlen, keine Personendaten.

## 3. Sicherheit

- **Setup-Token ist einmalig.** Nach erfolgreichem Setup muss die Instanz es
  ablehnen (`410`); es steht nur verschlüsselt in der Verwaltung und wird nie
  geloggt.
- **Lesetoken liest nur.** `METRICS_TOKEN` darf nichts verändern und nichts
  anderes freischalten als den Kennzahlen-Endpunkt. Vergleich in konstanter Zeit.
- Health und Setup-Status liefern nichts, was Besucher der Adresse nicht ohnehin
  sehen.
- Alle Aufrufe laufen über HTTPS mit kurzer Zeitgrenze; Antworten, die nicht der
  Form entsprechen, werden verworfen, nicht halb übernommen.
- Die Verwaltung legt Instanzen nur an oder stoppt sie — sie löscht nie (Regel R1).
  Das Datenvolumen einer Instanz bleibt beim Stoppen erhalten.
