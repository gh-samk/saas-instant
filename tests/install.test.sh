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
for v in JWT_SECRET CONTROL_CONFIG_KEY CONTROL_POSTGRES_PASSWORD BACKUP_AGENT_SECRET AGENT_STATE_KEY BACKUP_REPORT_KEY; do
  check "$v ist gesetzt und lang" grep -Eq "^$v=[0-9a-f]{32,}\$" "$S/installations/alpha/.env"
done
check "Backup-Geheimnisse sind verschieden" bash -c "[ \$(grep -E '^(BACKUP_AGENT_SECRET|AGENT_STATE_KEY|BACKUP_REPORT_KEY|JWT_SECRET)=' '$S/installations/alpha/.env' | cut -d= -f2 | sort -u | wc -l) -eq 4 ]"
check "Compose: CONTROL_BACKUP_KEY der control-api kommt aus BACKUP_REPORT_KEY (ein Geheimnis)" grep -qF 'CONTROL_BACKUP_KEY: ${BACKUP_REPORT_KEY:?' "$REPO/docker-compose.yml"
check_not "Compose: CONTROL_BACKUP_KEY nicht mehr leer durchgereicht" grep -Eq '^ +CONTROL_BACKUP_KEY: *$' "$REPO/docker-compose.yml"
check "Compose: Agent und Verwaltung lesen denselben .env-Wert BACKUP_REPORT_KEY" bash -c "[ \$(grep -c 'BACKUP_REPORT_KEY:?' '$REPO/docker-compose.yml') -eq 3 ] && [ \$(grep -c '^BACKUP_REPORT_KEY=' '$S/installations/alpha/.env') -eq 1 ] && ! grep -q '^CONTROL_BACKUP_KEY=' '$S/installations/alpha/.env'"
check "Compose: backup-agent ohne ports, mit cap_drop und State-Volume" bash -c "awk '/^  backup-agent:/{f=1;next} /^  (#|[a-z-]+:)/{f=0} f' '$REPO/docker-compose.yml' > '$TMP/agent.yml'; ! grep -q 'ports:' '$TMP/agent.yml' && grep -q 'cap_drop' '$TMP/agent.yml' && grep -q 'backup-agent-state:/state' '$TMP/agent.yml' && grep -q 'read_only: true' '$TMP/agent.yml'"
check "Compose: Docker-Socket nur im docker-socket-proxy gemountet" bash -c "[ \$(grep -c 'docker\.sock' '$REPO/docker-compose.yml') -eq 1 ] && awk '/^  docker-socket-proxy:/{f=1;next} /^  (#|[a-z-]+:)/{f=0} f' '$REPO/docker-compose.yml' | grep -q 'docker.sock:ro'"
check "Compose: docker-socket-proxy mit Allowlist, ohne ports" bash -c "awk '/^  docker-socket-proxy:/{f=1;next} /^  (#|[a-z-]+:)/{f=0} f' '$REPO/docker-compose.yml' > '$TMP/proxy.yml'; ! grep -q 'ports:' '$TMP/proxy.yml' && grep -q 'CONTAINERS: \"1\"' '$TMP/proxy.yml' && grep -q 'EXEC: \"1\"' '$TMP/proxy.yml' && grep -q 'IMAGES: \"0\"' '$TMP/proxy.yml' && grep -q 'VOLUMES: \"0\"' '$TMP/proxy.yml' && grep -q 'NETWORKS: \"0\"' '$TMP/proxy.yml' && grep -q 'SWARM: \"0\"' '$TMP/proxy.yml'"
check "Compose: control-api kennt BACKUP_AGENT_URL" grep -qF 'BACKUP_AGENT_URL: ${BACKUP_AGENT_URL:-http://backup-agent:8787}' "$REPO/docker-compose.yml"
check "Backup-Agent: Dockerfile laeuft nicht als root" bash -c "grep -q '^USER 10002' '$REPO/apps/backup-agent/Dockerfile'"
check "Modus-Lock = single" grep -q '^mode=single$' "$S/.saas-instant-mode"
check_not "single: kein Portal-Verzeichnis" test -e "$S/portal"
check_not "Moduswechsel wird verweigert" "$S/install.sh" --dir "$S" --mode portal --software alpha --non-interactive --no-start --yes
check "Moduswechsel: Meldung klar" bash -c "'$S/install.sh' --dir '$S' --mode portal --software alpha --non-interactive --no-start --yes 2>&1 | grep -q 'bereits auf'"
check_not "single: add wird verweigert" "$S/bin/saas-instant" add beta
check "single: add-Meldung" bash -c "'$S/bin/saas-instant' add beta 2>&1 | grep -q 'nur im Modus portal'"
check_not "single: zweite Verwaltung verweigert" "$S/install.sh" --dir "$S" --software beta --non-interactive --no-start --yes
check "single: Wiederholung gleicher slug behält Geheimnisse" bash -c "a=\$(cat '$S/installations/alpha/.env'); '$S/install.sh' --dir '$S' --software alpha --non-interactive --no-start --yes >/dev/null; [ \"\$a\" = \"\$(cat '$S/installations/alpha/.env')\" ]"
check "single: list" "$S/bin/saas-instant" list

# --- --name: Name im Manifest, Injektionsversuche bleiben wirkungslos ---------
N="$TMP/name"; stage "$N"
check "name: Anlegen mit --name läuft" "$N/install.sh" --dir "$N" --mode single --software alpha --name "Meine Software" --non-interactive --no-start --yes
check "name: product.name im Manifest" grep -q '^  name: "Meine Software"$' "$N/installations/alpha/saas-instant.manifest.yaml"
check "name: product.slug im Manifest" grep -q '^  slug: alpha ' "$N/installations/alpha/saas-instant.manifest.yaml"
check "name: Abschnitt mail bleibt unberührt" grep -q 'senderName: Mein Produkt' "$N/installations/alpha/saas-instant.manifest.yaml"
check "name: .env trägt SAAS_INSTANT_SLUG" grep -q '^SAAS_INSTANT_SLUG=alpha$' "$N/installations/alpha/.env"

I="$TMP/inject"; stage "$I"
EVIL='Evil "x" `touch '"$TMP"'/pwned1` $(touch '"$TMP"'/pwned2) \ ; $HOME & #c'
check "name: Injektionsversuch läuft ohne Fehler durch" "$I/install.sh" --dir "$I" --mode portal --software alpha --name "$EVIL" --non-interactive --no-start --yes
check_not "name: Backticks wurden nicht ausgeführt" test -e "$TMP/pwned1"
check_not "name: \$(...) wurde nicht ausgeführt" test -e "$TMP/pwned2"
check "name: Manifest nur mit maskierten Anführungszeichen" grep -qF '  name: "Evil \"x\" `touch' "$I/installations/alpha/saas-instant.manifest.yaml"
check "name: \$HOME bleibt Text" grep -qF '$HOME' "$I/installations/alpha/saas-instant.manifest.yaml"
# YAML-Rundlauf mit dem 'yaml'-Paket der Verwaltung (wie im Betrieb); ohne installierte Pakete übersprungen.
if (cd "$REPO/apps/control" && node -e "require('yaml')") >/dev/null 2>&1; then
  check "name: Manifest bleibt gültiges YAML und trägt den Namen unverändert" env EVIL="$EVIL" MF="$I/installations/alpha/saas-instant.manifest.yaml" bash -c "cd '$REPO/apps/control' && node -e \"const y=require('yaml');const d=y.parse(require('fs').readFileSync(process.env.MF,'utf8'));if(d.product.name!==process.env.EVIL||d.product.slug!=='alpha'||d.mail.senderName!=='Mein Produkt')process.exit(1)\""
else
  printf 'skip name: YAML-Rundlauf (yaml-Paket nicht installiert)\n'
fi
check "name: Registry bleibt gültiges JSON" bash -c "python3 -c 'import json,sys; d=json.load(open(sys.argv[1])); assert len(d[\"entries\"])==1' '$I/portal/registry.json'"
check "name: Registry nennt Slug und trägt einen bereinigten Namen" python3 -c 'import json,sys; e=json.load(open(sys.argv[1]))["entries"][0]; assert e["slug"]=="alpha"; assert "\"" not in e["name"] and "\\" not in e["name"] and e["name"].startswith("Evil")' "$I/portal/registry.json"
check_not "name: Zeilenumbruch im Namen abgelehnt" "$I/install.sh" --dir "$I" --software beta --name $'A\nB: x' --non-interactive --no-start --yes
check_not "name: zu langer Name abgelehnt" "$I/install.sh" --dir "$I" --software beta --name "$(printf 'x%.0s' $(seq 1 201))" --non-interactive --no-start --yes
check_not "name: nur Leerraum abgelehnt" "$I/install.sh" --dir "$I" --software beta --name "   " --non-interactive --no-start --yes
check "name: Registry mit Titel aus PORTAL_TITLE" env PORTAL_TITLE='Meine "Titel"' "$I/install.sh" --dir "$I" --software gamma --name "Gamma" --non-interactive --no-start --yes
check "name: Registry trägt Titel und Name Gamma" bash -c "python3 -c 'import json,sys; d=json.load(open(sys.argv[1])); assert d[\"title\"]==\"Meine Titel\"; assert [e[\"name\"] for e in d[\"entries\"] if e[\"slug\"]==\"gamma\"]==[\"Gamma\"]' '$I/portal/registry.json'"

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
check "portal: Tokens, Schrift und Lizenz vorhanden" test -f "$P/apps/portal/tokens.css" -a -f "$P/apps/portal/fonts/inter-latin-wght-normal.woff2" -a -f "$P/apps/portal/fonts/LICENSE-Inter.txt"
check "portal: Dockerfile liefert Tokens und Schrift mit" bash -c "grep -q 'tokens.css' '$P/apps/portal/Dockerfile' && grep -q 'COPY fonts/' '$P/apps/portal/Dockerfile'"
check "portal: CSP erlaubt Schrift nur von self" grep -q "font-src 'self'" "$P/apps/portal/security-headers.conf"
check "portal: keine externen Quellen in Seite und Styles" bash -c "! grep -Eq 'https?://|//fonts\\.' '$P/apps/portal/index.html' '$P/apps/portal/tokens.css' '$P/apps/portal/style.css'"
check "portal: lang=de und Skip-Link" bash -c "grep -q '<html lang=\"de\"' '$P/apps/portal/index.html' && grep -q 'class=\"skip\"' '$P/apps/portal/index.html'"
check "portal: nginx liefert / aus (Verzeichnis-Index, kein 404)" grep -Eq 'try_files \$uri \$uri/ =404' "$P/apps/portal/nginx.conf"
check "portal: Port nur an Loopback veroeffentlicht" grep -Eq '"\$\{PORTAL_BIND:-127\.0\.0\.1\}:' "$P/apps/portal/docker-compose.portal.yml"
check "Compose: docker-socket-proxy ohne read_only (Entrypoint schreibt haproxy.cfg)" bash -c "awk '/^  docker-socket-proxy:/{f=1;next} /^  (#|[a-z-]+:)/{f=0} f' '$REPO/docker-compose.yml' | grep -vE '^\s*#' | grep -vq 'read_only'"

if [ "$FAILS" -ne 0 ]; then printf '%s Prüfung(en) fehlgeschlagen\n' "$FAILS" >&2; exit 1; fi
echo "Alle Prüfungen bestanden."
