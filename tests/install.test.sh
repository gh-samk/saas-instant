#!/usr/bin/env bash
# Test (--no-start, --dry-run) für install.sh und bin/saas-instant (beide Modi, Temp-Verzeichnis).
set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
FAILS=0

ok()   { printf 'ok   %s\n' "$1"; }
fail() { printf 'FAIL %s\n' "$1" >&2; FAILS=$((FAILS + 1)); }
check() { local name="$1"; shift; if "$@" >/dev/null 2>&1; then ok "$name"; else fail "$name"; fi; }
check_not() { local name="$1"; shift; if "$@" >/dev/null 2>&1; then fail "$name"; else ok "$name"; fi; }
perm() { stat -f '%Lp' "$1" 2>/dev/null || stat -c '%a' "$1"; }

stage() { # stage <Verzeichnis>: Kopie der nötigen Dateien
  mkdir -p "$1/bin" "$1/apps"
  cp "$REPO/install.sh" "$1/install.sh"
  cp "$REPO/bin/saas-instant" "$1/bin/saas-instant"
  cp "$REPO/docker-compose.yml" "$REPO/saas-instant.manifest.example.yaml" "$1/"
  cp -R "$REPO/apps/portal" "$1/apps/portal"
}

# --- dry-run: schreibt nichts, auch keinen Modus-Lock -----------------------
D="$TMP/dry"; stage "$D"
check "dry-run: läuft" "$D/install.sh" --dir "$D" --mode portal --software alpha --non-interactive --dry-run --yes
check_not "dry-run: kein Modus-Lock" test -e "$D/.saas-instant-mode"
check_not "dry-run: keine Installation" test -e "$D/installations"
check_not "dry-run: kein Portal-Verzeichnis" test -e "$D/portal"
check "dry-run: nichts festgelegt, anderer Modus danach wählbar" "$D/install.sh" --dir "$D" --mode single --software alpha --non-interactive --no-start --yes
check "dry-run danach: echter Lauf schreibt Lock = single" grep -q '^mode=single$' "$D/.saas-instant-mode"
check "dry-run: schreibt auch bei vorhandenem Lock nichts Neues" bash -c "before=\$(find '$D' -type f | sort | xargs ls -l | md5 2>/dev/null || find '$D' -type f | sort | xargs ls -l | md5sum); '$D/install.sh' --dir '$D' --software zzz --non-interactive --dry-run --yes >/dev/null 2>&1 || true; after=\$(find '$D' -type f | sort | xargs ls -l | md5 2>/dev/null || find '$D' -type f | sort | xargs ls -l | md5sum); [ \"\$before\" = \"\$after\" ]"

# --- single ------------------------------------------------------------------
S="$TMP/single"; stage "$S"
check "single: Anlegen ohne Start läuft" "$S/install.sh" --dir "$S" --mode single --software alpha --non-interactive --no-start --yes
check "single: .env vorhanden" test -f "$S/installations/alpha/.env"
check ".env hat Rechte 600" test "$(perm "$S/installations/alpha/.env")" = 600
check "Manifest kopiert" test -f "$S/installations/alpha/saas-instant.manifest.yaml"
check "Manifest trägt die Kennung" grep -q 'slug: alpha' "$S/installations/alpha/saas-instant.manifest.yaml"
for v in JWT_SECRET CONTROL_CONFIG_KEY CONTROL_POSTGRES_PASSWORD; do
  check "$v ist gesetzt und lang" grep -Eq "^$v=[0-9a-f]{32,}\$" "$S/installations/alpha/.env"
done
check "Modus-Lock = single" grep -q '^mode=single$' "$S/.saas-instant-mode"
check_not "single: kein Portal-Verzeichnis" test -e "$S/portal"
check_not "Moduswechsel wird verweigert" "$S/install.sh" --dir "$S" --mode portal --software alpha --non-interactive --no-start --yes
check "Moduswechsel: Meldung klar" bash -c "'$S/install.sh' --dir '$S' --mode portal --software alpha --non-interactive --no-start --yes 2>&1 | grep -q 'bereits auf'"
check_not "single: add wird verweigert" "$S/bin/saas-instant" add beta
check "single: add-Meldung" bash -c "'$S/bin/saas-instant' add beta 2>&1 | grep -q 'nur im Modus portal'"
check_not "single: zweite Verwaltung verweigert" "$S/install.sh" --dir "$S" --software beta --non-interactive --no-start --yes
check "single: Wiederholung gleicher slug behält Geheimnisse" bash -c "a=\$(cat '$S/installations/alpha/.env'); '$S/install.sh' --dir '$S' --software alpha --non-interactive --no-start --yes >/dev/null; [ \"\$a\" = \"\$(cat '$S/installations/alpha/.env')\" ]"
check "single: list" "$S/bin/saas-instant" list

# --- portal ------------------------------------------------------------------
P="$TMP/portal"; stage "$P"
check "portal: Anlegen ohne Start läuft" "$P/install.sh" --dir "$P" --mode portal --software alpha --non-interactive --no-start --yes
check "portal: Lock = portal" grep -q '^mode=portal$' "$P/.saas-instant-mode"
check "portal: add (zweite Verwaltung)" env SAAS_INSTANT_ROOT="$P" "$P/install.sh" --dir "$P" --mode portal --software beta --non-interactive --no-start --yes
check "portal: beide .env mit 600" bash -c "[ \"\$(stat -f %Lp '$P/installations/alpha/.env' 2>/dev/null || stat -c %a '$P/installations/alpha/.env')\" = 600 ] && [ \"\$(stat -f %Lp '$P/installations/beta/.env' 2>/dev/null || stat -c %a '$P/installations/beta/.env')\" = 600 ]"
check "portal: Ports ohne Kollision" bash -c "[ \"\$(grep -h ^CONTROL_WEB_PORT= '$P'/installations/*/.env | sort | uniq -d | wc -l)\" -eq 0 ]"
check "portal: Registry vorhanden" test -f "$P/portal/registry.json"
check "portal: Registry nennt alpha" grep -q '"slug": "alpha"' "$P/portal/registry.json"
check "portal: Registry trägt product.name aus dem Manifest" grep -q '"name": "Mein Produkt"' "$P/portal/registry.json"
check "portal: Registry nennt beta" grep -q '"slug": "beta"' "$P/portal/registry.json"
check "portal: Registry ist gültiges JSON" bash -c "python3 -c 'import json,sys; d=json.load(open(sys.argv[1])); assert len(d[\"entries\"])==2' '$P/portal/registry.json'"
check "portal: Registry enthält keine Geheimnisse" bash -c "! grep -Eq 'SECRET|PASSWORD|[0-9a-f]{32}' '$P/portal/registry.json'"
check "portal: bin add legt weitere an (Start nicht möglich, daher nur Modus-Prüfung)" bash -c "'$P/bin/saas-instant' add 2>&1 | grep -q 'Kennung fehlt'"
check_not "portal: Moduswechsel auf single verweigert" "$P/install.sh" --dir "$P" --mode single --software gamma --non-interactive --no-start --yes
check_not "ungültige Kennung abgelehnt" "$P/install.sh" --dir "$P" --software 'Bad Slug' --non-interactive --no-start --yes
check "portal: Dateien der Portal-Seite" test -f "$P/apps/portal/index.html" -a -f "$P/apps/portal/nginx.conf" -a -f "$P/apps/portal/Dockerfile" -a -f "$P/apps/portal/docker-compose.portal.yml"

if [ "$FAILS" -ne 0 ]; then printf '%s Prüfung(en) fehlgeschlagen\n' "$FAILS" >&2; exit 1; fi
echo "Alle Prüfungen bestanden."
