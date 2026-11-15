#!/usr/bin/env bash
# E2E-Läufe: ./tests/e2e/run.sh <backup|invoice|install|smoke|all>
# Räumt am Ende IMMER auf (Docker-Ressourcen mit Label e2e=true, Control-Prozesse, e2e_*-Datenbanken).
set -u
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SUITE="${1:-}"
export E2E_OUT="${E2E_OUT:-/tmp/saas-instant-e2e}"
mkdir -p "$E2E_OUT"

case "$SUITE" in
  backup|invoice|install|smoke|all) ;;
  *) echo "Aufruf: $0 <backup|invoice|install|smoke|all>" >&2; exit 2 ;;
esac

cleanup() {
  export E2E_CLEAN_SUITE="$SUITE"
  node "$HERE/lib/cleanup.mjs" || echo "Warnung: Aufräumen unvollständig" >&2
}
trap cleanup EXIT
trap 'exit 130' INT TERM

if [ "$SUITE" = all ]; then LIST="smoke backup invoice install"; else LIST="$SUITE"; fi
RC=0
for S in $LIST; do
  F="$HERE/suites/$S.mjs"
  if [ ! -f "$F" ]; then echo "SKIP $S (keine Suite vorhanden)"; continue; fi
  node "$F" || RC=1
done
exit $RC
