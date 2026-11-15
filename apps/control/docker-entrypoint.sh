#!/bin/sh
# Wendet ausstehende DB-Migrationen an und startet dann die Verwaltung.
#
# Emergency commands in the running container. <identifier> is Benutzername oder E-Mail:
#   docker compose exec control-api node dist/cli/emergency.js first-account <email> <name>
#   docker compose exec control-api node dist/cli/emergency.js enrollment   <identifier>
#   docker compose exec control-api node dist/cli/emergency.js password     <identifier>
#   docker compose exec control-api node dist/cli/emergency.js unlock       <identifier>
set -e

echo "[entrypoint] Wende Datenbank-Migrationen an (prisma migrate deploy) ..."
prisma migrate deploy

echo "[entrypoint] Starte die Verwaltung ..."
exec node dist/main
