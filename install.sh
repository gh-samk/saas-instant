#!/usr/bin/env bash
# saas-instant: Erstinstallation.
#
# Legt je Verwaltung ein Verzeichnis installations/<slug>/ an (.env mit
# zufälligen Geheimnissen, Rechte 600, Kopie des Beispielmanifests) und startet
# den Control-Stack mit 'docker compose'.
#
# Der Modus (single|portal) wird bei der Erstinstallation GEWÄHLT und in
# .saas-instant-mode festgeschrieben. Danach ist er unveränderlich.
#   single : genau eine Verwaltung, kein Portal.
#   portal : mehrere Verwaltungen (je eigene Datenbank) plus ein Portal mit
#            gemeinsamer Anmeldung (Anmeldedienst portal-auth, OIDC). Jede
#            Verwaltung meldet über das Portal an (AUTH_MODE=portal); install.sh
#            erzeugt dafür die Geheimnisse, startet den Anmeldedienst, registriert
#            die Verwaltung dort und legt beim ersten Mal das erste Portal-Konto an.
#
# Aufruf:  ./install.sh [--mode single|portal] [--software <slug>] [--name "<Name>"]
#                       [--dir <pfad>] [--host <name>] [--portal-url <url>] [--app-url <url>]
#                       [--admin-email <e> --admin-name <n>]
#                       [--non-interactive] [--dry-run] [--no-start] [--yes]
#
# --dry-run   zeigt nur, was geschähe. Es wird NICHTS geschrieben, auch kein
#             Modus-Lock, und nichts gestartet.
# --no-start  legt alles echt an (auch den Modus-Lock), startet aber keine
#             Container und braucht kein docker.
set -euo pipefail

SRC_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$SRC_DIR"
MODE=""
SLUG=""
NAME=""
HOST="localhost"
NON_INTERACTIVE=0
DRY_RUN=0
NO_START=0
ASSUME_YES=0
PORTAL_URL_OPT=""
APP_URL_OPT=""
ADMIN_EMAIL=""
ADMIN_NAME=""

die() { printf 'Fehler: %s\n' "$*" >&2; exit 1; }
info() { printf '%s\n' "$*"; }
warn() { printf 'Hinweis: %s\n' "$*" >&2; }

usage() {
  cat <<'USAGE'
Verwendung: ./install.sh [Optionen]

  --mode single|portal   Betriebsart (nur bei der Erstinstallation wählbar)
  --software <slug>      Kennung der Software (a-z, 0-9, Bindestrich)
  --name "<Name>"        Anzeigename der Software (kommt als product.name ins Manifest;
                         beliebiger Text, 1 bis 200 Zeichen, ohne Steuerzeichen)
  --dir <pfad>           Zielverzeichnis (Vorgabe: Ordner dieses Skripts)
  --host <name>          Hostname für die Adressen (Vorgabe: localhost)
  --portal-url <url>     Öffentliche Adresse des Portals (Modus portal, nur beim ersten Mal),
                         z. B. https://portal.example.com; zugleich der Aussteller (iss) der
                         Anmeldung. Vorgabe: http://<host>:<portal-port> (nur lokal brauchbar)
  --app-url <url>        Öffentliche Adresse dieser Verwaltung (nur beim Anlegen), z. B.
                         https://verwaltung.example.com; Vorgabe: http://<host>:<port>
  --admin-email <e>      Modus portal, erste Installation: E-Mail des ersten Portal-Kontos
  --admin-name <n>       dazu der Name
  --non-interactive      Keine Rückfragen; --mode und --software sind Pflicht
  --dry-run              Nur anzeigen, was geschähe; nichts schreiben, nichts starten
  --no-start             Dateien anlegen (auch den Modus-Lock), aber nichts starten
  --yes                  Bestätigungen automatisch mit Ja beantworten
  -h, --help             Diese Hilfe
USAGE
}

while [ $# -gt 0 ]; do
  case "$1" in
    --mode) [ $# -ge 2 ] || die "--mode braucht einen Wert."; MODE="$2"; shift 2 ;;
    --software) [ $# -ge 2 ] || die "--software braucht einen Wert."; SLUG="$2"; shift 2 ;;
    --dir) [ $# -ge 2 ] || die "--dir braucht einen Wert."; ROOT_DIR="$2"; shift 2 ;;
    --name) [ $# -ge 2 ] || die "--name braucht einen Wert."; NAME="$2"; shift 2 ;;
    --host) [ $# -ge 2 ] || die "--host braucht einen Wert."; HOST="$2"; shift 2 ;;
    --portal-url) [ $# -ge 2 ] || die "--portal-url braucht einen Wert."; PORTAL_URL_OPT="$2"; shift 2 ;;
    --app-url) [ $# -ge 2 ] || die "--app-url braucht einen Wert."; APP_URL_OPT="$2"; shift 2 ;;
    --admin-email) [ $# -ge 2 ] || die "--admin-email braucht einen Wert."; ADMIN_EMAIL="$2"; shift 2 ;;
    --admin-name) [ $# -ge 2 ] || die "--admin-name braucht einen Wert."; ADMIN_NAME="$2"; shift 2 ;;
    --non-interactive) NON_INTERACTIVE=1; shift ;;
    --dry-run) DRY_RUN=1; shift ;;
    --no-start) NO_START=1; shift ;;
    --yes|-y) ASSUME_YES=1; shift ;;
    -h|--help) usage; exit 0 ;;
    *) usage >&2; die "Unbekannte Option: $1" ;;
  esac
done

if [ "$DRY_RUN" -eq 0 ]; then mkdir -p "$ROOT_DIR"; fi
if [ -d "$ROOT_DIR" ]; then ROOT_DIR="$(cd "$ROOT_DIR" && pwd)"; fi
LOCK_FILE="$ROOT_DIR/.saas-instant-mode"
INSTALL_DIR="$ROOT_DIR/installations"
PORTAL_DIR="$ROOT_DIR/portal"

# --- Hilfsfunktionen --------------------------------------------------------

ask() { # ask <Frage> <Vorgabe>  -> Antwort auf stdout
  local answer
  read -r -p "$1 [$2]: " answer || answer=""
  printf '%s' "${answer:-$2}"
}

confirm() {
  [ "$ASSUME_YES" -eq 1 ] && return 0
  [ "$NON_INTERACTIVE" -eq 1 ] && return 0
  local answer
  read -r -p "$1 [j/N]: " answer || answer=""
  case "$answer" in j|J|y|Y|ja|Ja|yes) return 0 ;; *) return 1 ;; esac
}

# Der Name landet als YAML-Text im Manifest und als JSON-Text in der Registry.
# Er wird NIE von einer Shell oder von sed ausgewertet (nur als Variable,
# per awk/ENVIRON eingesetzt); Steuerzeichen (Zeilenumbruch!) sind verboten.
valid_name() {
  [ -n "$1" ] || return 1
  [ "${#1}" -le 200 ] || return 1
  case "$1" in *[[:cntrl:]]*) return 1 ;; esac
  [[ "$1" =~ [^[:space:]] ]]
}

valid_slug() { [[ "$1" =~ ^[a-z0-9]([a-z0-9-]{0,38}[a-z0-9])?$ ]]; }

lock_mode() {
  [ -f "$LOCK_FILE" ] || return 0
  sed -n 's/^mode=//p' "$LOCK_FILE" | head -n 1
}

port_in_use() { # Prüft, ob lokal schon jemand auf dem Port lauscht
  (exec 3<>"/dev/tcp/127.0.0.1/$1") 2>/dev/null && { exec 3>&- 3<&-; return 0; }
  return 1
}

port_reserved() { # In einer anderen Installation vergeben?
  local port="$1" f
  for f in "$INSTALL_DIR"/*/.env "$PORTAL_DIR/portal.env"; do
    [ -f "$f" ] || continue
    if grep -Eq "^(CONTROL_WEB_PORT|PORTAL_PORT)=$port\$" "$f"; then return 0; fi
  done
  return 1
}

next_free_port() { # next_free_port <Startport>
  local port="$1"
  while port_reserved "$port" || port_in_use "$port"; do port=$((port + 1)); done
  printf '%s' "$port"
}

secret() { openssl rand -hex "$1"; }

valid_url() { [[ "$1" =~ ^https?://[A-Za-z0-9]([A-Za-z0-9.-]*[A-Za-z0-9])?(:[0-9]{1,5})?/?$ ]]; }
valid_email() { [[ "$1" =~ ^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$ ]]; }

env_get() { # env_get <Datei> <NAME>
  [ -f "$1" ] || return 0
  sed -n "s/^$2=//p" "$1" | head -n 1 | tr -d '\r'
}

env_add() { # env_add <Datei> <NAME> <WERT>: nur ergänzen, nie überschreiben
  grep -q "^$2=" "$1" 2>/dev/null && return 0
  if [ -s "$1" ] && [ "$(tail -c 1 "$1" | wc -l)" -eq 0 ]; then printf '\n' >> "$1"; fi
  printf '%s=%s\n' "$2" "$3" >> "$1"
}

# --- Voraussetzungen --------------------------------------------------------

command -v openssl >/dev/null 2>&1 || die "openssl fehlt. Bitte installieren."
if [ "$DRY_RUN" -eq 1 ] || [ "$NO_START" -eq 1 ]; then
  command -v docker >/dev/null 2>&1 || warn "docker nicht gefunden (ohne Start unkritisch)."
else
  command -v docker >/dev/null 2>&1 || die "docker fehlt. Bitte Docker installieren."
  docker compose version >/dev/null 2>&1 || die "'docker compose' (Compose v2) fehlt."
  docker info >/dev/null 2>&1 || die "Der Docker-Dienst antwortet nicht. Läuft er?"
fi

# --- Modus ------------------------------------------------------------------

LOCKED="$(lock_mode)"
if [ -n "$LOCKED" ]; then
  if [ -n "$MODE" ] && [ "$MODE" != "$LOCKED" ]; then
    die "Der Modus ist bereits auf '$LOCKED' festgelegt und lässt sich nicht ändern (gewünscht: '$MODE'). Für einen anderen Modus ist eine neue Installation in einem leeren Verzeichnis nötig."
  fi
  MODE="$LOCKED"
else
  if [ -z "$MODE" ]; then
    [ "$NON_INTERACTIVE" -eq 0 ] || die "--mode single|portal ist im nicht-interaktiven Betrieb Pflicht."
    info "Betriebsart wählen. ACHTUNG: Die Wahl ist endgültig."
    info "  single : eine Verwaltung für eine Software"
    info "  portal : mehrere Verwaltungen plus ein schlankes Portal (nur Liste und Links)"
    MODE="$(ask 'Modus' single)"
  fi
fi
case "$MODE" in single|portal) ;; *) die "Ungültiger Modus '$MODE'. Erlaubt: single, portal." ;; esac

# --- Software-Kennung -------------------------------------------------------

if [ -z "$SLUG" ]; then
  [ "$NON_INTERACTIVE" -eq 0 ] || die "--software <slug> ist im nicht-interaktiven Betrieb Pflicht."
  SLUG="$(ask 'Kennung der Software (a-z, 0-9, Bindestrich)' mein-produkt)"
fi
valid_slug "$SLUG" || die "Ungültige Kennung '$SLUG'. Erlaubt: a-z, 0-9, Bindestrich (1 bis 40 Zeichen)."

if [ -n "$PORTAL_URL_OPT" ]; then
  valid_url "$PORTAL_URL_OPT" || die "Ungültige --portal-url '$PORTAL_URL_OPT'. Erwartet: http(s)://host[:port] ohne Pfad."
  PORTAL_URL_OPT="${PORTAL_URL_OPT%/}"
fi
if [ -n "$APP_URL_OPT" ]; then
  valid_url "$APP_URL_OPT" || die "Ungültige --app-url '$APP_URL_OPT'. Erwartet: http(s)://host[:port] ohne Pfad."
  APP_URL_OPT="${APP_URL_OPT%/}"
fi
if [ -n "$ADMIN_EMAIL" ]; then valid_email "$ADMIN_EMAIL" || die "Ungültige --admin-email."; fi
if [ -n "$ADMIN_NAME" ]; then valid_name "$ADMIN_NAME" || die "Ungültiger --admin-name."; fi
if [ "$MODE" != "portal" ] && { [ -n "$PORTAL_URL_OPT" ] || [ -n "$ADMIN_EMAIL" ] || [ -n "$ADMIN_NAME" ]; }; then
  die "--portal-url, --admin-email und --admin-name gelten nur im Modus portal."
fi

if [ -n "$NAME" ]; then
  valid_name "$NAME" || die "Ungültiger Name. Erlaubt: 1 bis 200 Zeichen, nicht nur Leerraum, keine Steuerzeichen (auch kein Zeilenumbruch)."
fi

TARGET="$INSTALL_DIR/$SLUG"
EXISTING=0
[ -f "$TARGET/.env" ] && EXISTING=1

if [ "$MODE" = "single" ] && [ "$EXISTING" -eq 0 ] && [ -d "$INSTALL_DIR" ]; then
  for d in "$INSTALL_DIR"/*/; do
    [ -f "${d}.env" ] || continue
    die "Im Modus single gibt es genau eine Verwaltung ('$(basename "$d")'). Eine weitere ist nicht vorgesehen."
  done
fi

info "Modus: $MODE | Software: $SLUG${NAME:+ | Name: $NAME} | Verzeichnis: $TARGET"
confirm "Fortfahren?" || die "Abgebrochen."

# --- Trockenlauf: hier endet er, es wurde nichts geschrieben -----------------

if [ "$DRY_RUN" -eq 1 ]; then
  [ -n "$LOCKED" ] || info "Trockenlauf: Der Modus '$MODE' würde festgeschrieben ($LOCK_FILE)."
  if [ "$EXISTING" -eq 1 ]; then
    info "Trockenlauf: Installation '$SLUG' besteht bereits; sie bliebe unverändert."
  else
    info "Trockenlauf: Es würden angelegt: $TARGET/.env, $TARGET/saas-instant.manifest.yaml"
  fi
  if [ "$MODE" = "portal" ]; then
    info "Trockenlauf: Die Portal-Registry würde aktualisiert ($PORTAL_DIR/registry/registry.json)."
    if [ ! -f "$PORTAL_DIR/portal.env" ] || ! grep -q '^PORTAL_KEY_SECRET=' "$PORTAL_DIR/portal.env"; then
      info "Trockenlauf: $PORTAL_DIR/portal.env erhielte die Geheimnisse des Anmeldedienstes (PORTAL_KEY_SECRET, PORTAL_DB_PASSWORD; Rechte 600)."
    fi
    [ "$EXISTING" -eq 1 ] || info "Trockenlauf: '$SLUG' würde auf Anmeldung über das Portal (AUTH_MODE=portal) mit eigenem Client-Secret eingerichtet und beim Anmeldedienst registriert."
    [ -f "$PORTAL_DIR/.first-account" ] || info "Trockenlauf: Das erste Portal-Konto würde angelegt (Einmal-Link wird ausgegeben)."
  fi
  info "Trockenlauf: Es wurde nichts geschrieben und nichts gestartet."
  exit 0
fi

# --- Lock schreiben ---------------------------------------------------------

if [ -z "$LOCKED" ]; then
  printf 'mode=%s\ncreated=%s\n' "$MODE" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" > "$LOCK_FILE"
  chmod 444 "$LOCK_FILE"
  info "Modus '$MODE' festgeschrieben ($LOCK_FILE)."
fi

# --- Portal-Konfiguration (nur Modus portal) ----------------------------------
# portal/portal.env: Port, Aussteller-URL und die Geheimnisse des Anmeldedienstes.
# Es wird nur ERGÄNZT, was fehlt; vorhandene Werte (auch alle Geheimnisse) bleiben.

ensure_portal_env() {
  local f="$PORTAL_DIR/portal.env" port issuer secure trust
  ( umask 022; mkdir -p "$PORTAL_DIR" )
  if [ ! -f "$f" ]; then ( umask 077; : > "$f" ); fi
  chmod 600 "$f"
  env_add "$f" COMPOSE_PROJECT_NAME saas-instant-portal
  grep -q '^PORTAL_PORT=' "$f" || env_add "$f" PORTAL_PORT "$(next_free_port 8090)"
  port="$(env_get "$f" PORTAL_PORT)"
  issuer="$(env_get "$f" PORTAL_ISSUER)"
  if [ -z "$issuer" ]; then
    issuer="${PORTAL_URL_OPT:-http://$HOST:$port}"
    case "$issuer" in
      https://*) secure=true; trust=2 ;;
      *) secure=false; trust=1
         warn "Das Portal läuft über http ($issuer): Anmeldecookies ohne Secure/__Host-, nur für lokale Versuche. Für den Betrieb --portal-url https://... angeben." ;;
    esac
    env_add "$f" PORTAL_ISSUER "$issuer"
    env_add "$f" PORTAL_COOKIE_SECURE "$secure"
    env_add "$f" PORTAL_TRUST_PROXY "$trust"
  elif [ -n "$PORTAL_URL_OPT" ] && [ "$PORTAL_URL_OPT" != "$issuer" ]; then
    warn "Das Portal hat schon die Adresse $issuer; --portal-url wurde nicht übernommen (ändern in $f würde alle ausgestellten Anmeldungen ungültig machen)."
  fi
  env_add "$f" PORTAL_KEY_SECRET "$(secret 32)"
  env_add "$f" PORTAL_DB_PASSWORD "$(secret 24)"
  env_add "$f" COMPOSE_PROFILES auth
}

# Die Registry liegt in einem eigenen Unterverzeichnis (portal/registry/), nur
# dieses wird in den Portal-nginx gemountet; portal.env bleibt außerhalb.
# Ältere Installationen hatten portal/registry.json: verschieben, idempotent.
migrate_registry() {
  local old="$PORTAL_DIR/registry.json" dir="$PORTAL_DIR/registry"
  ( umask 022; mkdir -p "$dir" )
  chmod 755 "$dir"
  [ -f "$old" ] || return 0
  if [ ! -e "$dir/registry.json" ]; then
    mv "$old" "$dir/registry.json"
    info "Portal-Registry nach $dir/registry.json verschoben."
  elif cmp -s "$old" "$dir/registry.json"; then
    rm -f "$old"
  else
    warn "$old und $dir/registry.json bestehen beide; die neue Datei gilt, die alte bleibt unverändert liegen."
  fi
}

if [ "$MODE" = "portal" ]; then
  ensure_portal_env
  migrate_registry
  info "Portal-Konfiguration: $PORTAL_DIR/portal.env (Rechte 600)"
fi

# --- Verwaltung anlegen -----------------------------------------------------

umask 077
mkdir -p "$TARGET"

if [ "$EXISTING" -eq 1 ]; then
  info "Installation '$SLUG' besteht bereits; .env und Geheimnisse bleiben unverändert."
else
  PORT="$(next_free_port 8080)"
  APP_URL="http://$HOST:$PORT"; APP_RP_ID="$HOST"; APP_COOKIE_SECURE=0; APP_TRUST=1
  if [ -n "$APP_URL_OPT" ]; then
    APP_URL="$APP_URL_OPT"
    APP_RP_ID="${APP_URL#*://}"; APP_RP_ID="${APP_RP_ID%%/*}"; APP_RP_ID="${APP_RP_ID%%:*}"
    case "$APP_URL" in https://*) APP_COOKIE_SECURE=1; APP_TRUST=2 ;; esac
  fi
  {
    printf '# Erzeugt von install.sh. Enthält Geheimnisse, nicht einchecken.\n'
    printf 'COMPOSE_PROJECT_NAME=saas-instant-%s\n' "$SLUG"
    printf 'SAAS_INSTANT_SLUG=%s\n' "$SLUG"
    printf 'CONTROL_WEB_PORT=%s\n' "$PORT"
    printf 'CONTROL_APP_URL=%s\n' "$APP_URL"
    printf 'CONTROL_RP_ID=%s\n' "$APP_RP_ID"
    printf 'CONTROL_RP_NAME=%s\n' "$SLUG"
    printf 'CONTROL_TOTP_ISSUER=%s\n' "$SLUG"
    printf '# Lokal über http. Hinter TLS auf 1 stellen.\n'
    printf 'COOKIE_SECURE=%s\n' "$APP_COOKIE_SECURE"
    printf 'CONTROL_TRUST_PROXY=%s\n' "$APP_TRUST"
    printf 'CONTROL_POSTGRES_PASSWORD=%s\n' "$(secret 24)"
    printf 'JWT_SECRET=%s\n' "$(secret 32)"
    printf 'CONTROL_CONFIG_KEY=%s\n' "$(secret 32)"
    printf '# Sicherungen: Verwaltung <-> Backup-Agent (nur im Compose-Netz).\n'
    printf 'BACKUP_AGENT_SECRET=%s\n' "$(secret 32)"
    printf 'AGENT_STATE_KEY=%s\n' "$(secret 32)"
    printf 'BACKUP_REPORT_KEY=%s\n' "$(secret 32)"
    printf 'MANIFEST_FILE=%s\n' "$TARGET/saas-instant.manifest.yaml"
  } > "$TARGET/.env"
  chmod 600 "$TARGET/.env"
  info "Angelegt: $TARGET/.env (Rechte 600, Port $PORT)"
fi

if [ ! -f "$TARGET/saas-instant.manifest.yaml" ]; then
  EXAMPLE="$SRC_DIR/saas-instant.manifest.example.yaml"
  [ -f "$EXAMPLE" ] || EXAMPLE="$ROOT_DIR/saas-instant.manifest.example.yaml"
  [ -f "$EXAMPLE" ] || die "Beispielmanifest saas-instant.manifest.example.yaml nicht gefunden."
  # Slug und (optional) Name im Abschnitt `product:` setzen. Die Werte gehen
  # per Umgebung an awk (ENVIRON), nicht per Quoting in ein Skript: Anführungszeichen,
  # Backticks, $(...) und Backslashes im Namen bleiben reiner Text. Im YAML steht der
  # Name in doppelten Anführungszeichen, `\` und `"` sind maskiert.
  NAME_YAML="${NAME//\\/\\\\}"
  NAME_YAML="${NAME_YAML//\"/\\\"}"
  MF_SLUG="$SLUG" MF_NAME="$NAME_YAML" awk '
    BEGIN { slug = ENVIRON["MF_SLUG"]; name = ENVIRON["MF_NAME"] }
    /^product:/ { inproduct = 1; print; next }
    /^[^ \t#]/ { inproduct = 0 }
    inproduct && /^[ \t]+slug:/ { sub(/slug:[ \t]*[^ \t#]+/, "slug: " slug); print; next }
    inproduct && name != "" && /^[ \t]+name:/ {
      match($0, /^[ \t]+/); print substr($0, 1, RLENGTH) "name: \"" name "\""; next
    }
    { print }
  ' "$EXAMPLE" > "$TARGET/saas-instant.manifest.yaml"
  chmod 644 "$TARGET/saas-instant.manifest.yaml"
  info "Angelegt: $TARGET/saas-instant.manifest.yaml (bitte anpassen)"
elif [ -n "$NAME" ]; then
  warn "Das Manifest von '$SLUG' besteht bereits und bleibt unverändert; --name wurde nicht übernommen (product.name dort von Hand ändern)."
fi

# Basisdomain der Instanzen aus dem Manifest in die .env übernehmen. Compose
# setzt sie beim Bauen der Oberfläche ein (VITE_INSTANCE_BASE_DOMAIN), damit die
# Oberfläche die volle Instanz-Adresse verlinkt. Der Platzhalter example.com
# aus dem Beispielmanifest wird nicht übernommen; eine vorhandene Zeile bleibt.
if ! grep -q '^CONTROL_INSTANCE_BASE_DOMAIN=' "$TARGET/.env"; then
  BASE_DOMAIN="$(sed -n 's/^ *instanceDomainBase: *//p' "$TARGET/saas-instant.manifest.yaml" | head -n 1 | sed 's/ *#.*$//' | tr -d '\r' | tr -d "\"'")"
  case "$BASE_DOMAIN" in
    ''|example.com) ;;
    *[!a-zA-Z0-9.-]*) warn "provisioning.instanceDomainBase im Manifest ist keine Domain; nicht in die .env übernommen." ;;
    *) printf 'CONTROL_INSTANCE_BASE_DOMAIN=%s\n' "$BASE_DOMAIN" >> "$TARGET/.env"
       info "Basisdomain der Instanzen aus dem Manifest übernommen: $BASE_DOMAIN" ;;
  esac
fi

# --- Portal (nur Modus portal) ----------------------------------------------

write_registry() {
  mkdir -p "$PORTAL_DIR/registry"
  local tmp="$PORTAL_DIR/registry/registry.json.tmp" first=1 f s p h n m u
  {
    printf '{\n'
    # Optionaler Seitentitel des Portals: PORTAL_TITLE (Umgebung) oder der Titel
    # der bisherigen Registry. In JSON bleiben nur unkritische Zeichen übrig.
    local title="${PORTAL_TITLE:-}"
    if [ -z "$title" ] && [ -f "$PORTAL_DIR/registry/registry.json" ]; then
      title="$(sed -n 's/^  "title": "\(.*\)",$/\1/p' "$PORTAL_DIR/registry/registry.json" | head -n 1)"
    fi
    title="$(printf '%s' "$title" | tr -d '[:cntrl:]' | tr -d "\"'" | tr -d '\\' | cut -c1-80)"
    [ -z "$title" ] || printf '  "title": "%s",\n' "$title"
    printf '  "entries": [\n'
    for f in "$INSTALL_DIR"/*/.env; do
      [ -f "$f" ] || continue
      s="$(sed -n 's/^SAAS_INSTANT_SLUG=//p' "$f" | head -n 1)"
      p="$(sed -n 's/^CONTROL_WEB_PORT=//p' "$f" | head -n 1)"
      h="$(sed -n 's/^CONTROL_APP_URL=http:\/\/\([^:]*\):.*/\1/p' "$f" | head -n 1)"
      [ -n "$s" ] && [ -n "$p" ] || continue
      # Anzeigename = product.name aus dem kopierten Manifest (einfache Heuristik)
      m="$(dirname "$f")/saas-instant.manifest.yaml"
      n=""
      if [ -f "$m" ]; then
        n="$(sed -n '/^product:/,/^[^ #]/p' "$m" | sed -n 's/^ *name: *//p' | head -n 1 | tr -d '\r')"
        # In Anführungszeichen: Inhalt bis zum letzten ", sonst bis zu einem Kommentar.
        if [[ "$n" =~ ^\"(.*)\"[[:space:]]*(#.*)?$ ]]; then n="${BASH_REMATCH[1]}"; else n="${n%%[[:space:]]#*}"; fi
        n="$(printf '%s' "$n" | tr -d '[:cntrl:]' | tr -d "\"'" | tr -d '\\' | cut -c1-200)"
      fi
      [ -n "$n" ] || n="$s"
      [ "$first" -eq 1 ] || printf ',\n'
      first=0
      u="$(sed -n 's/^CONTROL_APP_URL=//p' "$f" | head -n 1 | tr -d '\r' | tr -d "\"'\\\\ ")"
      [ -n "$u" ] || u="http://${h:-localhost}:$p"
      printf '    {"slug": "%s", "name": "%s", "url": "%s"}' "$s" "$n" "${u%/}"
    done
    printf '\n  ]\n}\n'
  } > "$tmp"
  chmod 644 "$tmp"
  mv "$tmp" "$PORTAL_DIR/registry/registry.json"
}

# bin/saas-instant mit demselben Wurzelverzeichnis aufrufen (Portal-Befehle).
si() { SAAS_INSTANT_ROOT="$ROOT_DIR" "$SRC_DIR/bin/saas-instant" "$@"; }

if [ "$MODE" = "portal" ]; then
  # Neue Verwaltung: Anmeldung über das Portal (AUTH_MODE=portal, eigenes Client-Secret).
  # Eine bestehende Verwaltung wird nicht stillschweigend umgestellt.
  if [ "$EXISTING" -eq 0 ]; then
    si portal enable "$SLUG" --yes
  elif ! grep -q '^AUTH_MODE=portal$' "$TARGET/.env"; then
    warn "'$SLUG' meldet noch lokal an (kein AUTH_MODE=portal). Umstellen auf die Portal-Anmeldung: bin/saas-instant portal enable $SLUG"
  fi
  umask 022
  write_registry
  info "Portal-Registry aktualisiert: $PORTAL_DIR/registry/registry.json"
fi

# --- Start ------------------------------------------------------------------

if [ "$NO_START" -eq 1 ]; then
  info "--no-start: Dateien angelegt, es wurde nichts gestartet."
  exit 0
fi

COMPOSE_FILE="$SRC_DIR/docker-compose.yml"
[ -f "$COMPOSE_FILE" ] || COMPOSE_FILE="$ROOT_DIR/docker-compose.yml"
NET_COMPOSE="$SRC_DIR/docker-compose.portal-net.yml"
[ -f "$NET_COMPOSE" ] || NET_COMPOSE="$ROOT_DIR/docker-compose.portal-net.yml"
COMPOSE_FILES=(-f "$COMPOSE_FILE")
if grep -q '^AUTH_MODE=portal$' "$TARGET/.env"; then COMPOSE_FILES+=(-f "$NET_COMPOSE"); fi

if [ "$MODE" != "portal" ]; then
  docker compose --project-directory "$(dirname "$COMPOSE_FILE")" --env-file "$TARGET/.env" "${COMPOSE_FILES[@]}" up -d --build
  info "Fertig. Das erste Konto legst du so an:"
  info "  bin/saas-instant emergency $SLUG first-account <email> <name>"
  exit 0
fi

# Modus portal: erst das Portal mit dem Anmeldedienst, dann die Verwaltung.
PORTAL_COMPOSE="$SRC_DIR/apps/portal/docker-compose.portal.yml"
[ -f "$PORTAL_COMPOSE" ] || PORTAL_COMPOSE="$ROOT_DIR/apps/portal/docker-compose.portal.yml"
AUTH_NET="$(env_get "$PORTAL_DIR/portal.env" PORTAL_AUTH_NETWORK)"; AUTH_NET="${AUTH_NET:-saas-instant-portal-auth}"
pdc() { docker compose --env-file "$PORTAL_DIR/portal.env" -f "$PORTAL_COMPOSE" "$@"; }

docker network inspect "$AUTH_NET" >/dev/null 2>&1 || docker network create "$AUTH_NET" >/dev/null
pdc up -d --build

info "Warte auf den Anmeldedienst ..."
healthy=0
for _ in $(seq 1 60); do
  if pdc exec -T portal-auth node -e "fetch('http://127.0.0.1:3100/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))" >/dev/null 2>&1; then healthy=1; break; fi
  sleep 2
done
[ "$healthy" -eq 1 ] || die "Der Anmeldedienst antwortet nicht. Logs: docker compose --env-file $PORTAL_DIR/portal.env -f $PORTAL_COMPOSE logs portal-auth"

# Verwaltung beim Anmeldedienst registrieren (nur, wenn sie die Portal-Anmeldung nutzt).
if grep -q '^AUTH_MODE=portal$' "$TARGET/.env"; then si portal register "$SLUG"; fi
docker compose --project-directory "$(dirname "$COMPOSE_FILE")" --env-file "$TARGET/.env" "${COMPOSE_FILES[@]}" up -d --build

# Erstes Portal-Konto: nur beim ersten Mal. Der Einmal-Link steht ganz am Ende der Ausgabe.
if [ -f "$PORTAL_DIR/.first-account" ]; then
  info "Das erste Portal-Konto besteht bereits ($(head -n 1 "$PORTAL_DIR/.first-account"))."
else
  if [ -z "$ADMIN_EMAIL" ] && [ "$NON_INTERACTIVE" -eq 0 ]; then
    ADMIN_EMAIL="$(ask 'E-Mail-Adresse des ersten Portal-Kontos (leer = später)' '')"
    if [ -n "$ADMIN_EMAIL" ] && [ -z "$ADMIN_NAME" ]; then ADMIN_NAME="$(ask 'Name' 'Administration')"; fi
  fi
  if [ -n "$ADMIN_EMAIL" ]; then
    valid_email "$ADMIN_EMAIL" || die "Ungültige E-Mail-Adresse für das erste Konto."
    : "${ADMIN_NAME:=Administration}"
    if si portal first-account --email "$ADMIN_EMAIL" --name "$ADMIN_NAME"; then
      si portal set-role "$ADMIN_EMAIL" "$SLUG" admin
    else
      warn "Das erste Konto konnte nicht angelegt werden. Später: bin/saas-instant portal first-account"
    fi
  else
    info "Noch kein Portal-Konto. Anlegen mit: bin/saas-instant portal first-account --email <e> --name <n>"
    info "Danach Rolle vergeben:               bin/saas-instant portal set-role <e> $SLUG admin"
  fi
fi
info "Fertig. Portal: $(env_get "$PORTAL_DIR/portal.env" PORTAL_ISSUER) | Verwaltung '$SLUG': $(env_get "$TARGET/.env" CONTROL_APP_URL)"
info "Notzugang (lokal, ohne Portal): bin/saas-instant emergency $SLUG first-account <email> <name>"
