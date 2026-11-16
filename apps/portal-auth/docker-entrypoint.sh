#!/bin/sh
# Wendet ausstehende DB-Migrationen an und startet dann den Anmeldedienst.
#
# Verwaltung im laufenden Container:
#   docker compose exec portal-auth node dist/cli.js account create-first --email <e> --name <n>
#   docker compose exec portal-auth node dist/cli.js client upsert --id <slug> --name <Name> --base-url <https://verwaltung> --secret-stdin
#   docker compose exec portal-auth node dist/cli.js account set-role --email <e> --client <slug> --role admin|staff|none
#   docker compose exec portal-auth node dist/cli.js key rotate
set -e

echo "[entrypoint] Wende Datenbank-Migrationen an (prisma migrate deploy) ..."
prisma migrate deploy

echo "[entrypoint] Starte den Anmeldedienst ..."
exec node dist/main
