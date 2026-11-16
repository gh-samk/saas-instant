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
  cp "$REPO/docker-compose.yml" "$REPO/docker-compose.portal-net.yml" "$REPO/saas-instant.manifest.example.yaml" "$1/"
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
for v in JWT_SECRET CONTROL_CONFIG_KEY CONTROL_POSTGRES_PASSWORD BACKUP_AGENT_SECRET AGENT_STATE_KEY BACKUP_REPORT_KEY BACKUP_DB_PASSWORD; do
  check "$v ist gesetzt und lang" grep -Eq "^$v=[0-9a-f]{32,}\$" "$S/installations/alpha/.env"
done
check "Backup-Geheimnisse sind verschieden" bash -c "[ \$(grep -E '^(BACKUP_AGENT_SECRET|AGENT_STATE_KEY|BACKUP_REPORT_KEY|JWT_SECRET)=' '$S/installations/alpha/.env' | cut -d= -f2 | sort -u | wc -l) -eq 4 ]"
check "Compose: CONTROL_BACKUP_KEY der control-api kommt aus BACKUP_REPORT_KEY (ein Geheimnis)" grep -qF 'CONTROL_BACKUP_KEY: ${BACKUP_REPORT_KEY:?' "$REPO/docker-compose.yml"
check_not "Compose: CONTROL_BACKUP_KEY nicht mehr leer durchgereicht" grep -Eq '^ +CONTROL_BACKUP_KEY: *$' "$REPO/docker-compose.yml"
check "Compose: Agent und Verwaltung lesen denselben .env-Wert BACKUP_REPORT_KEY" bash -c "[ \$(grep -c 'BACKUP_REPORT_KEY:?' '$REPO/docker-compose.yml') -eq 3 ] && [ \$(grep -c '^BACKUP_REPORT_KEY=' '$S/installations/alpha/.env') -eq 1 ] && ! grep -q '^CONTROL_BACKUP_KEY=' '$S/installations/alpha/.env'"
check "Compose: backup-agent ohne ports, mit cap_drop und State-Volume" bash -c "awk '/^  backup-agent:/{f=1;next} /^  (#|[a-z-]+:)/{f=0} f' '$REPO/docker-compose.yml' > '$TMP/agent.yml'; ! grep -q 'ports:' '$TMP/agent.yml' && grep -q 'cap_drop' '$TMP/agent.yml' && grep -q 'backup-agent-state:/state' '$TMP/agent.yml' && grep -q 'read_only: true' '$TMP/agent.yml'"
check "Compose: Docker-Socket nur im docker-socket-proxy gemountet" bash -c "[ \$(grep -c 'docker\.sock' '$REPO/docker-compose.yml') -eq 1 ] && awk '/^  docker-socket-proxy:/{f=1;next} /^  (#|[a-z-]+:)/{f=0} f' '$REPO/docker-compose.yml' | grep -q 'docker.sock:ro'"
check "Compose: docker-socket-proxy ohne ports, mit eigener Allowlist-Vorlage und ohne die Schalter POST/CONTAINERS" bash -c "awk '/^  docker-socket-proxy:/{f=1;next} /^  (#|[a-z-]+:)/{f=0} f' '$REPO/docker-compose.yml' > '$TMP/proxy.yml'; ! grep -q 'ports:' '$TMP/proxy.yml' && grep -q 'ops/docker-proxy/haproxy.cfg.template:/usr/local/etc/haproxy/haproxy.cfg.template:ro' '$TMP/proxy.yml' && ! grep -Eq '^ +(POST|CONTAINERS|EXEC):' '$TMP/proxy.yml' && grep -q 'cap_drop' '$TMP/proxy.yml'"
check "Proxy-Allowlist: nur die sechs Aufrufe des Agents, am Ende deny, kein DELETE/create/kill" bash -c "f='$REPO/ops/docker-proxy/haproxy.cfg.template'; [ \$(grep -c '^    http-request allow' \$f) -eq 6 ] && grep -q '^    http-request deny\$' \$f && ! grep -E '^    http-request allow' \$f | grep -Eq 'METH_DELETE|create|kill|restart|images|volumes|env\\('"
check "Compose: Agent verbindet sich mit eigener Rolle backup_agent, nicht als Superuser control" bash -c "grep -q 'CONTROL_DATABASE_URL: postgresql://backup_agent:' '$REPO/docker-compose.yml' && ! grep -q 'CONTROL_DATABASE_URL: postgresql://control:' '$REPO/docker-compose.yml' && grep -q 'control-db-roles:' '$REPO/docker-compose.yml' && grep -q 'service_completed_successfully' '$REPO/docker-compose.yml' && grep -q 'pg_read_all_data' '$REPO/ops/control-db/backup-agent-role.sql'"
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
check "name: Registry bleibt gültiges JSON" bash -c "python3 -c 'import json,sys; d=json.load(open(sys.argv[1])); assert len(d[\"entries\"])==1' '$I/portal/registry/registry.json'"
check "name: Registry nennt Slug und trägt einen bereinigten Namen" python3 -c 'import json,sys; e=json.load(open(sys.argv[1]))["entries"][0]; assert e["slug"]=="alpha"; assert "\"" not in e["name"] and "\\" not in e["name"] and e["name"].startswith("Evil")' "$I/portal/registry/registry.json"
check_not "name: Zeilenumbruch im Namen abgelehnt" "$I/install.sh" --dir "$I" --software beta --name $'A\nB: x' --non-interactive --no-start --yes
check_not "name: zu langer Name abgelehnt" "$I/install.sh" --dir "$I" --software beta --name "$(printf 'x%.0s' $(seq 1 201))" --non-interactive --no-start --yes
check_not "name: nur Leerraum abgelehnt" "$I/install.sh" --dir "$I" --software beta --name "   " --non-interactive --no-start --yes
check "name: Registry mit Titel aus PORTAL_TITLE" env PORTAL_TITLE='Meine "Titel"' "$I/install.sh" --dir "$I" --software gamma --name "Gamma" --non-interactive --no-start --yes
check "name: Registry trägt Titel und Name Gamma" bash -c "python3 -c 'import json,sys; d=json.load(open(sys.argv[1])); assert d[\"title\"]==\"Meine Titel\"; assert [e[\"name\"] for e in d[\"entries\"] if e[\"slug\"]==\"gamma\"]==[\"Gamma\"]' '$I/portal/registry/registry.json'"

# --- portal ------------------------------------------------------------------
P="$TMP/portal"; stage "$P"
check "portal: Anlegen ohne Start läuft" "$P/install.sh" --dir "$P" --mode portal --software alpha --non-interactive --no-start --yes
check "portal: Lock = portal" grep -q '^mode=portal$' "$P/.saas-instant-mode"
check "portal: add (zweite Verwaltung)" env SAAS_INSTANT_ROOT="$P" "$P/install.sh" --dir "$P" --mode portal --software beta --non-interactive --no-start --yes
check "portal: beide .env mit 600" bash -c "[ \"\$(stat -f %Lp '$P/installations/alpha/.env' 2>/dev/null || stat -c %a '$P/installations/alpha/.env')\" = 600 ] && [ \"\$(stat -f %Lp '$P/installations/beta/.env' 2>/dev/null || stat -c %a '$P/installations/beta/.env')\" = 600 ]"
check "portal: Ports ohne Kollision" bash -c "[ \"\$(grep -h ^CONTROL_WEB_PORT= '$P'/installations/*/.env | sort | uniq -d | wc -l)\" -eq 0 ]"
check "portal: Registry vorhanden" test -f "$P/portal/registry/registry.json"
check "portal: Registry nennt alpha" grep -q '"slug": "alpha"' "$P/portal/registry/registry.json"
check "portal: Registry trägt product.name aus dem Manifest" grep -q '"name": "Mein Produkt"' "$P/portal/registry/registry.json"
check "portal: Registry nennt beta" grep -q '"slug": "beta"' "$P/portal/registry/registry.json"
check "portal: Registry ist gültiges JSON" bash -c "python3 -c 'import json,sys; d=json.load(open(sys.argv[1])); assert len(d[\"entries\"])==2' '$P/portal/registry/registry.json'"
check "portal: Registry enthält keine Geheimnisse" bash -c "! grep -Eq 'SECRET|PASSWORD|[0-9a-f]{32}' '$P/portal/registry/registry.json'"
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

# --- portal: Anmeldedienst (SSO), ohne Docker (--no-start) --------------------
hash_of() { find "$@" -type f | sort | xargs cat | { md5 2>/dev/null || md5sum; }; }
envval() { sed -n "s/^$2=//p" "$1" | head -n 1; }

A="$TMP/sso"; stage "$A"
check "sso: Trockenlauf nennt Geheimnisse, Registrierung und erstes Konto" bash -c "'$A/install.sh' --dir '$A' --mode portal --software alpha --non-interactive --dry-run --yes 2>&1 | grep -q 'PORTAL_KEY_SECRET' && '$A/install.sh' --dir '$A' --mode portal --software alpha --non-interactive --dry-run --yes 2>&1 | grep -q 'erste Portal-Konto'"
check_not "sso: Trockenlauf schreibt nichts" test -e "$A/portal"
check "sso: Installation (no-start) mit --portal-url und --app-url" "$A/install.sh" --dir "$A" --mode portal --software alpha --portal-url https://portal.example.com --app-url https://verwaltung.example.com --non-interactive --no-start --yes
PE="$A/portal/portal.env"; AE="$A/installations/alpha/.env"
check "sso: portal.env hat Rechte 600" test "$(perm "$PE")" = 600
check "sso: PORTAL_KEY_SECRET ist 64 Hex-Zeichen" grep -Eq '^PORTAL_KEY_SECRET=[0-9a-f]{64}$' "$PE"
check "sso: PORTAL_DB_PASSWORD gesetzt" grep -Eq '^PORTAL_DB_PASSWORD=[0-9a-f]{48}$' "$PE"
check "sso: Profil auth aktiv" grep -q '^COMPOSE_PROFILES=auth$' "$PE"
check "sso: Aussteller = --portal-url, Cookies secure, Proxy-Kette 2" bash -c "grep -q '^PORTAL_ISSUER=https://portal.example.com\$' '$PE' && grep -q '^PORTAL_COOKIE_SECURE=true\$' '$PE' && grep -q '^PORTAL_TRUST_PROXY=2\$' '$PE'"
check "sso: Verwaltung trägt AUTH_MODE und Client-Angaben" bash -c "grep -q '^AUTH_MODE=portal\$' '$AE' && grep -q '^PORTAL_ISSUER=https://portal.example.com\$' '$AE' && grep -q '^PORTAL_INTERNAL_URL=http://portal-auth:3100\$' '$AE' && grep -q '^PORTAL_CLIENT_ID=alpha\$' '$AE' && grep -Eq '^PORTAL_CLIENT_SECRET=[0-9a-f]{64}\$' '$AE'"
check "sso: Verwaltung hinter TLS (--app-url https): Secure-Cookies, RP-ID, Adresse" bash -c "grep -q '^CONTROL_APP_URL=https://verwaltung.example.com\$' '$AE' && grep -q '^CONTROL_RP_ID=verwaltung.example.com\$' '$AE' && grep -q '^COOKIE_SECURE=1\$' '$AE' && grep -q '^CONTROL_TRUST_PROXY=2\$' '$AE'"
check "sso: Registry nennt die https-Adresse der Verwaltung" grep -q '"url": "https://verwaltung.example.com"' "$A/portal/registry/registry.json"
check "sso: .env bleibt 600" test "$(perm "$AE")" = 600
check "sso: add (zweite Verwaltung, no-start) erhält eigenes Client-Secret" env SAAS_INSTANT_ROOT="$A" "$A/install.sh" --dir "$A" --mode portal --software beta --non-interactive --no-start --yes
check "sso: Client-Secrets der Verwaltungen unterscheiden sich" bash -c "[ \"\$(grep -h '^PORTAL_CLIENT_SECRET=' '$A'/installations/*/.env | sort -u | wc -l)\" -eq 2 ] && [ \"\$(grep -h '^PORTAL_CLIENT_SECRET=' '$A'/installations/*/.env | cut -d= -f2 | sort -u | grep -c '$(envval "$PE" PORTAL_KEY_SECRET)')\" -eq 0 ]"
check "sso: Portal-Secret, DB-Passwort und Client-Secret sind paarweise verschieden" bash -c "[ \"\$(grep -hE '^(PORTAL_KEY_SECRET|PORTAL_DB_PASSWORD|PORTAL_CLIENT_SECRET)=' '$PE' '$A'/installations/*/.env | cut -d= -f2 | sort -u | wc -l)\" -eq 4 ]"
check "sso: Aussteller der zweiten Verwaltung = der des Portals (aus portal.env)" grep -q '^PORTAL_ISSUER=https://portal.example.com$' "$A/installations/beta/.env"
BEFORE="$(hash_of "$A/portal/portal.env" "$A/installations")"
check "sso: zweiter Lauf (gleiche Slugs) ändert keine Geheimnisse" bash -c "'$A/install.sh' --dir '$A' --mode portal --software alpha --portal-url https://anders.example.com --non-interactive --no-start --yes >/dev/null 2>&1; '$A/install.sh' --dir '$A' --mode portal --software beta --non-interactive --no-start --yes >/dev/null 2>&1"
check "sso: portal.env und alle .env unverändert" test "$BEFORE" = "$(hash_of "$A/portal/portal.env" "$A/installations")"
check "sso: abweichende --portal-url wird nicht übernommen" grep -q '^PORTAL_ISSUER=https://portal.example.com$' "$PE"
check "sso: Registry und Compose enthalten keine Geheimnisse" bash -c "! grep -Eq '[0-9a-f]{40}' '$A/portal/registry/registry.json'"
check_not "sso: ungültige --portal-url abgelehnt" "$A/install.sh" --dir "$A" --software gamma --portal-url 'ftp://x' --non-interactive --no-start --yes
check_not "single: --portal-url wird verweigert" "$TMP/single/install.sh" --dir "$TMP/single" --software alpha --portal-url https://p.example.com --non-interactive --no-start --yes
check "single: .env ohne SSO-Angaben (Verhalten unverändert)" bash -c "! grep -Eq '^(AUTH_MODE|PORTAL_)' '$S/installations/alpha/.env' && grep -q '^CONTROL_APP_URL=http://localhost:' '$S/installations/alpha/.env' && grep -q '^COOKIE_SECURE=0\$' '$S/installations/alpha/.env'"
check "portal lokal (ohne --portal-url): http-Aussteller, Cookies nicht secure" bash -c "grep -Eq '^PORTAL_ISSUER=http://localhost:[0-9]+\$' '$P/portal/portal.env' && grep -q '^PORTAL_COOKIE_SECURE=false\$' '$P/portal/portal.env' && grep -q '^PORTAL_TRUST_PROXY=1\$' '$P/portal/portal.env'"
# Abweichender Netzname aus portal.env gilt auch für die Verwaltung (Zusatzdatei liest ihn aus deren .env)
# Bestehende Installation ohne BACKUP_DB_PASSWORD (Stand vor der Agent-Rolle): wird nachgetragen, danach unveraendert
grep -v '^BACKUP_DB_PASSWORD=' "$S/installations/alpha/.env" > "$TMP/e.tmp"; cp "$TMP/e.tmp" "$S/installations/alpha/.env"
"$S/install.sh" --dir "$S" --software alpha --non-interactive --no-start --yes >/dev/null 2>&1 || true
check "retrofit: BACKUP_DB_PASSWORD wird bei bestehender Installation nachgetragen" grep -Eq '^BACKUP_DB_PASSWORD=[0-9a-f]{32,}$' "$S/installations/alpha/.env"
check "retrofit: Rechte bleiben 600" test "$(perm "$S/installations/alpha/.env")" = 600
RF_BEFORE="$(cat "$S/installations/alpha/.env")"
"$S/install.sh" --dir "$S" --software alpha --non-interactive --no-start --yes >/dev/null 2>&1 || true
check "retrofit: zweiter Lauf aendert nichts" test "$RF_BEFORE" = "$(cat "$S/installations/alpha/.env")"
NW="$TMP/netname"; stage "$NW"; mkdir -p "$NW/portal"; printf 'PORTAL_AUTH_NETWORK=mein-netz\n' > "$NW/portal/portal.env"
check "sso: eigener Netzname wird in portal.env belassen und in die .env der Verwaltung übernommen" bash -c "'$NW/install.sh' --dir '$NW' --mode portal --software alpha --non-interactive --no-start --yes >/dev/null 2>&1 && grep -q '^PORTAL_AUTH_NETWORK=mein-netz\$' '$NW/installations/alpha/.env' && grep -q '^PORTAL_AUTH_NETWORK=mein-netz\$' '$NW/portal/portal.env' && grep -q '^COMPOSE_PROJECT_NAME=saas-instant-portal\$' '$NW/portal/portal.env'"
# Bestandsinstallation ohne SSO: bleibt lokal, bis ausdrücklich umgestellt wird
L="$TMP/legacy"; stage "$L"
"$L/install.sh" --dir "$L" --mode portal --software alt --non-interactive --no-start --yes >/dev/null 2>&1
grep -vE '^(AUTH_MODE|PORTAL_|# Anmeldung über das Portal)' "$L/installations/alt/.env" > "$L/alt.env" && cp "$L/alt.env" "$L/installations/alt/.env" && rm "$L/alt.env"
check "legacy: erneuter Lauf stellt eine bestehende Verwaltung NICHT um" bash -c "'$L/install.sh' --dir '$L' --mode portal --software alt --non-interactive --no-start --yes >/dev/null 2>&1; ! grep -q '^AUTH_MODE=' '$L/installations/alt/.env'"
check "legacy: portal enable --yes stellt sie um" env SAAS_INSTANT_ROOT="$L" "$L/bin/saas-instant" portal enable alt --yes
check "legacy: AUTH_MODE und Client-Secret stehen jetzt in der .env" bash -c "grep -q '^AUTH_MODE=portal\$' '$L/installations/alt/.env' && grep -Eq '^PORTAL_CLIENT_SECRET=[0-9a-f]{64}\$' '$L/installations/alt/.env'"
check "legacy: portal enable ist idempotent (Secret bleibt)" bash -c "a=\$(cat '$L/installations/alt/.env'); SAAS_INSTANT_ROOT='$L' '$L/bin/saas-instant' portal enable alt --yes >/dev/null; [ \"\$a\" = \"\$(cat '$L/installations/alt/.env')\" ]"
# Registry getrennt von portal.env: Mount nur auf portal/registry, Migration alter Installationen
check "registry: Compose mountet nur portal/registry (ueber PORTAL_REGISTRY_DIR), nicht portal/" bash -c "grep -qF -- '- \${PORTAL_REGISTRY_DIR:-../../portal/registry}:/srv/registry:ro' '$REPO/apps/portal/docker-compose.portal.yml' && ! grep -Eq -- '- ../../portal:' '$REPO/apps/portal/docker-compose.portal.yml'"
check "registry: portal.env liegt nicht im Registry-Verzeichnis" bash -c "[ -f '$L/portal/portal.env' ] && [ ! -e '$L/portal/registry/portal.env' ] && [ -f '$L/portal/registry/registry.json' ] && [ ! -e '$L/portal/registry.json' ]"
MG="$TMP/migrate"; stage "$MG"
"$MG/install.sh" --dir "$MG" --mode portal --software alpha --non-interactive --no-start --yes >/dev/null 2>&1
mv "$MG/portal/registry/registry.json" "$MG/portal/registry.json"; rmdir "$MG/portal/registry"
printf '{\n  "title": "Alt",\n  "entries": []\n}\n' > "$MG/portal/registry.json"
SECRETS_BEFORE="$(cat "$MG/portal/portal.env" "$MG/installations/alpha/.env" | cksum)"
check "migration: install.sh verschiebt die alte registry.json" bash -c "'$MG/install.sh' --dir '$MG' --mode portal --software alpha --non-interactive --no-start --yes >/dev/null 2>&1 && [ ! -e '$MG/portal/registry.json' ] && [ -f '$MG/portal/registry/registry.json' ]"
check "migration: Titel der alten Registry blieb erhalten" grep -q '"title": "Alt"' "$MG/portal/registry/registry.json"
check "migration: keine neuen Geheimnisse" test "$SECRETS_BEFORE" = "$(cat "$MG/portal/portal.env" "$MG/installations/alpha/.env" | cksum)"
check "migration: zweiter Lauf idempotent" bash -c "'$MG/install.sh' --dir '$MG' --mode portal --software alpha --non-interactive --no-start --yes >/dev/null 2>&1 && [ ! -e '$MG/portal/registry.json' ] && [ -f '$MG/portal/registry/registry.json' ]"
printf 'x' > "$MG/portal/registry.json"
check "migration: bin/saas-instant lässt abweichende alte Datei liegen (kein Datenverlust)" bash -c "SAAS_INSTANT_ROOT='$MG' PATH='$REPO/tests/mocks:$PATH' MOCK_DIR='$TMP/mockstate' '$MG/bin/saas-instant' portal clients >/dev/null 2>&1; [ -f '$MG/portal/registry.json' ] && [ -f '$MG/portal/registry/registry.json' ]"
rm -f "$MG/portal/registry/registry.json"; mv "$MG/portal/registry.json" "$MG/portal/registry.json.bak"; printf '{"entries": []}\n' > "$MG/portal/registry.json"
check "migration: bin/saas-instant verschiebt die alte Datei" bash -c "SAAS_INSTANT_ROOT='$MG' PATH='$REPO/tests/mocks:$PATH' MOCK_DIR='$TMP/mockstate' '$MG/bin/saas-instant' portal clients >/dev/null 2>&1; [ ! -e '$MG/portal/registry.json' ] && grep -q entries '$MG/portal/registry/registry.json'"
check_not "single: portal-Befehle verweigert" env SAAS_INSTANT_ROOT="$S" "$S/bin/saas-instant" portal clients
check "single: portal-Befehl nennt den Modus" bash -c "SAAS_INSTANT_ROOT='$S' '$S/bin/saas-instant' portal clients 2>&1 | grep -q 'nur im Modus portal'"

# --- portal: kompletter Start mit Docker-Attrappe ---------------------------
M="$TMP/mock"; stage "$M"
export MOCK_DIR="$TMP/mockstate"; mkdir -p "$MOCK_DIR"
OLDPATH="$PATH"; PATH="$REPO/tests/mocks:$PATH"
OUT="$TMP/start.out"
check "start: Installation mit Start (Attrappe) läuft" bash -c "'$M/install.sh' --dir '$M' --mode portal --software alpha --admin-email admin@example.org --admin-name 'Ada Admin' --non-interactive --yes > '$OUT' 2>&1"
CALLS="$MOCK_DIR/calls.log"
line_of() { grep -n -m1 -- "$1" "$CALLS" | cut -d: -f1; }
check "start: Netz wird angelegt" test -f "$MOCK_DIR/nets/saas-instant-portal-auth"
check "start: Reihenfolge Netz, Portal, Verwaltung" bash -c "n=\$(grep -n -m1 'network create' '$CALLS' | cut -d: -f1); p=\$(grep -n -m1 'portal.env.* up -d' '$CALLS' | cut -d: -f1); c=\$(grep -n -m1 'installations/alpha/.env.* up -d' '$CALLS' | cut -d: -f1); [ -n \"\$n\" ] && [ \"\$n\" -lt \"\$p\" ] && [ \"\$p\" -lt \"\$c\" ]"
check "start: Verwaltung mit Portal-Anmeldung wird mit Netz-Datei gestartet" grep -q 'installations/alpha/.env.*docker-compose.portal-net.yml.* up -d' "$CALLS"
check "start: Client registriert, Secret kam über stdin und gleicht der .env" bash -c "[ \"\$(cat '$MOCK_DIR/secret-alpha')\" = \"\$(sed -n 's/^PORTAL_CLIENT_SECRET=//p' '$M/installations/alpha/.env')\" ]"
check_not "start: kein Geheimnis in einer Argumentliste (Protokoll)" bash -c "grep -Eq '$(envval "$M/installations/alpha/.env" PORTAL_CLIENT_SECRET)|$(envval "$M/portal/portal.env" PORTAL_KEY_SECRET)' '$CALLS'"
check "start: Registrierung mit Basisadresse der Verwaltung" grep -Eq '^alpha.*http://localhost:[0-9]+/api/auth/sso/callback$' "$MOCK_DIR/clients.tsv"
check "start: erstes Konto angelegt und Rolle admin für alpha gesetzt" bash -c "grep -q 'account create-first --email admin@example.org --name Ada Admin' '$CALLS' && grep -q 'account set-role --email admin@example.org --client alpha --role admin' '$CALLS'"
check "start: Einmal-Link steht deutlich in der Ausgabe" bash -c "grep -q 'ERSTES PORTAL-KONTO: admin@example.org' '$OUT' && grep -q 'token=MOCK-EINMAL-TOKEN' '$OUT'"
check "start: Marker ohne Link/Geheimnis" bash -c "[ \"\$(cat '$M/portal/.first-account')\" = admin@example.org ]"
check_not "start: der Einmal-Link wird nirgends gespeichert" grep -rq 'MOCK-EINMAL-TOKEN' "$M/portal" "$M/installations"
: > "$CALLS"
BEFORE="$(hash_of "$M/portal/portal.env" "$M/installations")"
check "start: zweiter Lauf läuft" bash -c "'$M/install.sh' --dir '$M' --mode portal --software alpha --admin-email other@example.org --admin-name X --non-interactive --yes > '$TMP/start2.out' 2>&1"
check "start: zweiter Lauf: keine Secrets geändert" test "$BEFORE" = "$(hash_of "$M/portal/portal.env" "$M/installations")"
check_not "start: zweiter Lauf legt kein weiteres Konto an" grep -q 'create-first' "$CALLS"
check_not "start: zweiter Lauf registriert nicht erneut" grep -q 'client upsert' "$CALLS"
check "start: zweiter Lauf meldet das bestehende Konto" grep -q 'besteht bereits' "$TMP/start2.out"
check "start: bin add legt Verwaltung an und registriert sie" bash -c "SAAS_INSTANT_ROOT='$M' '$M/bin/saas-instant' add beta --name Beta > '$TMP/add.out' 2>&1 && grep -q '^beta' '$MOCK_DIR/clients.tsv' && grep -q '^AUTH_MODE=portal\$' '$M/installations/beta/.env'"
check_not "start: add ohne Konto-Optionen fragt nicht nach einem zweiten Konto" grep -q 'ERSTES PORTAL-KONTO' "$TMP/add.out"
check "start: bin portal set-role reicht Argumente durch" bash -c "SAAS_INSTANT_ROOT='$M' '$M/bin/saas-instant' portal set-role staff@example.org beta staff >/dev/null && grep -q 'account set-role --email staff@example.org --client beta --role staff' '$CALLS'"
check_not "start: ungültige Rolle abgelehnt" env SAAS_INSTANT_ROOT="$M" "$M/bin/saas-instant" portal set-role a@b.c beta boss
check "start: bin portal register ist idempotent" bash -c ": > '$CALLS'; SAAS_INSTANT_ROOT='$M' '$M/bin/saas-instant' portal register alpha | grep -q 'bereits registriert' && ! grep -q 'client upsert' '$CALLS'"
check "start: register --force schreibt neu (Secret-Wechsel)" bash -c ": > '$CALLS'; SAAS_INSTANT_ROOT='$M' '$M/bin/saas-instant' portal register alpha --force >/dev/null && grep -q 'client upsert --id alpha' '$CALLS'"
check "start: portal first-account ohne Optionen scheitert, wenn schon ein Konto besteht" bash -c "! SAAS_INSTANT_ROOT='$M' '$M/bin/saas-instant' portal first-account --email x@y.de --name X >/dev/null 2>&1"
check "start: bin up legt das Netz sicher an" bash -c "rm -f '$MOCK_DIR/nets/'*; SAAS_INSTANT_ROOT='$M' '$M/bin/saas-instant' up alpha >/dev/null && test -f '$MOCK_DIR/nets/saas-instant-portal-auth'"
check "start: bin up nutzt die Netz-Datei nur für Portal-Anmeldung" bash -c ": > '$CALLS'; SAAS_INSTANT_ROOT='$M' '$M/bin/saas-instant' up alpha >/dev/null; grep -q 'docker-compose.portal-net.yml' '$CALLS'"
check "start: emergency erinnert im Portalmodus an den Notzugang" bash -c "SAAS_INSTANT_ROOT='$M' '$M/bin/saas-instant' emergency alpha password x 2>&1 | grep -q 'emergency=true'"
# Einzelmodus mit Attrappe: kein Netz, keine Zusatzdatei, kein portal
SM="$TMP/singlemock"; stage "$SM"; : > "$CALLS"; rm -f "$MOCK_DIR/nets/"*
check "single-start: läuft" "$SM/install.sh" --dir "$SM" --mode single --software alpha --non-interactive --yes
check "single-start: nur ein docker compose up, ohne Netz-Datei, ohne Anmeldedienst" bash -c "[ \$(grep -c ' up -d' '$CALLS') -eq 1 ] && ! grep -q 'portal' '$CALLS' && ! grep -q 'network' '$CALLS'"
# --dir abweichend vom Quellbaum: die Registry muss aus dem Installationsverzeichnis in den Portal-Nginx gemountet werden
DS="$TMP/dirsrc"; stage "$DS"; DD="$TMP/dirdest"; rm -f "$MOCK_DIR/registry-dir.log"
check "dir: Installation mit --dir ausserhalb des Quellbaums (Attrappe) läuft" bash -c "'$DS/install.sh' --dir '$DD' --mode portal --software alpha --non-interactive --yes >/dev/null 2>&1"
check "dir: docker compose bekommt PORTAL_REGISTRY_DIR = <dir>/portal/registry" grep -qx "$DD/portal/registry" "$MOCK_DIR/registry-dir.log"
check_not "dir: nie der Registry-Pfad des Quellbaums" grep -q "$DS" "$MOCK_DIR/registry-dir.log"
check "dir: Registry dort nennt die Verwaltung" grep -q '"slug": "alpha"' "$DD/portal/registry/registry.json"
PATH="$OLDPATH"

# --- Compose-Dateien --------------------------------------------------------
check "compose: Portal-Netz ist extern und der Dienst hängt daran" bash -c "grep -q 'external: true' '$REPO/apps/portal/docker-compose.portal.yml' && grep -q 'portal-auth-net' '$REPO/apps/portal/docker-compose.portal.yml'"
check "compose: portal-auth und Datenbank liegen im Profil auth, DB mit Volume und Healthcheck" bash -c "awk '/^  portal-auth-db:/{f=1;next} /^  [a-z-]+:/{f=0} f' '$REPO/apps/portal/docker-compose.portal.yml' > '$TMP/pdb.yml'; grep -q 'profiles: \\[\"auth\"\\]' '$TMP/pdb.yml' && grep -q 'portal-auth-db:/var/lib/postgresql/data' '$TMP/pdb.yml' && grep -q 'pg_isready' '$TMP/pdb.yml' && ! grep -q 'portal-auth-net' '$TMP/pdb.yml'"
check "compose: portal-auth hat Healthcheck, kein veröffentlichter Port" bash -c "awk '/^  portal-auth:/{f=1;next} /^  [a-z-]+:/{f=0} f' '$REPO/apps/portal/docker-compose.portal.yml' > '$TMP/pa.yml'; grep -q 'healthcheck' '$TMP/pa.yml' && ! grep -q 'ports:' '$TMP/pa.yml' && grep -q 'expose' '$TMP/pa.yml'"
check "compose: Netz-Zusatzdatei hängt nur control-api ans Portal-Netz" bash -c "grep -q 'control-api:' '$REPO/docker-compose.portal-net.yml' && ! grep -q 'control-db' '$REPO/docker-compose.portal-net.yml' && grep -q 'external: true' '$REPO/docker-compose.portal-net.yml'"
check "compose: Hauptdatei kennt das Portal-Netz nicht (Modus single unverändert)" bash -c "! grep -q 'portal-auth-net' '$REPO/docker-compose.yml'"
if command -v docker >/dev/null 2>&1 && docker compose version >/dev/null 2>&1; then
  check "compose config: Portal mit Profil auth" bash -c "cd '$TMP' && printf 'COMPOSE_PROFILES=auth\\nPORTAL_ISSUER=https://p.example.com\\nPORTAL_KEY_SECRET=%s\\nPORTAL_DB_PASSWORD=x\\n' \$(printf 'k%.0s' \$(seq 1 40)) > p.env && docker compose --env-file p.env -f '$REPO/apps/portal/docker-compose.portal.yml' config >/dev/null"
  check "compose config: Portal ohne Profil (bestehende Installation)" bash -c "cd '$TMP' && printf 'PORTAL_PORT=8090\\n' > q.env && docker compose --env-file q.env -f '$REPO/apps/portal/docker-compose.portal.yml' config >/dev/null"
  check "compose config: Verwaltung mit Netz-Zusatzdatei" bash -c "cd '$TMP' && docker compose --project-directory '$REPO' --env-file '$A/installations/alpha/.env' -f '$REPO/docker-compose.yml' -f '$REPO/docker-compose.portal-net.yml' config | grep -q 'portal-auth-net'"
else
  printf 'skip compose config (docker compose nicht verfügbar)\n'
fi

if [ "$FAILS" -ne 0 ]; then printf '%s Prüfung(en) fehlgeschlagen\n' "$FAILS" >&2; exit 1; fi
echo "Alle Prüfungen bestanden."
