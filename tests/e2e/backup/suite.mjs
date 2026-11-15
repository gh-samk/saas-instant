// SUITE backup: Echttests von Backup-Agent und Restore mit echten Gegenstellen
// (MinIO mit Object Lock, SFTP als Storage-Box-Ersatz, docker-socket-proxy, Agent-Image,
// Mini-Instanzen demo1..demo4, Control-API aus dem Quellcode, Mock-Coolify).
// Aufruf: tests/e2e/run.sh backup   (Artefakte/Logs: ${E2E_OUT}/backup/)
import { createHash, createHmac, randomBytes } from 'node:crypto';
import { createRequire } from 'node:module';
import { writeFileSync, readFileSync, existsSync } from 'node:fs';
import { createConnection } from 'node:net';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createSuite, assert, waitFor, sleep, suiteDir } from '../lib/util.mjs';
import { startControl, ROOT, CONTROL_DIR, SEED } from '../lib/control.mjs';
import { docker, compose, composeDown, run, logs } from '../lib/docker.mjs';
import { startMockCoolify } from './mock-coolify.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const AGENT_DIR = join(ROOT, 'apps', 'backup-agent');
const OUT = suiteDir('backup');
const AGENT_PORT = 18787;
const CONTROL_PORT = 13001;
const MOCK_PORT = 13091; // bewusst weit weg von den Ports der anderen Suiten (13001..13003)
const MINIO_PORT = 19000;
const SFTP_PORT = 12222;
const DB_NAME = 'e2e_backup_control'; // lib verlangt das Präfix e2e_ (siehe lib/control.mjs: safeName)

const AGENT_PROJECT = 'si-e2e-backup';
const DEMOS = ['demo1', 'demo2', 'demo3', 'demo4'];
const demoProject = (n) => `si-e2e-${n}`;
const AGENT_CONTAINER = `${AGENT_PROJECT}-backup-agent-1`;
const PROXY_CONTAINER = `${AGENT_PROJECT}-docker-socket-proxy-1`;
const hex = (n) => randomBytes(n).toString('hex');

// Zufällige Zugangsdaten je Lauf, nur im Speicher und in der Prozessumgebung; nie im Repo.
const SECRETS = {
  agentSecret: hex(32),
  agentStateKey: hex(32),
  reportKey: hex(32),
  minioUser: `AKE2E${hex(6).toUpperCase()}`,
  minioPassword: hex(20),
  sftpPassword: hex(12),
  demoDbPassword: hex(10),
};
const SFTP_USER = 'e2esftp'; // Benutzername ist kein Geheimnis (steht in den Metadaten)
const BUCKET = 'si-e2e-backup';
const PREFIX = 'e2e';
const CONTROL_DB_URL = `postgresql://${process.env.E2E_DB_USER || 'postgres'}:${process.env.E2E_DB_PASSWORD || 'demo'}@host.docker.internal:${process.env.E2E_DB_PORT || '54329'}/${DB_NAME}`;

const composeEnv = {
  ...process.env,
  E2E_MINIO_USER: SECRETS.minioUser,
  E2E_MINIO_PASSWORD: SECRETS.minioPassword,
  E2E_SFTP_USER: SFTP_USER,
  E2E_SFTP_PASSWORD: SECRETS.sftpPassword,
  E2E_AGENT_SECRET: SECRETS.agentSecret,
  E2E_AGENT_STATE_KEY: SECRETS.agentStateKey,
  E2E_REPORT_KEY: SECRETS.reportKey,
  E2E_CONTROL_DATABASE_URL: CONTROL_DB_URL,
  E2E_DEMO_DB_PASSWORD: SECRETS.demoDbPassword,
};
const AGENT_COMPOSE = [join(HERE, 'docker-compose.yml')];
const DEMO_COMPOSE = [join(HERE, 'demo.compose.yml')];

// ----------------------------------------------------------------- Helfer

const agentReq = createRequire(join(AGENT_DIR, 'package.json'));
const controlReq = createRequire(join(CONTROL_DIR, 'package.json'));
const { S3Client, ListObjectsV2Command, GetObjectCommand, GetObjectRetentionCommand, ListObjectVersionsCommand, DeleteObjectCommand } =
  agentReq('@aws-sdk/client-s3');
const s3 = new S3Client({
  endpoint: `http://127.0.0.1:${MINIO_PORT}`,
  region: 'us-east-1',
  forcePathStyle: true,
  credentials: { accessKeyId: SECRETS.minioUser, secretAccessKey: SECRETS.minioPassword },
});
const bodyBuffer = async (r) => Buffer.from(await r.Body.transformToByteArray());
const s3Get = async (key) => bodyBuffer(await s3.send(new GetObjectCommand({ Bucket: BUCKET, Key: key })));
const s3List = async (prefix) =>
  (await s3.send(new ListObjectsV2Command({ Bucket: BUCKET, Prefix: prefix }))).Contents?.map((o) => o.Key) ?? [];

const sha256 = (b) => createHash('sha256').update(b).digest('hex');

/** Signierte Anfrage an den Agent (Schema siehe apps/backup-agent/src/hmac.ts). */
async function agentCall(method, pathWithQuery, payload, { secret = SECRETS.agentSecret, ts = String(Date.now()), nonce = hex(16), unsigned = false } = {}) {
  const body = payload === undefined ? '' : JSON.stringify(payload);
  const headers = { 'content-type': 'application/json' };
  if (!unsigned) {
    const canonical = [method.toUpperCase(), pathWithQuery, ts, nonce, sha256(body)].join('\n');
    headers['x-si-timestamp'] = ts;
    headers['x-si-nonce'] = nonce;
    headers['x-si-signature'] = createHmac('sha256', secret).update(canonical).digest('hex');
  }
  const res = await fetch(`http://127.0.0.1:${AGENT_PORT}${pathWithQuery}`, { method, headers, body: body === '' ? undefined : body });
  const text = await res.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch { json = text; }
  return { status: res.status, body: json };
}
async function agentJob(jobId, timeoutMs = 180_000) {
  return waitFor(async () => {
    const r = await agentCall('GET', `/v1/jobs/${jobId}`);
    return r.status === 200 && ['succeeded', 'failed'].includes(r.body.status) ? r.body : null;
  }, { timeoutMs, intervalMs: 700, label: `Agent-Job ${jobId}` });
}

async function waitTcpBanner(port, banner, timeoutMs = 60_000) {
  await waitFor(() => new Promise((resolve) => {
    const sock = createConnection({ host: '127.0.0.1', port });
    let data = '';
    const done = (v) => { sock.destroy(); resolve(v); };
    sock.setTimeout(3000, () => done(false));
    sock.on('data', (d) => { data += d; if (data.includes(banner)) done(true); });
    sock.on('error', () => done(false));
    sock.on('close', () => done(false)); // Docker nimmt die Verbindung kurz nach dem Start an und schließt sie sofort
  }), { timeoutMs, intervalMs: 700, label: `Port ${port} (${banner})` });
}

async function demoUp(n) {
  const project = demoProject(n);
  await compose(project, DEMO_COMPOSE, ['up', '-d', '--wait'], { env: composeEnv, timeoutMs: 240_000 });
  return project;
}
const dbExec = (project, sql, allowFail = false) =>
  docker(['exec', `${project}-db-1`, 'psql', '-U', 'app', '-d', 'app', '-tAc', sql], { allowFail });

/** Zeilenzahl + Prüfsumme der Tabelle items und Prüfsumme der Upload-Dateien (oder null, wenn leer/keine Tabelle). */
async function fingerprint(n) {
  const project = demoProject(n);
  const db = await dbExec(project, `select count(*)||'|'||md5(string_agg(payload, ',' order by id)) from items`, true);
  const rows = db.code === 0 ? db.stdout.trim() : null;
  const up = await docker(['exec', `${project}-app-1`, 'sh', '-c', 'cd /uploads && find . -type f | sort | xargs -r sha256sum | sha256sum | cut -d" " -f1'], { allowFail: true });
  const uploads = up.code === 0 ? up.stdout.trim() : null;
  const files = await docker(['exec', `${project}-app-1`, 'sh', '-c', 'find /uploads -type f | wc -l'], { allowFail: true });
  return { rows, uploads, files: Number(files.stdout.trim() || 0) };
}
const isRunning = async (container) =>
  (await docker(['inspect', '-f', '{{.State.Running}}', container], { allowFail: true })).stdout.trim() === 'true';

function scanForSecrets(label, text, secrets) {
  for (const [name, value] of Object.entries(secrets)) {
    if (!value || value.length < 6) continue;
    assert(!text.includes(value), `Geheimnis "${name}" taucht in ${label} auf`);
  }
  assert(!/AGE-SECRET-KEY-1[A-Z0-9]{20,}/.test(text), `age-Identität taucht in ${label} auf`);
}

const BACKUP_YEAR_DATE = new Date();
const isoDay = (d) => d.toISOString().slice(0, 10);

// ------------------------------------------------------------------ Lauf

const s = createSuite('backup', { stepTimeoutMs: 240_000 });
let mock;
let ctl;
let c; // eingeloggter Client
let prisma;
const ctx = {}; // Zustand zwischen den Schritten

const evidence = () => ({ currentPassword: SEED.password });

async function waitRestore(instanceId, restoreId, { want = ['ready', 'failed'], timeoutMs = 240_000 } = {}) {
  const seen = [];
  const row = await waitFor(async () => {
    const r = await c.api('GET', `/api/instances/${instanceId}/restores`);
    const mine = r.body?.find?.((x) => x.id === restoreId);
    if (mine && seen[seen.length - 1] !== mine.status) seen.push(mine.status);
    return mine && want.includes(mine.status) ? mine : null;
  }, { timeoutMs, intervalMs: 250, label: `Wiederherstellung ${restoreId}` });
  return { row, seen };
}

try {
  // Aufräumen eines früheren, abgebrochenen Laufs (nur eigene Projekte).
  for (const p of [AGENT_PROJECT, ...DEMOS.map(demoProject)]) {
    await composeDown(p, p === AGENT_PROJECT ? AGENT_COMPOSE : DEMO_COMPOSE, { env: composeEnv }).catch(() => {});
  }

  await s.step('setup: Mock-Coolify und Control-API starten', async () => {
    mock = await startMockCoolify({
      port: MOCK_PORT,
      seed: [{ uuid: 'mock-demo1-uuid', name: 'instance-demo1', status: 'running', domains: ['demo1.e2e.example.com'] }],
    });
    const manifestPath = join(OUT, 'manifest.yaml');
    writeFileSync(manifestPath, [
      'billing:',
      '  issuer:',
      '    legalForm: sole_proprietor',
      '    name: E2E Testbetrieb',
      '    address: Teststrasse 1, 12345 Teststadt',
      '    street: Teststrasse 1',
      '    postalCode: "12345"',
      '    city: Teststadt',
      '    country: DE',
      '    taxId: DE811569869',
      '    email: rechnung@e2e-test.invalid',
      '    phone: "+49 30 1234567"',
      '    contactName: Erika Test',
      '    iban: DE89370400440532013000',
      '    bic: COBADEFFXXX',
      '    bankName: Testbank',
      '    bankDetails: Testbank IBAN DE89 3704 0044 0532 0130 00 BIC COBADEFFXXX',
      'provisioning:',
      '  instanceDomainBase: e2e.example.com',
      '  subdomainPattern: "{slug}.{base}"',
      '  composeSource: https://git.example.invalid/e2e/instance-compose.git',
      '  instancePrefix: instance',
      '  backup:',
      '    dbServiceName: db',
      '    dbName: app',
      '    dbUser: app',
      '    uploadsService: app',
      '    uploadsPath: /uploads',
      '    composeProjectPattern: "si-e2e-{subdomain}"',
      '',
    ].join('\n'));
    const preload = join(HERE, 'preload-fetch.cjs');
    ctl = await startControl({
      port: CONTROL_PORT,
      dbName: DB_NAME,
      suite: 'backup',
      env: {
        MANIFEST_PATH: manifestPath,
        BACKUP_AGENT_URL: `http://127.0.0.1:${AGENT_PORT}`,
        BACKUP_AGENT_SECRET: SECRETS.agentSecret,
        BACKUP_REPORT_KEY: SECRETS.reportKey,
        CONTROL_BACKUP_KEY: SECRETS.reportKey,
        RECHNUNGSDIENST_URL: '',
        CONTROL_COOLIFY_TOKEN: `mock-${hex(8)}`,
        CONTROL_COOLIFY_API_URL: `${mock.url}/api/v1`,
        CONTROL_COOLIFY_PROJECT_UUID: 'mock-project',
        CONTROL_COOLIFY_SERVER_UUID: 'mock-server',
        CONTROL_COOLIFY_DEPLOY_KEY_UUID: 'mock-key',
        CONTROL_COOLIFY_REPO: 'git@git.example.invalid:e2e/instance-compose.git',
        CONTROL_INSTANCE_SMTP_HOST: 'smtp.e2e-test.invalid',
        CONTROL_INSTANCE_SMTP_FROM: 'noreply@e2e-test.invalid',
        E2E_MOCK_COOLIFY_URL: mock.url,
        NODE_OPTIONS: `${process.env.NODE_OPTIONS ?? ''} --require=${preload}`.trim(),
      },
    });
    c = await ctl.login();
    const { PrismaClient } = controlReq('.prisma/control-client');
    prisma = new PrismaClient({ datasources: { db: { url: ctl.env.DATABASE_URL } } });
  }, { timeoutMs: 600_000 });

  await s.step('setup: Agent-Stack (MinIO, SFTP, Docker-Proxy, Agent) startet', async () => {
    await run('pnpm', ['exec', 'tsc', '-p', 'tsconfig.build.json'], { cwd: AGENT_DIR, timeoutMs: 300_000 }); // dist für Host-Helfer
    await compose(AGENT_PROJECT, AGENT_COMPOSE, ['up', '-d', '--build', '--wait'], { env: composeEnv, timeoutMs: 900_000 });
    await waitFor(async () => (await fetch(`http://127.0.0.1:${MINIO_PORT}/minio/health/live`)).ok, { timeoutMs: 60_000, label: 'MinIO live' });
    await waitTcpBanner(SFTP_PORT, 'SSH-2.0');
  }, { timeoutMs: 1_000_000 });

  await s.step('setup: Bucket mit Object Lock (mc mb --with-lock)', async () => {
    await docker([
      'run', '--rm', '--label', 'e2e=true', '--label', 'e2e.suite=backup', '--network', `${AGENT_PROJECT}_default`,
      '-e', 'MC_U', '-e', 'MC_P', '--entrypoint', '/bin/sh', 'minio/mc:latest',
      '-c', `mc alias set local http://minio:9000 "$MC_U" "$MC_P" >/dev/null && mc mb --with-lock local/${BUCKET}`,
    ], { env: { ...process.env, MC_U: SECRETS.minioUser, MC_P: SECRETS.minioPassword }, timeoutMs: 120_000 });
  });

  await s.step('setup: Demo-Instanzen demo1..demo4 starten, demo1 befüllt (250 Zeilen + Upload)', async () => {
    for (const n of DEMOS) await demoUp(n);
    const p = demoProject('demo1');
    await dbExec(p, 'create table items(id serial primary key, payload text not null)');
    await dbExec(p, `insert into items(payload) select md5(g::text)||'-'||g from generate_series(1,250) g`);
    await docker(['exec', `${p}-app-1`, 'sh', '-c', 'mkdir -p /uploads/sub && head -c 30000 /dev/urandom > /uploads/sub/blob.bin && echo "Hallo Upload" > /uploads/hallo.txt']);
    ctx.fp1 = await fingerprint('demo1');
    assert(ctx.fp1.rows?.startsWith('250|'), `demo1: ${ctx.fp1.rows}`);
    assert(ctx.fp1.files === 2, 'demo1: zwei Upload-Dateien erwartet');
    for (const n of ['demo2', 'demo3', 'demo4']) {
      const f = await fingerprint(n);
      assert(f.rows === null && f.files === 0, `${n} sollte leer sein`);
    }
  });

  // ---------------------------------------------------------------- (1)
  await s.step('1 Agent-Health (signiert) und ungeschützter Zugriff abgelehnt', async () => {
    const h = await waitFor(async () => {
      const r = await agentCall('GET', '/v1/health').catch(() => null);
      return r?.status === 200 ? r : null;
    }, { timeoutMs: 60_000, label: 'Agent-Health' });
    assert(h.body.status === 'ok', JSON.stringify(h.body));
    assert(h.body.targetConfigured === false, 'Agent sollte noch ohne Ziel sein');
    const raw = await agentCall('GET', '/v1/health', undefined, { unsigned: true });
    assert(raw.status === 401, `ohne Signatur erwartet 401, war ${raw.status}`);
    const st = await docker(['inspect', '-f', '{{.State.Health.Status}}', AGENT_CONTAINER]);
    assert(st.stdout.trim() === 'healthy', `Container-Health: ${st.stdout}`);
  });

  // ---------------------------------------------------------------- (2)
  const s3Body = (extra = {}) => ({
    type: 's3', schedule: 'daily', retentionDays: 30, objectLock: true,
    s3: { endpoint: 'http://minio:9000', region: 'us-east-1', bucket: BUCKET, prefix: PREFIX, pathStyle: true, ...extra },
  });
  await s.step('2 Ziel S3 einrichten: age-Identität genau einmal, GET/Logs ohne Geheimnisse', async () => {
    const put = await c.api('PUT', '/api/settings/backup', {
      ...(await c.proof()), // erster zweiter Faktor per TOTP; danach Passwort
      ...s3Body({ accessKeyId: SECRETS.minioUser, secretAccessKey: SECRETS.minioPassword }),
    });
    assert(put.status === 200, `PUT HTTP ${put.status} ${JSON.stringify(put.body).slice(0, 300)}`);
    assert(/no-store/i.test(put.headers.get('cache-control') ?? ''), 'PUT-Antwort sollte Cache-Control: no-store tragen');
    ctx.ageIdentity = put.body.ageIdentity;
    assert(/^AGE-SECRET-KEY-1[A-Z0-9]+$/.test(ctx.ageIdentity ?? ''), 'ageIdentity fehlt in der Antwort auf das Einrichten');
    ctx.ageRecipient = put.body.agent?.ageRecipient;
    assert(/^age1/.test(ctx.ageRecipient ?? ''), 'ageRecipient fehlt');
    assert(put.body.target?.type === 's3' && put.body.target.bucket === BUCKET, 'Metadaten fehlen');
    const putText = JSON.stringify(put.body);
    assert(!putText.includes(SECRETS.minioPassword) && !putText.includes(SECRETS.minioUser), 'Zugangsdaten in der PUT-Antwort');
    assert(putText.split(ctx.ageIdentity).length === 2, 'Identität nicht genau einmal in der Antwort');

    const get = await c.api('GET', '/api/settings/backup');
    assert(get.status === 200, `GET HTTP ${get.status}`);
    assert(get.body.ageIdentity === undefined, 'GET liefert eine age-Identität');
    assert(get.body.agent?.targetConfigured === true && get.body.agent?.objectLock === true, 'Agentzustand unstimmig');
    const getText = JSON.stringify(get.body);
    scanForSecrets('GET /api/settings/backup', getText, { ...SECRETS, ageIdentity: ctx.ageIdentity });
    // Zweites Einrichten (anderer Zeitplan, Geheimnisse weggelassen) liefert die Identität NICHT erneut.
    const again = await c.api('PUT', '/api/settings/backup', { ...evidence(), ...s3Body(), schedule: 'twice_daily' });
    assert(again.status === 200, `PUT (ohne Geheimnisse) HTTP ${again.status} ${JSON.stringify(again.body).slice(0, 200)}`);
    assert(again.body.ageIdentity === undefined, 'Identität wurde erneut geliefert');
    const back = await c.api('PUT', '/api/settings/backup', { ...evidence(), ...s3Body() });
    assert(back.status === 200 && back.body.target?.schedule === 'daily', 'Zeitplan zurückstellen');

    // Logs: Control-Log, Agent- und Proxy-Container, Mock.
    const secrets = { ...SECRETS, ageIdentity: ctx.ageIdentity };
    scanForSecrets('Control-Log', readFileSync(join(OUT, `control-${CONTROL_PORT}.log`), 'utf8'), secrets);
    scanForSecrets('Agent-Log', await logs(AGENT_CONTAINER, 5000), secrets);
    scanForSecrets('Proxy-Log', await logs(PROXY_CONTAINER, 5000), secrets);
    scanForSecrets('Mock-Aufrufe', JSON.stringify(mock.calls), secrets);
  });

  // ---------------------------------------------------------------- (3)
  await s.step('3 Verbindung testen (Schreiben, Lesen, Löschen eines Testobjekts)', async () => {
    const t = await c.api('POST', '/api/settings/backup/test', evidence());
    assert(t.status === 200 && t.body.ok === true, `Test: HTTP ${t.status} ${JSON.stringify(t.body).slice(0, 300)}`);
    const get = await c.api('GET', '/api/settings/backup');
    assert(get.body.target?.lastTestOk === true, 'lastTestOk nicht gesetzt');
    // Falsche Zugangsdaten werden erkannt (ohne den gespeicherten Stand zu zerstören): erst am Ende von Schritt 10 relevant.
  });

  // ---------------------------------------------------------------- (4)
  await s.step('4 Instanz demo1 anlegen, "Jetzt sichern" -> Job succeeded -> Liste -> verschlüsselt in MinIO', async () => {
    const { CryptoService } = controlReq('./dist/crypto/crypto.service.js');
    const crypto = new CryptoService({ get: (k) => ctl.env[k] });
    const company = await prisma.company.create({
      data: {
        name: 'E2E Demo GmbH', status: 'paying', street: 'Musterweg', houseNumber: '7', postalCode: '10115',
        city: 'Berlin', country: 'Deutschland', billingEmail: 'buchhaltung@e2e-test.invalid',
        contactName: 'Max Muster', contactEmail: 'max@e2e-test.invalid',
      },
    });
    const instance = await prisma.instance.create({
      data: {
        companyId: company.id, subdomain: 'demo1', coolifyApplicationId: 'mock-demo1-uuid', status: 'active',
        metricsTokenEncrypted: crypto.encrypt(hex(16)), setupTokenEncrypted: crypto.encrypt(hex(16)),
      },
    });
    ctx.companyId = company.id;
    ctx.instanceId = instance.id;

    const plan = await fetch(`${ctl.url}/api/internal/backup-plan`, { headers: { 'x-backup-key': SECRETS.reportKey } });
    const planBody = await plan.json();
    assert(plan.status === 200 && planBody.instances?.[0]?.composeProject === 'si-e2e-demo1', `Plan: ${JSON.stringify(planBody).slice(0, 300)}`);

    const trig = await c.api('POST', `/api/instances/${ctx.instanceId}/backups`, evidence());
    assert(trig.status === 202 && trig.body.jobId, `Trigger: HTTP ${trig.status} ${JSON.stringify(trig.body).slice(0, 300)}`);
    const job = await waitFor(async () => {
      const r = await c.api('GET', `/api/instances/${ctx.instanceId}/backups/jobs/${trig.body.jobId}`);
      return r.status === 200 && ['succeeded', 'failed'].includes(r.body.status) ? r.body : null;
    }, { timeoutMs: 180_000, intervalMs: 700, label: 'Backup-Job' });
    assert(job.status === 'succeeded', `Backup-Job: ${job.status} ${job.message}`);

    const list = await c.api('GET', `/api/instances/${ctx.instanceId}/backups?includeAgent=true`);
    assert(list.status === 200 && list.body.backups.length === 1, `Liste: ${JSON.stringify(list.body).slice(0, 300)}`);
    const b = list.body.backups[0];
    assert(b.restorable && b.sizeBytes > 0 && b.objectKey && /^[0-9a-f]{64}$/.test(b.sha256 ?? ''), `Zeile unvollständig: ${JSON.stringify(b)}`);
    assert(list.body.agent?.available && list.body.agent.items.some((i) => i.objectKey === b.objectKey), 'Agent-Liste enthält die Sicherung nicht');
    ctx.backup = b;

    const dump = await s3Get(b.objectKey);
    assert(dump.subarray(0, 21).toString('latin1') === 'age-encryption.org/v1', 'kein age-Header am Dump-Objekt');
    assert(dump.indexOf('PGDMP') === -1 && dump.indexOf('CREATE TABLE') === -1, 'Klartext-Merkmale im Dump-Objekt');
    assert(sha256(dump) === b.sha256, 'sha256 der Liste passt nicht zum Objekt');
    const uploadsKey = b.objectKey.replace(/\.dump\.age$/, '.uploads.tar.age');
    const up = await s3Get(uploadsKey);
    assert(up.subarray(0, 21).toString('latin1') === 'age-encryption.org/v1' && !(up[0] === 0x1f && up[1] === 0x8b), 'Upload-Archiv nicht verschlüsselt');
    assert((await s3List(b.objectKey.replace(/\.dump\.age$/, '.meta.json'))).length === 1, 'Meta-Datei fehlt');
  });

  // ---------------------------------------------------------------- (5)
  await s.step('5 backup-control + Rechnungsarchiv invoices/<Jahr>/: Object-Lock-Retention, Löschversuch scheitert', async () => {
    const day = isoDay(BACKUP_YEAR_DATE);
    const draft = await c.api('POST', `/api/companies/${ctx.companyId}/invoices`, {
      invoiceDate: day, servicePeriodFrom: day, servicePeriodUntil: day,
      lines: [{ label: 'E2E Leistung', quantity: 1, unitPriceNetCent: 4900, taxRate: 19 }],
    });
    assert(draft.status === 201, `Entwurf: HTTP ${draft.status} ${JSON.stringify(draft.body).slice(0, 400)}`);
    const fin = await c.api('POST', `/api/invoices/${draft.body.id}/finalize`, { confirmation: 'festschreiben', ...evidence() });
    assert(fin.status === 200 && fin.body.invoiceNumber, `Festschreiben: HTTP ${fin.status} ${JSON.stringify(fin.body).slice(0, 400)}`);
    ctx.invoiceNumber = fin.body.invoiceNumber;
    // XML erzeugen lassen (wird einmal erzeugt und in der Datenbank abgelegt; der Agent archiviert pdf/xml/xrechnung, soweit vorhanden).
    const xml = await c.api('GET', `/api/invoices/${draft.body.id}/xml`, undefined, { raw: true });
    assert(xml.status === 200 && xml.body.length > 200, `XML: HTTP ${xml.status}`);
    ctx.invoiceXmlSha = sha256(xml.body);

    const sub = await agentCall('POST', '/v1/jobs', { kind: 'backup-control' });
    assert(sub.status === 202, `backup-control: HTTP ${sub.status} ${JSON.stringify(sub.body)}`);
    const job = await agentJob(sub.body.jobId);
    assert(job.status === 'succeeded', `backup-control: ${job.status} ${job.message}`);

    const year = day.slice(0, 4);
    const keys = await s3List(`${PREFIX}/invoices/${year}/`);
    const tar = keys.find((k) => k.endsWith('.tar.age'));
    assert(tar, `kein Rechnungsarchiv in invoices/${year}/ (${keys.join(', ')})`);
    ctx.invoiceKey = tar;
    const head = await s3Get(tar);
    assert(head.subarray(0, 21).toString('latin1') === 'age-encryption.org/v1', 'Rechnungsarchiv nicht verschlüsselt');
    for (const key of [tar, tar.replace(/\.tar\.age$/, '.meta.json')]) {
      const ret = await s3.send(new GetObjectRetentionCommand({ Bucket: BUCKET, Key: key }));
      assert(ret.Retention?.Mode === 'GOVERNANCE', `${key}: Modus ${ret.Retention?.Mode}`);
      const years = (new Date(ret.Retention.RetainUntilDate) - Date.now()) / (365.25 * 86_400_000);
      assert(years > 1, `${key}: Frist zu kurz (${years.toFixed(2)} Jahre)`);
    }
    // Kontrollsicherung der Verwaltungs-DB liegt auch da.
    assert((await s3List(`${PREFIX}/control/`)).some((k) => k.endsWith('.dump.age')), 'Kontroll-Dump fehlt');

    // Löschversuch 1: über den Storage des Agents (Löschschutz für invoices/*).
    const { defaultStorageFactory } = await import(pathToFileURL(join(AGENT_DIR, 'dist', 'storage', 'index.js')).href);
    const storage = defaultStorageFactory({
      type: 's3', schedule: 'daily', retentionDays: 30, objectLock: true,
      s3: { endpoint: `http://127.0.0.1:${MINIO_PORT}`, region: 'us-east-1', bucket: BUCKET, prefix: PREFIX, pathStyle: true, accessKeyId: SECRETS.minioUser, secretAccessKey: SECRETS.minioPassword },
    });
    const refused = await storage.delete(tar).then(() => null, (e) => e);
    assert(refused && /Rechnungsarchiv/i.test(refused.message), `Agent-Storage hat das Löschen nicht verweigert: ${refused?.message}`);
    // Löschversuch 2: direkt gegen S3 mit Versions-ID (Object Lock muss ablehnen).
    const versions = await s3.send(new ListObjectVersionsCommand({ Bucket: BUCKET, Prefix: tar }));
    const v = versions.Versions?.find((x) => x.Key === tar);
    assert(v?.VersionId, 'keine Versions-ID');
    const denied = await s3.send(new DeleteObjectCommand({ Bucket: BUCKET, Key: tar, VersionId: v.VersionId })).then(() => null, (e) => e);
    assert(denied && /AccessDenied|locked|WORM|retention/i.test(`${denied.name} ${denied.message} ${denied.Code}`), `S3 hat das Löschen nicht verweigert: ${denied?.name} ${denied?.message}`);
    assert((await s3List(tar)).length === 1, 'Archiv ist nach den Löschversuchen weg');
  });

  // ---------------------------------------------------------------- (6)
  await s.step('6 verify-Job (Prüfsumme gegen Meta-Datei) -> Sicherung als geprüft vermerkt', async () => {
    const v = await c.api('POST', `/api/instances/${ctx.instanceId}/backups/${ctx.backup.id}/verify`, evidence());
    assert(v.status === 202 && v.body.jobId, `verify: HTTP ${v.status} ${JSON.stringify(v.body).slice(0, 200)}`);
    const job = await waitFor(async () => {
      const r = await c.api('GET', `/api/instances/${ctx.instanceId}/backups/jobs/${v.body.jobId}?backupId=${ctx.backup.id}`);
      return r.status === 200 && ['succeeded', 'failed'].includes(r.body.status) ? r.body : null;
    }, { timeoutMs: 120_000, intervalMs: 700, label: 'verify-Job' });
    assert(job.status === 'succeeded', `verify: ${job.status} ${job.message}`);
    const list = await c.api('GET', `/api/instances/${ctx.instanceId}/backups`);
    assert(list.body.backups[0].verified === true, 'verifiedAt nicht gesetzt');
  });

  // ---------------------------------------------------------------- (7)
  await s.step('7 Restore in demo2 über die Control-API: provisioning->restoring->ready, Daten gleich', async () => {
    const before1 = await fingerprint('demo1');
    const wrongName = await c.api('POST', `/api/instances/${ctx.instanceId}/restores`, {
      ...evidence(), backupId: ctx.backup.id, newSubdomain: 'demo2', ageIdentity: ctx.ageIdentity, confirmName: 'falscher-name',
    });
    assert(wrongName.status === 400 && /restore_confirmation_mismatch/.test(JSON.stringify(wrongName.body)), `falscher confirmName: HTTP ${wrongName.status} ${JSON.stringify(wrongName.body).slice(0, 200)}`);
    const start = await c.api('POST', `/api/instances/${ctx.instanceId}/restores`, {
      ...evidence(), backupId: ctx.backup.id, newSubdomain: 'demo2', ageIdentity: ctx.ageIdentity, confirmName: 'demo1',
    });
    assert(start.status === 202 && start.body.status === 'provisioning', `Start: HTTP ${start.status} ${JSON.stringify(start.body).slice(0, 300)}`);
    assert(!JSON.stringify(start.body).includes(ctx.ageIdentity), 'Identität in der Restore-Antwort');
    ctx.restoreId = start.body.id;
    const { row, seen } = await waitRestore(ctx.instanceId, ctx.restoreId);
    assert(row.status === 'ready', `Restore: ${row.status} ${row.message}`);
    assert(seen.includes('restoring'), `Zwischenstand "restoring" nicht gesehen (${seen.join('>')})`);
    ctx.restoreSeen = ['provisioning', ...seen.filter((x) => x !== 'provisioning')];
    const fp2 = await fingerprint('demo2');
    assert(fp2.rows === ctx.fp1.rows, `Zeilen/Prüfsumme demo2 ${fp2.rows} != demo1 ${ctx.fp1.rows}`);
    assert(fp2.uploads === ctx.fp1.uploads && fp2.files === 2, `Uploads demo2 weichen ab (${fp2.files} Dateien)`);
    const after1 = await fingerprint('demo1');
    assert(JSON.stringify(after1) === JSON.stringify(before1) && JSON.stringify(after1) === JSON.stringify(ctx.fp1), 'demo1 wurde verändert');
    assert(await isRunning(`${demoProject('demo1')}-app-1`) && await isRunning(`${demoProject('demo2')}-app-1`), 'app-Container läuft nicht');
    // Die alte Instanz ist bis hierher unberührt: kein Stopp bei Coolify.
    assert(!mock.calls.some((x) => x.path.endsWith('/stop')), 'vor der Übernahme wurde bereits gestoppt');
  });

  // ---------------------------------------------------------------- (8)
  await s.step('8 Übernahme (adopt): alte Instanz gestoppt, KEIN DELETE, Instanz-Zeile zeigt demo2 + neue Coolify-Id', async () => {
    const restoreRow = await prisma.instanceRestore.findUnique({ where: { id: ctx.restoreId } });
    assert(restoreRow?.coolifyApplicationId, 'Restore-Zeile ohne Coolify-Id');
    const adopt = await c.api('POST', `/api/instances/${ctx.instanceId}/restores/${ctx.restoreId}/adopt`, evidence());
    assert(adopt.status === 200 && adopt.body.status === 'adopted', `adopt: HTTP ${adopt.status} ${JSON.stringify(adopt.body).slice(0, 300)}`);
    const stops = mock.calls.filter((x) => x.method === 'POST' && x.path.endsWith('/stop'));
    assert(stops.length === 1 && stops[0].path === '/applications/mock-demo1-uuid/stop', `Stopp-Aufrufe: ${JSON.stringify(stops)}`);
    assert(mock.apps.get('mock-demo1-uuid').status === 'exited', 'alte Anwendung nicht gestoppt');
    const deletes = mock.calls.filter((x) => x.method === 'DELETE' || x.forbiddenDelete);
    assert(deletes.length === 0, `DELETE gegen Coolify: ${JSON.stringify(deletes)}`);
    const inst = await prisma.instance.findUnique({ where: { id: ctx.instanceId } });
    assert(inst.subdomain === 'demo2', `Subdomain ${inst.subdomain}`);
    assert(inst.coolifyApplicationId === restoreRow.coolifyApplicationId && inst.coolifyApplicationId !== 'mock-demo1-uuid', 'Coolify-Id nicht umgestellt');
    assert(inst.status === 'active', `Status ${inst.status}`);
    assert(mock.apps.has('mock-demo1-uuid'), 'alte Anwendung ist im Mock verschwunden');
    assert((await fingerprint('demo1')).rows === ctx.fp1.rows, 'demo1-Daten nach der Übernahme verändert (sie bleiben bestehen)');
  });

  // ---------------------------------------------------------------- (9)
  await s.step('9a falscher age-Schlüssel: Restore failed, Ziel demo3 unverändert', async () => {
    const { newKeyPair } = await import(pathToFileURL(join(AGENT_DIR, 'dist', 'age.js')).href);
    const wrong = (await newKeyPair()).identity;
    const before3 = await fingerprint('demo3');
    const start = await c.api('POST', `/api/instances/${ctx.instanceId}/restores`, {
      ...evidence(), backupId: ctx.backup.id, newSubdomain: 'demo3', ageIdentity: wrong, confirmName: 'demo2',
    });
    assert(start.status === 202, `Start: HTTP ${start.status} ${JSON.stringify(start.body).slice(0, 300)}`);
    const { row } = await waitRestore(ctx.instanceId, start.body.id);
    assert(row.status === 'failed', `erwartet failed, war ${row.status}`);
    assert(!JSON.stringify(row).includes(wrong), 'falsche Identität in der Restore-Zeile');
    const after3 = await fingerprint('demo3');
    assert(JSON.stringify(after3) === JSON.stringify(before3) && after3.rows === null && after3.files === 0, `demo3 wurde verändert: ${JSON.stringify(after3)}`);
    assert(await isRunning(`${demoProject('demo3')}-app-1`) && await isRunning(`${demoProject('demo3')}-db-1`), 'demo3-Container laufen nicht');
    ctx.wrongKeyMessage = row.message;
  });

  await s.step('9b falsche Signatur direkt am Agent -> 401', async () => {
    const wrongSecret = await agentCall('GET', '/v1/health', undefined, { secret: hex(32) });
    assert(wrongSecret.status === 401, `falsches Geheimnis: ${wrongSecret.status}`);
    // Signatur gilt für einen anderen Pfad/Body.
    const body = { kind: 'backup-control' };
    const raw = JSON.stringify(body);
    const ts = String(Date.now());
    const nonce = hex(16);
    const sigForOther = createHmac('sha256', SECRETS.agentSecret).update(['POST', '/v1/jobs', ts, nonce, sha256('{}')].join('\n')).digest('hex');
    const tampered = await fetch(`http://127.0.0.1:${AGENT_PORT}/v1/jobs`, {
      method: 'POST', body: raw,
      headers: { 'content-type': 'application/json', 'x-si-timestamp': ts, 'x-si-nonce': nonce, 'x-si-signature': sigForOther },
    });
    assert(tampered.status === 401, `manipulierter Body: ${tampered.status}`);
    const stale = await agentCall('GET', '/v1/health', undefined, { ts: String(Date.now() - 10 * 60_000) });
    assert(stale.status === 401, `alter Zeitstempel: ${stale.status}`);
    const ok = await agentCall('GET', '/v1/health');
    assert(ok.status === 200, 'Agent antwortet danach nicht mehr korrekt');
  });

  await s.step('9c Replay derselben signierten Anfrage -> abgelehnt', async () => {
    const fixed = { ts: String(Date.now()), nonce: hex(16) };
    const first = await agentCall('GET', '/v1/health', undefined, fixed);
    const second = await agentCall('GET', '/v1/health', undefined, fixed);
    assert(first.status === 200, `erste Anfrage: ${first.status}`);
    assert(second.status === 401, `Replay: erwartet 401, war ${second.status}`);
  });

  await s.step('9d Restore in ein Projekt des Agent-Stacks -> abgelehnt', async () => {
    const sub = await agentCall('POST', '/v1/jobs', {
      kind: 'restore',
      objectKey: ctx.backup.objectKey,
      ageIdentity: ctx.ageIdentity,
      target: { subdomain: 'demo9', composeProject: AGENT_PROJECT, dbService: 'backup-agent', dbName: 'app', dbUser: 'app' },
    });
    assert(sub.status === 202, `Auftrag: HTTP ${sub.status} ${JSON.stringify(sub.body)}`);
    const job = await agentJob(sub.body.jobId);
    assert(job.status === 'failed' && /eigene|abgelehnt/i.test(job.message ?? ''), `erwartet abgelehnt, war ${job.status} ${job.message}`);
    assert(!JSON.stringify(job).includes(ctx.ageIdentity), 'Identität im Job-Ergebnis');
    for (const svc of ['backup-agent', 'docker-socket-proxy', 'minio', 'sftp']) {
      assert(await isRunning(`${AGENT_PROJECT}-${svc}-1`), `${svc} läuft nicht mehr`);
    }
    // Auch über die Control-API: Ziel ist ein Compose-Projekt des Agent-Stacks (Muster si-e2e-{subdomain} -> si-e2e-backup).
    const viaControl = await c.api('POST', `/api/instances/${ctx.instanceId}/restores`, {
      ...evidence(), backupId: ctx.backup.id, newSubdomain: 'backup', ageIdentity: ctx.ageIdentity, confirmName: 'demo2',
    });
    if (viaControl.status === 202) {
      const { row } = await waitRestore(ctx.instanceId, viaControl.body.id);
      assert(row.status === 'failed', `Restore über die Control-API in den Agent-Stack: ${row.status} ${row.message}`);
      assert(await isRunning(AGENT_CONTAINER), 'Agent-Container läuft nach dem Versuch nicht mehr');
    }
  });

  // --------------------------------------------------------------- (10)
  const sftpBody = (extra = {}) => ({
    type: 'storagebox', schedule: 'daily', retentionDays: 30, objectLock: false,
    storagebox: { host: 'sftp', port: 22, username: SFTP_USER, path: '/upload', authType: 'password', ...extra },
  });
  await s.step('10a SFTP einrichten, testen: Host-Key per TOFU gepinnt, keine Geheimnisse', async () => {
    const put = await c.api('PUT', '/api/settings/backup', { ...evidence(), ...sftpBody({ password: SECRETS.sftpPassword }) });
    assert(put.status === 200, `PUT: HTTP ${put.status} ${JSON.stringify(put.body).slice(0, 300)}`);
    assert(put.body.ageIdentity === undefined, 'Identität bei der Umstellung erneut geliefert');
    assert(put.body.agent?.ageRecipient === ctx.ageRecipient, 'age-Empfänger hat sich geändert');
    const before = await c.api('GET', '/api/settings/backup');
    assert(!before.body.target?.hostKeyFingerprint, 'Host-Key vor dem ersten Test schon gepinnt');
    const t = await c.api('POST', '/api/settings/backup/test', evidence());
    assert(t.status === 200 && t.body.ok === true, `Test: ${JSON.stringify(t.body).slice(0, 300)}`);
    const after = await c.api('GET', '/api/settings/backup');
    ctx.pinned = after.body.target?.hostKeyFingerprint;
    assert(/^SHA256:[A-Za-z0-9+/]{43}$/.test(ctx.pinned ?? ''), `Host-Key nicht gepinnt: ${ctx.pinned}`);
    scanForSecrets('GET /api/settings/backup (SFTP)', JSON.stringify(after.body), { ...SECRETS, ageIdentity: ctx.ageIdentity });
  });

  await s.step('10b SFTP: Backup (Jetzt sichern), Liste, Objekt verschlüsselt auf dem Ziel', async () => {
    const trig = await c.api('POST', `/api/instances/${ctx.instanceId}/backups`, evidence());
    assert(trig.status === 202, `Trigger: HTTP ${trig.status} ${JSON.stringify(trig.body).slice(0, 300)}`);
    const job = await waitFor(async () => {
      const r = await c.api('GET', `/api/instances/${ctx.instanceId}/backups/jobs/${trig.body.jobId}`);
      return r.status === 200 && ['succeeded', 'failed'].includes(r.body.status) ? r.body : null;
    }, { timeoutMs: 180_000, intervalMs: 700, label: 'Backup-Job (SFTP)' });
    assert(job.status === 'succeeded', `Backup-Job: ${job.status} ${job.message}`);
    const list = await c.api('GET', `/api/instances/${ctx.instanceId}/backups?includeAgent=true`);
    const row = list.body.backups.find((b) => b.objectKey === job.result?.objectKey);
    assert(row && row.restorable && row.sizeBytes > 0, `Sicherung nicht in der Liste: ${JSON.stringify(list.body).slice(0, 300)}`);
    assert(list.body.agent.available && list.body.agent.items.some((i) => i.objectKey === row.objectKey && i.subdomain === 'demo2'), 'Agent-Liste (SFTP) unstimmig');
    assert(!row.objectKey.startsWith(`${PREFIX}/`), 'SFTP-Schlüssel sollten ohne S3-Präfix sein');
    ctx.sftpBackup = row;
    const { SftpStorage } = await import(pathToFileURL(join(AGENT_DIR, 'dist', 'storage', 'sftp.js')).href);
    ctx.sftp = new SftpStorage({ host: '127.0.0.1', port: SFTP_PORT, username: SFTP_USER, password: SECRETS.sftpPassword, path: '/upload', authType: 'password' });
    const stream = await ctx.sftp.get(row.objectKey);
    const chunks = [];
    for await (const ch of stream) chunks.push(Buffer.from(ch));
    const dump = Buffer.concat(chunks);
    assert(dump.subarray(0, 21).toString('latin1') === 'age-encryption.org/v1' && dump.indexOf('PGDMP') === -1, 'SFTP-Objekt nicht verschlüsselt');
    assert(sha256(dump) === row.sha256, 'sha256 der SFTP-Sicherung stimmt nicht');
  });

  await s.step('10c SFTP: Restore-Roundtrip (Instanz -> demo4) und Control-Sicherung entschlüsselbar', async () => {
    const start = await c.api('POST', `/api/instances/${ctx.instanceId}/restores`, {
      ...evidence(), backupId: ctx.sftpBackup.id, newSubdomain: 'demo4', ageIdentity: ctx.ageIdentity, confirmName: 'demo2',
    });
    assert(start.status === 202, `Start: HTTP ${start.status} ${JSON.stringify(start.body).slice(0, 300)}`);
    const { row, seen } = await waitRestore(ctx.instanceId, start.body.id);
    assert(row.status === 'ready', `Restore: ${row.status} ${row.message} (${seen.join('>')})`);
    const fp4 = await fingerprint('demo4');
    assert(fp4.rows === ctx.fp1.rows && fp4.uploads === ctx.fp1.uploads && fp4.files === 2, `demo4 weicht ab: ${JSON.stringify(fp4)} gegen ${JSON.stringify(ctx.fp1)}`);

    // Control-Sicherung (Verwaltungs-DB) und Rechnungsarchiv auf SFTP.
    const sub = await agentCall('POST', '/v1/jobs', { kind: 'backup-control' });
    const job = await agentJob(sub.body.jobId);
    assert(job.status === 'succeeded', `backup-control (SFTP): ${job.status} ${job.message}`);
    const entries = await agentCall('GET', '/v1/backups?kind=control');
    assert(entries.status === 200 && entries.body.some((e) => e.objectKey === job.result.objectKey), 'Control-Sicherung nicht in der Agent-Liste');
    const inv = await agentCall('GET', '/v1/backups?kind=invoices');
    assert(inv.status === 200 && inv.body.length >= 1, 'Rechnungsarchiv nicht in der Agent-Liste (SFTP)');
    const { decryptBuffer } = await import(pathToFileURL(join(AGENT_DIR, 'dist', 'age.js')).href);
    const read = async (key) => {
      const chunks = [];
      for await (const ch of await ctx.sftp.get(key)) chunks.push(Buffer.from(ch));
      return Buffer.concat(chunks);
    };
    const plain = await decryptBuffer(ctx.ageIdentity, await read(job.result.objectKey));
    assert(plain.subarray(0, 5).toString('latin1') === 'PGDMP', 'entschlüsselter Control-Dump ist kein pg_dump-Archiv');
    const list = await run('docker', ['exec', '-i', AGENT_CONTAINER, 'pg_restore', '-l'], { input: plain, allowFail: true });
    assert(list.code === 0 && /TABLE DATA public Invoice /.test(list.stdout), `pg_restore -l: ${list.stderr.slice(0, 200)}`);
    // Rechnungsarchiv entschlüsseln: enthält die festgeschriebene Rechnung mit stimmiger Prüfsumme.
    const archive = await decryptBuffer(ctx.ageIdentity, await read(inv.body[0].objectKey));
    assert(archive.includes(Buffer.from('hashes.sha256')) && archive.includes(Buffer.from(ctx.invoiceXmlSha)), 'Rechnungsarchiv enthält die Prüfsumme der Rechnung nicht');
  });

  await s.step('10d Host-Key-Pinning: neuer SFTP-Container (neuer Host-Key) -> Verbindung abgelehnt', async () => {
    await compose(AGENT_PROJECT, AGENT_COMPOSE, ['rm', '-sf', 'sftp'], { env: composeEnv, timeoutMs: 120_000 });
    await compose(AGENT_PROJECT, AGENT_COMPOSE, ['up', '-d', '--no-deps', 'sftp'], { env: composeEnv, timeoutMs: 120_000 });
    await waitTcpBanner(SFTP_PORT, 'SSH-2.0');
    const t = await c.api('POST', '/api/settings/backup/test', evidence());
    assert(t.status === 200 && t.body.ok === false, `Test nach Host-Key-Wechsel: ${JSON.stringify(t.body).slice(0, 300)}`);
    assert(/Host-Key/i.test(t.body.message), `Meldung nennt den Host-Key nicht: ${t.body.message}`);
    const get = await c.api('GET', '/api/settings/backup');
    assert(get.body.target?.hostKeyFingerprint === ctx.pinned, 'gepinnter Fingerabdruck wurde überschrieben');
    // Backup-Job gegen den fremden Host scheitert ebenfalls (nichts wird dorthin geschrieben).
    const sub = await agentCall('POST', '/v1/jobs', { kind: 'backup-control' });
    const job = await agentJob(sub.body.jobId);
    assert(job.status === 'failed', `Job gegen den fremden Host: ${job.status}`);
  });

  // ---------------------------------------------------------------- final
  await s.step('final: keine Geheimnisse in Logs/Antworten, kein DELETE gegen Coolify, Mock-Mitschrift gesichert', async () => {
    const secrets = { ...SECRETS, ageIdentity: ctx.ageIdentity };
    const agentLog = await logs(AGENT_CONTAINER, 100000);
    const proxyLog = await logs(PROXY_CONTAINER, 100000);
    writeFileSync(join(OUT, 'agent.log'), agentLog);
    writeFileSync(join(OUT, 'docker-proxy.log'), proxyLog);
    writeFileSync(join(OUT, 'mock-coolify-calls.json'), JSON.stringify(mock.calls, null, 2));
    scanForSecrets('Control-Log', readFileSync(join(OUT, `control-${CONTROL_PORT}.log`), 'utf8'), secrets);
    scanForSecrets('Agent-Log', agentLog, secrets);
    scanForSecrets('Proxy-Log', proxyLog, secrets);
    scanForSecrets('Mock-Aufrufe', JSON.stringify(mock.calls), secrets);
    const audit = await prisma.auditLog.findMany({ select: { action: true, beforeValue: true, afterValue: true } });
    scanForSecrets('Audit-Log', JSON.stringify(audit), secrets);
    const rows = await prisma.instanceRestore.findMany();
    scanForSecrets('InstanceRestore-Zeilen', JSON.stringify(rows), secrets);
    assert(!mock.calls.some((x) => x.method === 'DELETE' || x.forbiddenDelete), 'DELETE gegen den Mock-Coolify');
    const methods = [...new Set(mock.calls.map((x) => x.method))].sort();
    assert(methods.every((m) => ['GET', 'POST', 'PATCH'].includes(m)), `unerwartete Methoden: ${methods}`);
    assert(!mock.calls.some((x) => x.unhandled), `unbekannte Coolify-Aufrufe: ${JSON.stringify(mock.calls.filter((x) => x.unhandled))}`);
    const stops = mock.calls.filter((x) => x.path.endsWith('/stop'));
    assert(stops.length === 1, `genau ein stop erwartet, waren ${stops.length}`);
  });
} catch (e) {
  console.log(`FAIL backup/Abbruch: ${String(e?.message ?? e).split('\n')[0]}`);
  process.exitCode = 1;
} finally {
  try {
    if (existsSync(OUT)) {
      const al = await logs(AGENT_CONTAINER, 100000).catch(() => '');
      if (al) writeFileSync(join(OUT, 'agent.log'), al);
      if (mock) writeFileSync(join(OUT, 'mock-coolify-calls.json'), JSON.stringify(mock.calls, null, 2));
    }
  } catch { /* Artefakte best effort */ }
  if (prisma) await prisma.$disconnect().catch(() => {});
  if (ctl) await ctl.stop().catch(() => {});
  if (mock) await mock.stop().catch(() => {});
  for (const p of [AGENT_PROJECT, ...DEMOS.map(demoProject)]) {
    await composeDown(p, p === AGENT_PROJECT ? AGENT_COMPOSE : DEMO_COMPOSE, { env: composeEnv }).catch(() => {});
  }
  s.finish();
}
