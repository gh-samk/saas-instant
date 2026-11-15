# invoice-renderer

## English (short)

HTTP service that turns an invoice HTML plus a ZUGFeRD/Factur-X CII XML into a
**PDF/A-3b with the XML embedded**, and validates its own output before
returning it (veraPDF + EN 16931 Schematron via Mustangproject, Apache 2.0).
Chromium (headless) lays out the HTML; `src/java/InvoiceService.java` ties
Chromium and Mustangproject together using only the JDK HTTP server.

- **Contract** (called by `apps/control/src/invoices/document/invoice-renderer.client.ts`):
  `POST /erzeuge` with JSON `{"html": <base64>, "xml": <base64>, "profil": "EN16931"}`
  returns the PDF (`200`), or `422` with the validation report if the result is
  not valid, or `400` for malformed input. `GET /gesundheit` is the health check.
  The German path and field names are part of this contract; change them on both
  sides at once.
- **No authentication.** Expose it only inside the Compose network (no `ports:`).
- **No network access needed.** The service makes no outbound connections: the
  browser resolves no names (`--host-resolver-rules=MAP * ~NOTFOUND`) and the
  HTML must not reference external resources. Run it without outbound network
  where your runtime allows (e.g. an `internal` Docker network).
- **Hardening:** runs as unprivileged user (UID 10001), intended with
  `--read-only --tmpfs /tmp`, `--cap-drop ALL`, `no-new-privileges`.
- **Chromium sandbox:** Chromium runs with `--no-sandbox` by default, because its
  sandbox needs unprivileged user namespaces, which Docker's default seccomp
  profile and `cap_drop: ALL` block. Compensation: non-root user, no name
  resolution, read-only root filesystem. If your runtime permits user namespaces
  (custom seccomp profile), set `RECHNUNG_BROWSER_SANDBOX=1` to drop the flag.
- **Settings:** `RECHNUNG_PORT` (8080), `RECHNUNG_BROWSER` (`/usr/bin/chromium`),
  `RECHNUNG_SELBSTPRUEFUNG=0` disables the self-check (not recommended),
  `RECHNUNG_BROWSER_SANDBOX=1` enables the Chromium sandbox.
- **Why Mustangproject as a library, no Ghostscript:** the Mustang command line
  refuses input that is not already PDF/A; the library (`ZUGFeRDExporterFromA1`
  with `ignorePDFAErrors()`) adds the three things Chromium output lacks
  (sRGB output intent, XMP metadata, trailer ID). Ghostscript would add AGPL.

Build and tests:

```bash
docker build -t saas-instant-invoice-renderer tools/invoice-renderer
node --test "src/*.test.mjs"      # calculation and XML/HTML generators (no Docker)
node src/erzeuge.mjs [outdir]     # writes sample HTML, Typst, CII and UBL files
```

The `.mjs` files in `src/` are a standalone reference implementation of
calculation and generators with a neutral sample invoice in
`daten/beispielrechnung.mjs`. The production path is
`apps/control/src/invoices/document/`; the identifiers in `src/` are German.

## Deutsch

HTTP-Dienst: macht aus Rechnungs-HTML und ZUGFeRD-XML (EN 16931) ein
**PDF/A-3b mit eingebettetem `factur-x.xml`** und prüft das Ergebnis selbst
nach, bevor er es herausgibt (`422` mit Prüfbericht, wenn es nicht besteht).

- **Aufruf:** `POST /erzeuge`, JSON `{"html": <base64>, "xml": <base64>, "profil": "EN16931"}`;
  Gesundheitsprüfung `GET /gesundheit`. Die deutschen Pfad- und Feldnamen sind
  Teil des Vertrags mit der API; nur gemeinsam ändern.
- **Keine Anmeldung:** nur im Compose-Netz erreichbar machen, nie veröffentlichen.
- **Kein Netzzugang nötig:** Der Dienst baut keine ausgehenden Verbindungen auf,
  der Browser löst keine Namen auf. Wo möglich in einem internen Netz ohne
  Ausgang betreiben (z. B. Docker-Netz mit `internal: true`).
- **Härtung:** läuft als unprivilegierter Benutzer (UID 10001); vorgesehen mit
  schreibgeschütztem Wurzeldateisystem, `/tmp` als tmpfs, `cap_drop: ALL` und
  `no-new-privileges`.
- **Chromium-Sandbox:** Standardmäßig mit `--no-sandbox`, weil die Sandbox
  unprivilegierte User-Namespaces braucht, die Dockers Standardprofil und
  `cap_drop: ALL` sperren. Ausgleich: kein root, keine Namensauflösung,
  schreibgeschütztes Dateisystem. Erlaubt Ihre Umgebung User-Namespaces
  (eigenes seccomp-Profil), `RECHNUNG_BROWSER_SANDBOX=1` setzen.
- **Einstellungen:** `RECHNUNG_PORT` (8080), `RECHNUNG_BROWSER`,
  `RECHNUNG_SELBSTPRUEFUNG=0` (Selbstprüfung aus, nicht empfohlen),
  `RECHNUNG_BROWSER_SANDBOX=1`.
- **Tests ohne Docker:** `node --test "src/*.test.mjs"` im Verzeichnis
  `tools/invoice-renderer`. Der Container selbst wird mit `docker build` gebaut
  (siehe oben); die HTTP-Strecke prüft nur ein Lauf mit Docker.
- **Optionale Angaben im Layout:** Der Block „Persönlich haftende
  Gesellschafterin“ und das Land erscheinen im Rechnungs-PDF nur, wenn sie im
  Manifest (`billing.issuer.generalPartner*`, `managingDirectors`, `country`)
  gesetzt sind; sonst wird nichts gedruckt.
