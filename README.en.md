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

- **Organisations:** master data, contact persons, notes, history, status lifecycle (inquiry, demo, pilot, paying, review, dormant, ended). A daily schedule (03:00, can be switched off) performs exactly two status changes that have no monetary consequence (pilot to "paying" after 90 days, review seven months after the pilot decision); anything with monetary consequence is only suggested.
- **Inquiry and intake:** a public inquiry endpoint (`POST /api/public/inquiry`, protected by a key) and a token-link intake form for customer details and a direct-debit mandate.
- **Instances:** create through the provisioner (preview, progress, health check), invitation link for first-time setup, reachability check, nightly metrics fetch, nightly reconciliation against Coolify, intake of backup reports (`POST /api/backups`), archiving (stopping).
- **Invoices:** price tiers from the manifest, draft, finalise (immutable afterwards), send by mail, reminder, payment recording, cancellation, number sequence. EN 16931 (CII) XML is produced by the backend; the PDF/A-3 document is produced by a **separate invoice service that is not part of this repository** (see limitations).
- **Mail:** outgoing mail with a queue, split into transactional mail and marketing broadcasts; broadcasts only with consent (double opt-in, block list).
- **"Today" task list:** derived hints (overdue invoices, missing backup, failed metrics fetch, deviation from Coolify, and so on).
- **Operational switches:** feature flags that instances read via `GET /api/flags`.
- **Sign-in:** passkey, or password plus a second factor (e-mail code, authenticator app or passkey), recovery codes, audit and security log, emergency commands inside the container. Roles: `owner` and `administrator`.

## Screenshots

Taken with the fictitious demo data from `pnpm --filter @saas-instant/control seed:demo` (see [CONTRIBUTING.md](CONTRIBUTING.md)). The design is deliberately neutral (Inter, slate grays, one calm blue accent) and follows the system's light or dark color scheme automatically; it can also be switched by hand in the sidebar. The interface text is German in v1.

| | |
|---|---|
| ![Daily overview](docs/screenshots/02-dashboard.png)<br>**Today:** open tasks from invoices and instances | ![Companies](docs/screenshots/03-companies.png)<br>**Companies** with status |
| ![Company](docs/screenshots/04-company-detail.png)<br>**Company:** contact, history, next steps | ![Instances](docs/screenshots/05-instances.png)<br>**Instances** per company |
| ![Invoices](docs/screenshots/06-invoices.png)<br>**Invoices** | ![Invoice](docs/screenshots/07-invoice-detail.png)<br>**Invoice** with PDF/XML, payment, reminder |
| ![Invoices, dark](docs/screenshots/06-invoices-dark.png)<br>**Dark mode** | ![Sign-in](docs/screenshots/01-login.png)<br>**Sign-in** with passkey or password + second factor |
| ![Portal](docs/screenshots/09-portal.png)<br>**Portal** (mode "portal"): list of the managers | ![Portal, dark](docs/screenshots/09-portal-dark.png)<br>**Portal** in dark mode |

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
- **Rule R1, never delete:** the control app knows exactly one database (its own) and has no code path that deletes a deployment or a database. Archiving stops the instance; its data volume stays.
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

- **Test status:** unit, integration (real Postgres) and UI tests are green; the images (manager, web, portal, invoice service) build, and the stack in `single` mode starts through `install.sh` (health check, sign-in page, creating the first account). **Not verified:** `portal` mode with real containers, actually rendering an invoice PDF in the invoice service, mail delivery against a real SMTP server, and operation behind TLS.
- **Coolify only** as provisioner. The interface is prepared, but there is no second provider.
- **The Coolify integration has only been tested against a mock**, not against a real Coolify installation. Paths and sequences were taken from a working provisioning script (`reference/provision-tenant.py`) but are not proven. Expect rework on first real use.
- **Backend messages and mail texts are German only.** The UI goes through an i18n layer ([docs/i18n.md](docs/i18n.md)) but only a German dictionary exists.
- **PDF invoices need the invoice service** (`invoice-renderer`, part of the Compose stack, source in `tools/invoice-renderer`, address `RECHNUNGSDIENST_URL`). If it is not running or the variable is set empty, invoices remain as records and XML, but no PDF can be produced.
- **The mode (`single`/`portal`) cannot be changed after first installation.** A different mode needs a fresh installation in an empty directory.
- **Portal addresses** are written by `install.sh` as `http://<host>:<port>`. For control apps behind TLS you must edit `portal/registry.json` yourself; running `install.sh` or `add` again rewrites the file.
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
| [docs/operations/](docs/operations/) | operations: backup and recovery, emergency access, Coolify setup, billing and SEPA, security model (German) |

Contributing: [CONTRIBUTING.md](CONTRIBUTING.md). Reporting vulnerabilities: [SECURITY.md](SECURITY.md). Origin and third-party licenses: [NOTICE](NOTICE).

## License

GNU Affero General Public License v3.0, see [LICENSE](LICENSE). If you offer a modified version over a network, you must make that version's source code available.
