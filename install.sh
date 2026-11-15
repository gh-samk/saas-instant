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
#   portal : mehrere Verwaltungen (je eigene Datenbank und Anmeldung) plus ein
#            schlankes Portal (Liste + Links, keine Kundendaten, keine Anmeldung).
#
# Aufruf:  ./install.sh [--mode single|portal] [--software <slug>] [--name "<Name>"]
#                       [--dir <pfad>] [--host <name>] [--non-interactive] [--dry-run] [--no-start] [--yes]
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
  [ "$MODE" != "portal" ] || info "Trockenlauf: Die Portal-Registry würde aktualisiert ($PORTAL_DIR/registry.json)."
  info "Trockenlauf: Es wurde nichts geschrieben und nichts gestartet."
  exit 0
fi

# --- Lock schreiben ---------------------------------------------------------

if [ -z "$LOCKED" ]; then
  printf 'mode=%s\ncreated=%s\n' "$MODE" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" > "$LOCK_FILE"
  chmod 444 "$LOCK_FILE"
  info "Modus '$MODE' festgeschrieben ($LOCK_FILE)."
fi

# --- Verwaltung anlegen -----------------------------------------------------

umask 077
mkdir -p "$TARGET"

if [ "$EXISTING" -eq 1 ]; then
  info "Installation '$SLUG' besteht bereits; .env und Geheimnisse bleiben unverändert."
else
  PORT="$(next_free_port 8080)"
  {
    printf '# Erzeugt von install.sh. Enthält Geheimnisse, nicht einchecken.\n'
    printf 'COMPOSE_PROJECT_NAME=saas-instant-%s\n' "$SLUG"
    printf 'SAAS_INSTANT_SLUG=%s\n' "$SLUG"
    printf 'CONTROL_WEB_PORT=%s\n' "$PORT"
    printf 'CONTROL_APP_URL=http://%s:%s\n' "$HOST" "$PORT"
    printf 'CONTROL_RP_ID=%s\n' "$HOST"
    printf 'CONTROL_RP_NAME=%s\n' "$SLUG"
    printf 'CONTROL_TOTP_ISSUER=%s\n' "$SLUG"
    printf '# Lokal über http. Hinter TLS auf 1 stellen.\n'
    printf 'COOKIE_SECURE=0\n'
    printf 'CONTROL_TRUST_PROXY=1\n'
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
  mkdir -p "$PORTAL_DIR"
  local tmp="$PORTAL_DIR/registry.json.tmp" first=1 f s p h n m
  {
    printf '{\n'
    # Optionaler Seitentitel des Portals: PORTAL_TITLE (Umgebung) oder der Titel
    # der bisherigen Registry. In JSON bleiben nur unkritische Zeichen übrig.
    local title="${PORTAL_TITLE:-}"
    if [ -z "$title" ] && [ -f "$PORTAL_DIR/registry.json" ]; then
      title="$(sed -n 's/^  "title": "\(.*\)",$/\1/p' "$PORTAL_DIR/registry.json" | head -n 1)"
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
      printf '    {"slug": "%s", "name": "%s", "url": "http://%s:%s"}' "$s" "$n" "${h:-localhost}" "$p"
    done
    printf '\n  ]\n}\n'
  } > "$tmp"
  chmod 644 "$tmp"
  mv "$tmp" "$PORTAL_DIR/registry.json"
}

if [ "$MODE" = "portal" ]; then
  umask 022
  mkdir -p "$PORTAL_DIR"
  if [ ! -f "$PORTAL_DIR/portal.env" ]; then
    printf 'COMPOSE_PROJECT_NAME=saas-instant-portal\nPORTAL_PORT=%s\n' "$(next_free_port 8090)" > "$PORTAL_DIR/portal.env"
  fi
  chmod 600 "$PORTAL_DIR/portal.env"
  write_registry
  info "Portal-Registry aktualisiert: $PORTAL_DIR/registry.json"
fi

# --- Start ------------------------------------------------------------------

if [ "$NO_START" -eq 1 ]; then
  info "--no-start: Dateien angelegt, es wurde nichts gestartet."
  exit 0
fi

COMPOSE_FILE="$SRC_DIR/docker-compose.yml"
[ -f "$COMPOSE_FILE" ] || COMPOSE_FILE="$ROOT_DIR/docker-compose.yml"
docker compose --project-directory "$(dirname "$COMPOSE_FILE")" --env-file "$TARGET/.env" -f "$COMPOSE_FILE" up -d --build
if [ "$MODE" = "portal" ]; then
  PORTAL_COMPOSE="$SRC_DIR/apps/portal/docker-compose.portal.yml"
  [ -f "$PORTAL_COMPOSE" ] || PORTAL_COMPOSE="$ROOT_DIR/apps/portal/docker-compose.portal.yml"
  docker compose --env-file "$PORTAL_DIR/portal.env" -f "$PORTAL_COMPOSE" up -d --build
fi

info "Fertig. Das erste Konto legst du so an:"
info "  bin/saas-instant emergency $SLUG first-account <email> <name>"
