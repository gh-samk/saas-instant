# portal-auth

Anmeldedienst des Portals: OIDC-Anbieter (Authorization Code + PKCE S256, ID-Token
mit Ed25519/EdDSA) für alle Verwaltungen eines Portals. NestJS 11, Prisma 5, eigene
Postgres-Datenbank, Port 3100. Passwort, TOTP, Wiederherstellungscodes, Passkey-Hilfen
und Sperrlogik kommen aus `packages/auth-core`.

## Umgebung

| Variable | Bedeutung |
| --- | --- |
| `DATABASE_URL` | eigene Datenbank des Anmeldedienstes |
| `PORTAL_ISSUER` | öffentliche Basis-URL des Portals (https), zugleich `iss` |
| `PORTAL_KEY_SECRET` | mind. 32 Zeichen; verschlüsselt private Signaturschlüssel und TOTP-Geheimnisse |
| `PORTAL_TRUST_PROXY` | Anzahl Reverse-Proxys vor dem Dienst (Standard 0; im Compose 2) |
| `COOKIE_SECURE` | `false` nur für lokale Entwicklung ohne TLS (dann ohne `__Host-`-Präfix) |
| `PORTAL_NAME` / `PORTAL_TOTP_ISSUER` | Anzeigename (WebAuthn, Authenticator-App) |

## Befehle im Container

```
node dist/cli.js client upsert --id <slug> --name <Name> --base-url <https://verwaltung> --secret-stdin
node dist/cli.js client list
node dist/cli.js account create-first --email <e> --name <n>     # gibt den Einrichtungslink aus
node dist/cli.js account create --email <e> --name <n> [--portal-admin]
node dist/cli.js account set-role --email <e> --client <slug> --role admin|staff|none
node dist/cli.js account setup-link --email <e>                  # Einrichtung bzw. Zurücksetzen
node dist/cli.js account unlock --email <e>
node dist/cli.js key rotate                                      # alter Schlüssel bleibt 15 Min. im JWKS
```

`client upsert` leitet aus `--base-url` ab: Redirect-URI `<base>/api/auth/sso/callback`,
Front-Channel-Abmeldung `<base>/api/auth/sso/frontchannel-logout`, Rückkehr nach der
Abmeldung `<base>/` und `<base>/login`.

## Entscheidungen, die der Vertrag offen ließ

- Anmeldeseiten (`/auth/login`, `/auth/setup`, `/auth/account`, `/auth/accounts`) liefert
  der Portal-nginx statisch aus (eine Anwendung, clientseitige Route); `/api`, `/oauth`
  und `/.well-known` gehen an diesen Dienst.
- `/oauth/authorize` merkt sich die Anfrage (`AuthRequest`) und schickt zu
  `/auth/login?req=<id>[&stepup=1]`; nach der Anmeldung geht es über
  `/oauth/authorize/continue?req=<id>` weiter. So entsteht bei `max_age=0` keine Schleife:
  ein Code kommt erst, wenn der Faktor NACH Beginn der Anfrage nachgewiesen wurde, und
  nur für dasselbe Konto.
- Im ID-Token steht `roles` nur mit der Rolle dieser Verwaltung (`{}` ohne Rolle).
- Die Antwort auf `/oauth/authorize` und der Redirect enthalten zusätzlich `iss` (RFC 9207).
- `amr`: `["pwd","otp"]` (auch bei Wiederherstellungscode), `["hwk"]` bei Passkey.
- Die Front-Channel-Abmeldeseite (`/oauth/logout`) setzt eine eigene CSP mit `frame-src`
  auf die betroffenen Verwaltungen. Deren Endpunkt muss das Einbetten erlauben
  (kein `X-Frame-Options: DENY/SAMEORIGIN`, `frame-ancestors` mit dem Portal).

## Tests

```
pnpm --filter @saas-instant/portal-auth test:unit
DATABASE_URL=postgresql://…  node scripts/integration-run.mjs     # nutzt Datenbank portal_auth_test
```
