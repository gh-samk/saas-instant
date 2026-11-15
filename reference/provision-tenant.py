#!/usr/bin/env python3
"""
Referenz: Tenant-Provisionierung über die Coolify-API (Betriebsmodell A).

Legt für einen Kunden eine eigene Instanz an, erreichbar unter
<slug>.<BASE_DOMAIN>: Coolify-App (Docker-Compose aus dem privaten Repo, Branch
main), frische Secrets, Domain + TLS, und deployt sie. Danach steht der Tenant.

Voraussetzungen (einmalig eingerichtet):
  - SSH-Tunnel zur Coolify-API läuft:  ssh -fN -L 8000:localhost:8000 <server>
  - Coolify-API-Token liegt in ~/instanz-coolify-token.txt (chmod 600)
  - Der Deploy-Key (Coolify-Key INSTANCE_PRIVATE_KEY_UUID) hängt read-only am Git-Repo
  - DNS-Wildcard *.<BASE_DOMAIN> -> Server-IP ist gesetzt

Aufruf:
  python3 provision-tenant.py <slug>
  z. B.:  python3 provision-tenant.py phoenixberg

Instanz-spezifische Werte lassen sich per Umgebungsvariable überschreiben
(INSTANCE_PROJECT_UUID, INSTANCE_SERVER_UUID, INSTANCE_PRIVATE_KEY_UUID, INSTANCE_REPO (Pflicht), INSTANCE_BASE_DOMAIN …).
"""

import json
import os
import re
import secrets
import sys
import time
import urllib.error
import urllib.request
from datetime import datetime, timezone

# ---------------------------------------------------------------- Konfiguration
API = os.environ.get("COOLIFY_API", "http://localhost:8000/api/v1")
TOKEN_FILE = os.path.expanduser(
    os.environ.get("COOLIFY_TOKEN_FILE", "~/instanz-coolify-token.txt")
)
PROJECT_UUID = os.environ.get("INSTANCE_PROJECT_UUID", "")
SERVER_UUID = os.environ.get("INSTANCE_SERVER_UUID", "")
PRIVATE_KEY_UUID = os.environ.get("INSTANCE_PRIVATE_KEY_UUID", "")
REPO = os.environ.get("INSTANCE_REPO", "")
BRANCH = os.environ.get("INSTANCE_BRANCH", "main")
COMPOSE = os.environ.get("INSTANCE_COMPOSE", "/docker-compose.coolify.yml")
BASE_DOMAIN = os.environ.get("INSTANCE_BASE_DOMAIN", "example.com")
PREFIX = os.environ.get("INSTANCE_PREFIX", "instanz")
ENV_NAME = os.environ.get("INSTANCE_ENV", "production")
DEPLOY_TIMEOUT_S = int(os.environ.get("INSTANCE_DEPLOY_TIMEOUT", "600"))


def token():
    try:
        return open(TOKEN_FILE).read().strip()
    except OSError:
        sys.exit(f"FEHLER: Token-Datei nicht lesbar: {TOKEN_FILE}")


for _name, _wert in (
    ("INSTANCE_PROJECT_UUID", PROJECT_UUID),
    ("INSTANCE_SERVER_UUID", SERVER_UUID),
    ("INSTANCE_PRIVATE_KEY_UUID", PRIVATE_KEY_UUID),
    ("INSTANCE_REPO", REPO),
):
    if not _wert:
        sys.exit(f"FEHLER: {_name} ist nicht gesetzt.")

TOKEN = token()


def api(method, path, body=None):
    url = f"{API}{path}"
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(
        url,
        data=data,
        method=method,
        headers={
            "Authorization": f"Bearer {TOKEN}",
            "Content-Type": "application/json",
            "Accept": "application/json",
        },
    )
    try:
        with urllib.request.urlopen(req) as r:
            raw = r.read().decode()
            if not raw:
                return r.status, {}
            try:
                return r.status, json.loads(raw)
            except json.JSONDecodeError:
                return r.status, {"raw": raw}  # z. B. /version liefert Klartext
    except urllib.error.HTTPError as e:
        raw = e.read().decode()
        try:
            return e.code, json.loads(raw)
        except Exception:
            return e.code, {"raw": raw}
    except urllib.error.URLError as e:
        sys.exit(
            f"FEHLER: Coolify-API nicht erreichbar ({API}): {e}\n"
            f"Läuft der SSH-Tunnel?  ssh -fN -L 8000:localhost:8000 <server>"
        )


def fail(msg, resp=None):
    if resp is not None:
        msg += "\n" + json.dumps(resp, indent=2, ensure_ascii=False)
    sys.exit("FEHLER: " + msg)


def main():
    if len(sys.argv) != 2:
        sys.exit(f"Aufruf: {sys.argv[0]} <slug>   (z. B. phoenixberg)")
    slug = sys.argv[1].strip().lower()
    if not re.fullmatch(r"[a-z0-9]([a-z0-9-]*[a-z0-9])?", slug):
        sys.exit("Ungültiger slug: nur a–z, 0–9 und Bindestrich (nicht am Rand).")
    fqdn = f"{slug}.{BASE_DOMAIN}"

    # Verbindung testen
    st, ver = api("GET", "/version")
    if st != 200:
        fail("Auth/Verbindung fehlgeschlagen.", ver)
    vtxt = ver.get("raw") if isinstance(ver, dict) else ver
    print(f"Coolify erreichbar (v{vtxt}). Provisioniere Tenant: {fqdn}")

    # Doppel-Anlage verhindern (Domain bereits vergeben?)
    st, apps = api("GET", "/applications")
    if st == 200 and isinstance(apps, list):
        for a in apps:
            dom = a.get("docker_compose_domains") or {}
            vals = json.dumps(dom)
            if fqdn in vals:
                fail(f"Es existiert bereits eine App mit der Domain {fqdn}.")

    # Frische Secrets erzeugen und lokal sichern (nicht in die Konsole drucken)
    #
    # SETUP_TOKEN UND METRICS_TOKEN GEHOEREN DAZU ([A.22]). Ohne SETUP_TOKEN
    # laesst der SetupTokenGuard der Instanz JEDEN durch — er gibt ohne
    # gesetztes Geheimnis `true` zurueck. Eine so angelegte Instanz steht damit
    # offen, bis jemand das Erst-Setup abschliesst, und ihre frische Subdomain
    # taucht sekundengenau im Certificate-Transparency-Log auf. Ohne
    # METRICS_TOKEN bleibt der Abruf durch die Verwaltung dauerhaft bei 404.
    #
    # Das CRM setzt beide beim Anlegen ueber die Oberflaeche
    # (apps/control/src/instanz/instanz-aufbau.service.ts); dieses Skript ist
    # der Weg von Hand und muss dasselbe tun.
    #
    # 32 Bytes als Hex ergeben 64 Zeichen — deutlich ueber der Mindestlaenge von
    # 32, die beide Guards verlangen.
    sec = {
        "APP_URL": f"https://{fqdn}",
        "COOKIE_SECURE": "1",
        "NODE_ENV": "production",
        "TRUST_PROXY": "2",
        "POSTGRES_PASSWORD": secrets.token_hex(24),
        "JWT_SECRET": secrets.token_hex(32),
        "SESSION_SECRET": secrets.token_hex(32),
        "CONFIG_KEY": secrets.token_hex(32),
        "SETUP_TOKEN": secrets.token_hex(32),
        "METRICS_TOKEN": secrets.token_hex(32),
    }
    secfile = os.path.expanduser(f"~/instanz-secrets-{slug}.env")
    old_umask = os.umask(0o077)
    with open(secfile, "w") as f:
        f.write(f"# Tenant {fqdn} — erzeugt {datetime.now(timezone.utc).isoformat()}\n")
        for k, v in sec.items():
            f.write(f"{k}={v}\n")
        # Der Einrichtungslink gehoert in DIESE Datei, nicht in die Konsole
        # ([Review B5]): Terminal-Verlauf, tmux- und CI-Logs behalten, was dort
        # steht. Er traegt das SETUP_TOKEN und ist nur einmal brauchbar.
        f.write("# Einrichtungslink (einmalig; nach Abschluss sperrt die Instanz mit 410):\n")
        f.write(f"# https://{fqdn}/api/setup/start?token={sec['SETUP_TOKEN']}\n")
    os.umask(old_umask)
    os.chmod(secfile, 0o600)
    print(f"Secrets gesichert (chmod 600): {secfile}  → in den Passwortmanager übernehmen")
    print("Der Einrichtungslink steht am Ende dieser Datei — nicht hier.")

    # 1) App anlegen (privates Repo per Deploy-Key, Build-Pack Docker Compose)
    st, r = api(
        "POST",
        "/applications/private-deploy-key",
        {
            "project_uuid": PROJECT_UUID,
            "server_uuid": SERVER_UUID,
            "environment_name": ENV_NAME,
            "private_key_uuid": PRIVATE_KEY_UUID,
            "git_repository": REPO,
            "git_branch": BRANCH,
            "build_pack": "dockercompose",
            "docker_compose_location": COMPOSE,
            "name": f"{PREFIX}-{slug}",
            "instant_deploy": False,
        },
    )
    if st not in (200, 201) or "uuid" not in r:
        fail("App-Anlage fehlgeschlagen.", r)
    app_uuid = r["uuid"]
    print(f"App angelegt: {app_uuid}")

    # 2) Umgebungsvariablen setzen: tenant-eigene Secrets + geteilte SMTP-Daten.
    #    SMTP kommt aus ~/instanz-smtp.env (zentraler Versandserver für ALLE
    #    Tenants) und liegt bewusst NICHT im Repo/per-Tenant-Secrets-File.
    smtp = {}
    smtpfile = os.path.expanduser("~/instanz-smtp.env")
    if os.path.exists(smtpfile):
        for line in open(smtpfile):
            line = line.strip()
            if line and not line.startswith("#") and "=" in line:
                k, v = line.split("=", 1)
                if v.strip():
                    smtp[k.strip()] = v.strip()
        print(f"SMTP übernommen aus {smtpfile} ({len(smtp)} Variablen).")
    else:
        print("Hinweis: ~/instanz-smtp.env fehlt — Tenant ohne Mailversand (Mails werden nur geloggt).")
    alle_env = {**sec, **smtp}
    for k, v in alle_env.items():
        st, r = api("POST", f"/applications/{app_uuid}/envs", {"key": k, "value": v, "is_preview": False})
        if st not in (200, 201):
            fail(f"Env {k} setzen fehlgeschlagen.", r)
    print(f"{len(alle_env)} Umgebungsvariablen gesetzt.")

    # 3) Warten, bis Coolify die Compose-Datei geladen hat: raw wird NACH der
    #    Anlage asynchron aus dem Repo geparst und ist Voraussetzung fürs
    #    Setzen der Domain. Dann Domain setzen (ein Deploy genügt danach).
    for _ in range(40):
        st, d = api("GET", f"/applications/{app_uuid}")
        if st == 200 and d.get("docker_compose_raw"):
            break
        time.sleep(3)
    else:
        fail("Compose-Datei wurde nicht rechtzeitig geladen (docker_compose_raw leer).")
    st, r = api(
        "PATCH",
        f"/applications/{app_uuid}",
        {"docker_compose_domains": [{"name": "web", "domain": f"https://{fqdn}"}]},
    )
    if st != 200:
        fail("Domain setzen fehlgeschlagen.", r)
    print(f"Domain gesetzt: https://{fqdn}")

    # 4) Deploy auslösen
    st, r = api("POST", f"/deploy?uuid={app_uuid}&force=false", {})
    try:
        dep_uuid = r["deployments"][0]["deployment_uuid"]
    except Exception:
        fail("Deploy-Start fehlgeschlagen.", r)
    print(f"Deploy gestartet: {dep_uuid} — baue (dauert einige Minuten) …")

    # 5) Deploy verfolgen
    deadline = time.time() + DEPLOY_TIMEOUT_S
    last = None
    final = None
    while time.time() < deadline:
        st, d = api("GET", f"/deployments/{dep_uuid}")
        cur = d.get("status") if st == 200 else None
        if cur != last:
            print(f"  … status={cur}")
            last = cur
        if cur in ("finished", "failed", "error", "cancelled"):
            final = cur
            break
        time.sleep(15)
    if final != "finished":
        fail(
            f"Deploy nicht erfolgreich (status={final}). "
            f"Logs im Coolify-Dashboard unter der App {app_uuid} prüfen."
        )
    print("Deploy erfolgreich.")

    # 6) End-to-End-Kontrolle
    ok = False
    for _ in range(12):  # bis ~60 s auf TLS/Start warten
        try:
            with urllib.request.urlopen(f"https://{fqdn}/api/health", timeout=5) as h:
                if h.status == 200:
                    ok = True
                    break
        except Exception:
            time.sleep(5)
    print("=" * 60)
    if ok:
        print(f"✅ Tenant LIVE:  https://{fqdn}")
        print(f"   Setup-Assistent dort einmalig durchlaufen (Organisation anlegen).")
    else:
        print(f"⚠️  Deploy ok, aber https://{fqdn}/api/health antwortet noch nicht.")
        print(f"   Meist braucht das Let's-Encrypt-Zertifikat kurz — in 1–2 Min erneut testen.")
    print(f"   Secrets: {secfile}")
    print(f"   Coolify-App-UUID: {app_uuid}")


if __name__ == "__main__":
    main()
