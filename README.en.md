# saas-instant

Self-hostable back office for SaaS software that runs one instance per customer: customers (organisations), their instances and their invoices in one place.

*Deutsche Fassung: [README.md](README.md)*

## What it is

saas-instant is a web application for the operator of a SaaS product. It records who your customers are, creates a dedicated instance of your software for each of them (currently through Coolify), monitors those instances and issues invoices. The software being managed is not part of this repository. It is attached through a manifest (product name, mail, billing, provisioning) and a narrow instance contract.

The control app itself is not multi-tenant: each control app belongs to exactly one software product and has its own database and its own users.

## Who it is for

Operators who offer their own SaaS software as one instance per customer, use Coolify, and would rather not stitch customer records, instances and billing together from several tools. If you run a shared multi-tenant database or do not use Coolify, v1 will not fit (see limitations).

## Features

Everything listed exists in the code. Whether it works in your setup depends on configuration (Coolify access, outgoing mail, invoice renderer).

- **Organisations:** master data, contact persons, notes, history, status lifecycle (inquiry, trial, paying, exempt, ended). A daily schedule (03:00, can be switched off) performs exactly one status change that has no monetary consequence (trial to "paying" after 14 days, provided a price is set); anything with monetary consequence is only suggested.
- **Inquiry and intake:** a public inquiry endpoint (`POST /api/public/inquiry`, protected by a key) and a token-link intake form for customer details and a direct-debit mandate.
- **Instances:** create through the provisioner (preview, progress, health check), invitation link for first-time setup, reachability check, nightly metrics fetch, nightly reconciliation against Coolify, archiving (stopping). **Backups:** target (S3 or SFTP storage box) in the settings, "back up now", checksum verification, restore into a **new** instance followed by an adoption step (see below and limitations).
- **Invoices:** price tiers (defaults from the manifest, editable as a price list in the settings), draft, finalise (immutable afterwards), send by mail, reminder, payment recording, cancellation, number sequence. **E-invoicing:** EN 16931 (CII) XML is produced by the backend; the PDF/A-3 document (ZUGFeRD/Factur-X, EN 16931 profile) is produced by the `invoice-renderer` service (source in `tools/invoice-renderer`, part of the Compose stack); plus the **XRechnung** as a plain XML file.
- **GoBD building blocks (German tax-audit rules for electronic records):** database triggers block changes to and deletion of finalised invoices and of the audit log; documents are generated once and stored with a SHA-256 checksum; a nightly integrity run with a "document tampered" task; per-invoice history; retention end per invoice (default 8 years); export for tax audits. This is the **technical implementation** only. The process documentation (template in [docs/operations/gobd.md](docs/operations/gobd.md), German) and legal review remain with the operator and their tax adviser.
- **Backup and restore:** a dedicated **backup agent** (container in the Compose stack) backs up instances, the control database and an invoice archive, encrypted (age), to S3 (optionally with Object Lock) or a storage box. Credentials live only in the agent and are write-only in the UI. Details (German): [docs/operations/backup-and-recovery.md](docs/operations/backup-and-recovery.md).
- **Mail:** outgoing mail with a queue, split into transactional mail and marketing broadcasts; broadcasts only with consent (double opt-in, block list).
- **"Today" task list:** derived hints (overdue invoices, missing backup, failed metrics fetch, deviation from Coolify, and so on).
- **Usability:** command palette with ⌘K (Ctrl+K): search companies and start actions such as "New company" or "Create invoice". Forms use a save bar that warns about unsaved changes. Sending an invoice or a payment reminder asks for confirmation. New companies get a guided step list ("Next steps") through contract, first invoice and deputy. On phones, tables turn into card views.
- **Operational switches:** feature flags that instances read via `GET /api/flags`.
- **Sign-in:** passkey, or password plus a second factor (e-mail code, authenticator app or passkey), recovery codes, audit and security log, emergency commands inside the container. Roles: `owner` and `administrator`.
- **Field encryption with a vault:** customer data (organisations, notes, invoice contents and documents, mails, consents, audit details) is stored as ciphertext (AES-256-GCM) in the database, dumps and backups. **Exception:** invoices finalised before the vault was set up, and audit entries from that time, are immutable by database trigger and stay in plaintext (Settings → Security shows the count). After every restart the key is locked in the vault and is unlocked with a passphrase or the recovery key; only then do the UI and nightly jobs run. Details: [docs/operations/security-model.md](docs/operations/security-model.md) (German).
- **Single sign-on in `portal` mode:** accounts, passkeys and second factors live centrally in the portal (sign-in service `portal-auth`, OpenID Connect with PKCE). One sign-in opens every control instance; roles `admin` or `staff` per instance, a fresh second factor (step-up) for sensitive actions, signing out ends all sessions, local emergency access remains. Details: [docs/operations/sso.md](docs/operations/sso.md) (German).

## Screenshots

Taken with the fictitious demo data from `pnpm --filter @saas-instant/control seed:demo` (see [CONTRIBUTING.md](CONTRIBUTING.md)). The design is deliberately neutral (Inter, slate grays, one calm blue accent) and follows the system's light or dark color scheme automatically; it can also be switched by hand in the sidebar. The interface text is German in v1.

| | |
|---|---|
| ![Daily overview](docs/screenshots/02-dashboard.png)<br>**Today:** open tasks from invoices and instances | ![Companies](docs/screenshots/03-companies.png)<br>**Companies** with status |
| ![Company](docs/screenshots/04-company-detail.png)<br>**Company:** contact, history, guided "Next steps" list | ![Instances](docs/screenshots/05-instances.png)<br>**Instances** with version, people and last backup |
| ![Invoices](docs/screenshots/06-invoices.png)<br>**Invoices** | ![Invoice](docs/screenshots/07-invoice-detail.png)<br>**Invoice** with action bar: payment, Download, More ⋯ |
| ![Invoices, dark](docs/screenshots/06-invoices-dark.png)<br>**Dark mode** | ![Sign-in](docs/screenshots/01-login.png)<br>**Sign-in** with passkey or password + second factor |
| ![Portal](docs/screenshots/09-portal.png)<br>**Portal** (mode "portal"): list of the managers | ![Portal, dark](docs/screenshots/09-portal-dark.png)<br>**Portal** in dark mode |
| ![Prices](docs/screenshots/10-settings-prices.png)<br>**Settings → Prices** (left navigation): tiers, tax rate, payment term | ![Backup](docs/screenshots/11-settings-backup.png)<br>**Settings → Backup:** S3 or storage box |
| ![Instance backups](docs/screenshots/12-instance-backups.png)<br>**Instance → Backups** | ![Restore](docs/screenshots/12-instance-backups-restore.png)<br>**Restore as a new instance** |
| ![XRechnung](docs/screenshots/13-invoice-xrechnung.png)<br>**Invoice to an authority:** Download menu with XRechnung, ZUGFeRD, integrity | ![GoBD export](docs/screenshots/14-gobd-export.png)<br>**Export for tax audit** |
| ![Portal sign-in](docs/screenshots/20-portal-login.png)<br>**Portal sign-in** (mode "portal") | ![Control instances](docs/screenshots/21-portal-launcher.png)<br>**Portal:** control instances after sign-in |
| ![Accounts and access](docs/screenshots/22-portal-accounts.png)<br>**Accounts and access:** role per instance | ![Control in portal mode](docs/screenshots/23-control-portal-login.png)<br>**Control** redirects to the portal sign-in |
| ![No access](docs/screenshots/24-control-no-access.png)<br>**No access** without a role for this instance | ![Step-up](docs/screenshots/25-step-up.png)<br>**Step-up:** fresh second factor in the portal |
| ![Vault setup](docs/screenshots/26-vault-setup.png)<br>**Vault setup** with recovery key | ![Unlock](docs/screenshots/27-vault-unlock.png)<br>**Unlock** after a restart |
| ![Security](docs/screenshots/28-settings-security-vault.png)<br>**Settings → Security:** passphrases and log | ![Portal sign-in, dark](docs/screenshots/20-portal-login-dark.png)<br>**Portal sign-in** in dark mode |
| ![Command palette](docs/screenshots/29-command-palette.png)<br>**Command palette** (⌘K): search for "Stein", actions when the input is empty | ![Today on a phone](docs/screenshots/30-mobile-today.png)<br>**Today** on a phone (375 px) |

## Architecture at a glance

```
 Operator ──► control app (one per software)    ┌──────────────┐
              control-web (nginx + UI)          │ Coolify API  │
              control-api (NestJS) ──Provisioner──►            │──► instance, customer A
              control-db  (Postgres)            └──────────────┘──► instance, customer B
                   ▲   │
       manifest ───┘   └── calls each instance: health, setup status, metrics
  (saas-instant.manifest.yaml)                 (instance contract)

 portal mode: additionally a static portal (list + links) in front of several control apps.
```

- **One control app per software.** Each software gets its own control app with its own database and sign-in.
- **Mode fixed at first installation, immutable afterwards:** `single` (exactly one control app) or `portal` (several control apps plus a slim portal that only shows a list and links: no customer data, no sign-in).
- **Provisioner interface:** three operations (create, status, stop); only Coolify in v1.
- **Rule R1, never delete (except 90 days after archiving):** the control app knows exactly one database (its own) and has no code path that deletes a deployment or a database, apart from the automatic deletion of an archived instance 90 days after archiving (everything except invoices, admins are warned by mail beforehand, can be switched off). Archiving stops the instance; its data volume stays until then. A restore always creates a **new** instance; on adoption the old one is stopped, never deleted.
- **Backup agent:** performs backup and restore (the control app only triggers them), HMAC-signed jobs on the internal network, Docker access only through a `docker-socket-proxy` with an allowlist.
- **Manifest:** `saas-instant.manifest.example.yaml` describes the software (name, mail, billing, provisioning, UI).
- **Instance contract:** what a software must provide (three environment variables, one mandatory endpoint, two optional ones).

Details (German): [docs/architecture.md](docs/architecture.md), [docs/manifest.md](docs/manifest.md), [docs/instance-contract.md](docs/instance-contract.md) (has an English summary).

## Requirements

- Docker with Compose v2 (`docker compose`), Docker daemon running
- `openssl` and `bash` (for `install.sh`)
- for instance management: a Coolify installation with an API token, project, server and deploy key, plus a Git repository holding your software's compose definition that satisfies the instance contract
- SMTP access (without it, sign-in codes and instance invitations are not delivered)
- for operation on a network: a TLS-terminating reverse proxy (for example Traefik, Caddy, nginx)

For development additionally Node 22 and pnpm 11 (see `package.json`, `apps/control/Dockerfile`).

## Quick start

```bash
git clone <this repository> saas-instant && cd saas-instant
```

**`single` mode** (one control app, no portal):

```bash
./install.sh --mode single --software my-product
```

**`portal` mode** (several control apps plus portal):

```bash
./install.sh --mode portal --software product-a
bin/saas-instant add product-b        # another control app, portal mode only
```

For each control app `install.sh` creates `installations/<slug>/` (a `.env` with random secrets, permissions 600, plus a copy of the example manifest), writes the mode to `.saas-instant-mode` and starts the containers with `docker compose`. The UI is then at `http://localhost:8080` (further control apps get the next free port; the portal starts at 8090).

Create the first account inside the container; this prints a registration link for a passkey:

```bash
bin/saas-instant emergency my-product first-account admin@example.com "First Last"
```

Then edit `installations/<slug>/saas-instant.manifest.yaml` and restart the control app (the manifest is read only at start-up). `install.sh --dry-run` shows what would happen without writing anything; `--no-start` creates everything but starts no containers.

Step by step, with TLS and proxy notes (German): [docs/installation.md](docs/installation.md).

## Limitations in v1

- **Test status:** unit, integration (real Postgres) and UI tests are green (control: 1617 Jest, 859 Vitest, 575 integration tests; backup agent 57, invoice service 26, sign-in service 10 unit and 45 integration tests, shared auth package 31, shared UI components 47, shared types package 71). The contrast check (`pnpm contrast`) passes with 150 color pairs in light and dark. In addition, five end-to-end suites run against real containers (`bash tests/e2e/run.sh <backup|invoice|install|vault|sso>`, [tests/e2e/README.md](tests/e2e/README.md)): **backup/restore** (MinIO with Object Lock, SFTP as a storage-box stand-in, mock Coolify; 21 steps), **invoice** (invoice service, all legal forms with mandatory-details check, ZUGFeRD PDF/A-3b checked with veraPDF, XRechnung and Factur-X rated acceptable by the KoSIT validator, GoBD export verified with `sha256sum -c`, mail via Mailpit; 40 steps) and **install** (`single`, `portal` with a second control instance, binding/slug mismatch, operation behind TLS with Caddy; 34 steps), **vault** (only ciphertext in tables and dump, locked after restart, wrong passphrase, recovery key, search and GoBD check; 21 steps) and **SSO** (portal with two control instances, roles, step-up, shared sign-out, emergency access with the portal stopped, tampered tokens; 11 steps). A sample of the generated invoice (fictitious data): [PDF](docs/examples/rechnung-zugferd-beispiel.pdf), [XRechnung XML](docs/examples/rechnung-xrechnung-beispiel.xml). **Not verified:** mail delivery through a real provider, operation with a real Coolify or a production storage target, acceptance of the invoices by an authority or a tax-advisor system.
- **The backup agent has only been tested against a small Compose mock and stand-in counterparts**, not against a real Coolify installation or a production storage target. Verification in the control app is a checksum of the encrypted file; whether a backup can be decrypted and restored is shown only by a restore drill with your private key (shown once, stored nowhere). The agent's Docker access remains a residual risk ([docs/operations/security-model.md](docs/operations/security-model.md), German).
- **Vault: whoever loses all passphrases and the recovery key loses the customer data**, including in backups. Encryption protects the database, dumps and backups, not an unlocked running server against root access; mails and the invoice service receive plaintext. Staff accounts stay unencrypted, as do finalised invoices and audit entries from before the vault (immutable, see above); audit entries written while the vault is locked (sign-ins) are plaintext as well. Revoking a passphrase does not protect against a copy of the database that could already be unlocked with it; that would need a change of the data key, which this version does not offer. Search and sorting run in memory and are sized for hundreds to a few thousand organisations.
- **Single sign-on (`portal` mode):** the portal becomes the central sign-in point; if it is down, only per-instance emergency access remains. Not verified: passkeys in a real browser with a real authenticator, running the sign-in service behind TLS. Admin actions in the portal itself do not require step-up, sign-in throttling counts in process memory only, new accounts get no invitation mail (pass on the one-time link by hand).
- **GoBD is not legal advice.** The software provides technical building blocks; whether your overall process complies is for you and your tax adviser to decide. The triggers do not protect against a superuser on the database server; the application's database role should not hold `TRUNCATE` (an operator task, [docs/operations/gobd.md](docs/operations/gobd.md)). The end-to-end suite checks the e-invoice formats with KoSIT and veraPDF (validator configuration: XRechnung 3.0.2); this does not replace validation by the receiving party. UBL as an XRechnung syntax is not part of v1 (CII only).
- **Coolify only** as provisioner. The interface is prepared, but there is no second provider.
- **The Coolify integration has only been tested against a mock**, not against a real Coolify installation. Paths and sequences were taken from a working provisioning script (`reference/provision-tenant.py`) but are not proven. Expect rework on first real use.
- **Backend messages and mail texts are German only.** The UI goes through an i18n layer ([docs/i18n.md](docs/i18n.md)) but only a German dictionary exists.
- **PDF invoices need the invoice service** (`invoice-renderer`, part of the Compose stack, source in `tools/invoice-renderer`, address `RECHNUNGSDIENST_URL`). If it is not running or the variable is set empty, invoices remain as records and XML, but no PDF can be produced.
- **The mode (`single`/`portal`) cannot be changed after first installation.** A different mode needs a fresh installation in an empty directory.
- **Portal addresses** are written by `install.sh` as `http://<host>:<port>`. For control apps behind TLS you must edit `portal/registry/registry.json` yourself; running `install.sh` or `add` again rewrites the file.
- Invoice logic (tax rate, price tiers, legal details) is geared to German conditions; check the output and mandatory details yourself.

## Documentation

| File | Content |
|---|---|
| [docs/installation.md](docs/installation.md) | installation, configuration, TLS and proxy (German) |
| [docs/manifest.md](docs/manifest.md) | all fields of the software manifest (German) |
| [docs/architecture.md](docs/architecture.md) | structure, provisioner, rule R1, modes (German) |
| [docs/instance-contract.md](docs/instance-contract.md) | what a software must provide (German, English summary) |
| [docs/i18n.md](docs/i18n.md) | UI texts |
| [docs/rename-glossary.md](docs/rename-glossary.md) | naming rules (German to English) |
| [docs/operations/](docs/operations/) | operations: backup agent and recovery, GoBD, emergency access, Coolify setup, billing and SEPA, security model and vault, single sign-on (German) |

Contributing: [CONTRIBUTING.md](CONTRIBUTING.md). Reporting vulnerabilities: [SECURITY.md](SECURITY.md). Origin and third-party licenses: [NOTICE](NOTICE).

## License

GNU Affero General Public License v3.0, see [LICENSE](LICENSE). If you offer a modified version over a network, you must make that version's source code available.
