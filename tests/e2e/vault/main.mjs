// Suite "vault": Echttest der Feldverschlüsselung und des Tresors (Passphrase, Wiederherstellungsschlüssel).
//
// Ablauf (eine frische Datenbank e2e_vault, Control-API aus dem Quellcode, Rechnungsdienst + Mailpit als Container):
//  1. Start -> Tresor "uninitialized", alles außer Anmeldung/Tresor antwortet 423; Einrichtung liefert den
//     Wiederherstellungsschlüssel (einmalig).
//  2. Daten: Firmendaten, Organisation (Name/E-Mail/IBAN), Notiz, Einwilligung, Rechnung festschreiben + versenden.
//  3. Rohabfrage per psql: in Company, Note, InvoiceLine, Invoice (inkl. pdfContent-Kopfzeile), MailDelivery, Consent
//     und AuditLog steht kein Klartext, jede betroffene Spalte trägt das Präfix; Blind-Index-Spalten sind gefüllt.
//  4. pg_dump der ganzen Datenbank, Suche nach allen Testwerten (Text und Hex) -> kein Treffer.
//  5. Neustart: 423 auf /api/companies, falsche Passphrase und falscher Schlüssel abgelehnt, Wiederherstellungs-
//     schlüssel entsperrt; Suche nach Namensteil, Dublettenprüfung (Anfrage), Einwilligung und Sperre über Blind-Index.
//  6. Integritätslauf, Dokumentabruf (Hash wie vor dem Neustart) und GoBD-Export mit Prüfsummen (sha256sum -c).
//  7. Zweiter Neustart: die Passphrase entsperrt ebenfalls.
// Alles ist frei erfunden (example.com); Container tragen e2e=true und e2e.suite=vault.
import { mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { startControl, ROOT } from '../lib/control.mjs';
import { docker, run, waitHealthy } from '../lib/docker.mjs';
import { createSuite, assert, E2E_OUT, waitFor, sleep } from '../lib/util.mjs';
import { mailpit, sqlClient, sha256, today, monthRange } from '../invoice/helpers.mjs';
import { FORMS } from '../invoice/fixtures.mjs';
import {
  ORG, IBAN, NOTE_TEXT, INVOICE_INTRO, LINE, CONSENT_EMAIL, CONSENT_TEXT, NEEDLES,
} from './fixtures.mjs';

const SUITE = 'vault';
const s = createSuite(SUITE, { stepTimeoutMs: 180_000 });
const OUT = join(E2E_OUT, SUITE);
mkdirSync(OUT, { recursive: true });

// ---- Festlegungen (eigene Ports und Namen, damit die Suite neben den anderen laufen kann) ---------------------
const PORT_RENDERER = 18180;
const PORT_SMTP = 11125;
const PORT_MAILPIT = 18125;
const PORT_CONTROL = Number(process.env.E2E_VAULT_CONTROL_PORT) || 13102;
const DB = 'e2e_vault';
const DB_CONTAINER = process.env.E2E_DB_CONTAINER || 'si-test-db';
const DB_USER = process.env.E2E_DB_USER || 'postgres';
const C_RENDERER = 'e2e-vault-renderer';
const C_MAILPIT = 'e2e-vault-mailpit';
const RENDERER_IMAGE = 'si-e2e-vault-renderer';
const MAILPIT_IMAGE = 'axllent/mailpit:latest';
const INQUIRY_KEY = 'e2e-vault-inquiry-key-0123456789abcdef';
const SUITE_LABELS = ['--label', 'e2e=true', '--label', `e2e.suite=${SUITE}`];
const GMBH = FORMS.find((f) => f.key === 'gmbh');
const PREFIX = 'enc:v1:';

const MANIFEST = `product:
  name: Demo Software
  slug: demo-software
mail:
  senderName: Demo Software
  senderAddress: noreply@example.com
  domain: example.com
  replyTo: hilfe@example.com
  websiteUrl: https://example.com
  legalLinks:
    - text: Impressum
      url: https://example.com/impressum
billing:
  retentionYears: 8
`;

// ---- Zustand ----------------------------------------------------------------------------------
let ctl; let db; let mp;
let sess = null; // { api, proof }
let sessionAt = 0;
const st = {
  passphrase: null, recoveryKey: null, companyId: null, invoiceId: null, invoiceNumber: null, pdfSha: null,
  consentStatusBefore: null, windowFrom: null, windowTo: null,
};
const notes = [];
const note = (t) => { notes.push(t); console.log(`HINWEIS ${t}`); };
const expectOk = (r, what) => assert(r.ok, `${what}: HTTP ${r.status} ${JSON.stringify(r.body).slice(0, 300)}`);
const bodyText = (r) => (Buffer.isBuffer(r.body) ? r.body.toString() : JSON.stringify(r.body ?? ''));

// ---- Anmeldung: pro Anmeldung ein TOTP-Schritt; ein verbrauchter Schritt wartet ins nächste Fenster ----------------
const SESSION_FRESH_MS = 7 * 60_000;
async function login() {
  for (let attempt = 0; ; attempt++) {
    try {
      const l = await ctl.login();
      sess = { api: l.api, proof: l.proof };
      sessionAt = Date.now();
      return;
    } catch (e) {
      if (attempt >= 1) throw e;
      await sleep(31_000);
    }
  }
}
/** Bestehende Sitzung weiter verwenden (falls sie den Neustart überlebt hat), sonst neu anmelden. */
async function ensureSession() {
  if (sess && Date.now() - sessionAt < SESSION_FRESH_MS) {
    const me = await sess.api('GET', '/api/auth/me').catch(() => null);
    if (me?.ok) return;
  }
  await login();
}
/** Aufruf mit Zweitfaktor-Fallback: frisch angemeldet genügt ohne Code, sonst wird der Nachweis nachgeschoben. */
async function prot(method, path, body, opts) {
  if (!sess || Date.now() - sessionAt > SESSION_FRESH_MS) await login();
  let r;
  for (let attempt = 0; attempt < 4; attempt++) {
    r = await sess.api(method, path, body, opts);
    if (r.status !== 429) break;
    await sleep((Number(r.headers?.get?.('retry-after')) || 15) * 1000 + 500);
  }
  const plain = body && typeof body === 'object' && !(body instanceof Uint8Array);
  if ((r.status === 401 || r.status === 403) && plain && !('totpCode' in body)) {
    r = await sess.api(method, path, { ...body, ...(await sess.proof()) }, opts);
  }
  return r;
}
const get = (path) => sess.api('GET', path);

const publicHeaders = { 'x-inquiry-key': INQUIRY_KEY };
async function publicPost(path, body) {
  const res = await fetch(`${ctl.url}${path}`, {
    method: 'POST', headers: { 'content-type': 'application/json', ...publicHeaders }, body: JSON.stringify(body),
  });
  const text = await res.text();
  let parsed; try { parsed = text ? JSON.parse(text) : null; } catch { parsed = text; }
  return { status: res.status, ok: res.ok, body: parsed };
}
const jget = async (path) => {
  const r = await fetch(`${ctl.url}${path}`);
  return { status: r.status, body: await r.json().catch(() => null) };
};

// ---- Rohabfragen -------------------------------------------------------------------------------
const q = (name) => `"${name}"`;
/**
 * Je Spalte: wie viele Werte gefüllt sind (n) und wie viele davon KEIN Präfix tragen (plain).
 * text: Präfix `enc:v1:`; bytes: Kopfzeile `ENC1`; json: JSON-String mit Präfix.
 */
async function columnReport(table, { text = [], bytes = [], json = [] }, where = 'true') {
  const parts = [];
  for (const c of text) {
    parts.push(`count(${q(c)}) AS ${q(`${c}__n`)}`);
    parts.push(`count(*) FILTER (WHERE ${q(c)} IS NOT NULL AND ${q(c)} NOT LIKE '${PREFIX}%') AS ${q(`${c}__plain`)}`);
  }
  for (const c of bytes) {
    parts.push(`count(${q(c)}) AS ${q(`${c}__n`)}`);
    parts.push(`count(*) FILTER (WHERE ${q(c)} IS NOT NULL AND substring(${q(c)} from 1 for 4) <> decode('454e4331','hex')) AS ${q(`${c}__plain`)}`);
  }
  for (const c of json) {
    parts.push(`count(${q(c)}) AS ${q(`${c}__n`)}`);
    parts.push(
      `count(*) FILTER (WHERE ${q(c)} IS NOT NULL AND jsonb_typeof(${q(c)}::jsonb) <> 'null' AND NOT (jsonb_typeof(${q(c)}::jsonb) = 'string' AND (${q(c)}::jsonb #>> '{}') LIKE '${PREFIX}%')) AS ${q(`${c}__plain`)}`,
    );
  }
  const r = await db(`SELECT row_to_json(t) FROM (SELECT count(*) AS rows, ${parts.join(', ')} FROM ${q(table)} WHERE ${where}) t`);
  assert(r.out, `Rohabfrage ${table} ohne Ergebnis: ${r.err.slice(0, 200)}`);
  return JSON.parse(r.out);
}
/** Prüft einen Bericht: keine Klartextwerte; die Spalten aus `required` müssen gefüllt (und damit verschlüsselt) sein. */
function assertEncrypted(table, rep, cols, required) {
  assert(rep.rows > 0, `${table}: keine Zeilen für die Prüfung`);
  const plain = [];
  for (const c of cols) if (Number(rep[`${c}__plain`]) > 0) plain.push(`${c} (${rep[`${c}__plain`]})`);
  assert(plain.length === 0, `${table}: Spalten mit Klartext: ${plain.join(', ')}`);
  const empty = required.filter((c) => Number(rep[`${c}__n`]) === 0);
  assert(empty.length === 0, `${table}: erwartete gefüllte Spalten sind leer: ${empty.join(', ')}`);
  const nEnc = cols.reduce((a, c) => a + Number(rep[`${c}__n`]), 0);
  note(`${table}: ${rep.rows} Zeilen, ${nEnc} verschlüsselte Werte in ${cols.length} Spalten, 0 Klartext`);
}

const COLS = {
  Company: {
    text: ['name', 'legalForm', 'website', 'street', 'houseNumber', 'postalCode', 'city', 'billingName', 'billingStreet',
      'billingHouseNumber', 'billingPostalCode', 'billingCity', 'billingEmail', 'contactName', 'contactEmail', 'contactPhone',
      'contactRole', 'deputyName', 'deputyEmail', 'deputyPhone', 'deputyRole', 'sepaMandateReference', 'iban', 'bic',
      'accountHolder', 'sepaMandateText', 'sepaMandateIp', 'notes', 'vatId', 'buyerReference', 'electronicAddress'],
    required: ['name', 'legalForm', 'website', 'street', 'houseNumber', 'postalCode', 'city', 'billingEmail', 'contactName',
      'contactEmail', 'contactPhone', 'iban', 'notes', 'vatId'],
  },
  Note: { text: ['text'], required: ['text'] },
  InvoiceLine: { text: ['description'], required: ['description'] },
  Invoice: {
    text: ['recipientName', 'recipientAddress', 'recipientEmail', 'recipientVatId', 'recipientBuyerReference',
      'recipientElectronicAddress', 'issuerCompanyName', 'issuerAddress', 'issuerSeat', 'issuerVatId', 'issuerRegisterCourt',
      'issuerCommercialRegisterA', 'issuerGeneralPartner', 'issuerGeneralPartnerSeat', 'issuerGeneralPartnerRegisterCourt',
      'issuerGeneralPartnerCommercialRegisterB', 'issuerManagingDirector', 'directDebitMandateReference', 'issuerBankDetails',
      'issuerContactName', 'issuerContactPhone', 'issuerContactEmail', 'issuerIban', 'issuerBic', 'issuerBankName',
      'introduction', 'paymentNote', 'internalNote', 'cancellationReason'],
    bytes: ['pdfContent', 'xmlContent', 'xrechnungContent'],
    json: ['issuerLayout'],
    required: ['recipientName', 'recipientAddress', 'recipientEmail', 'recipientVatId', 'issuerCompanyName', 'issuerAddress',
      'introduction', 'pdfContent', 'xmlContent'],
  },
  MailDelivery: {
    text: ['recipientAddress', 'subject', 'contentSnapshot', 'contentSnapshotHtml'],
    required: ['recipientAddress', 'subject', 'contentSnapshot'],
  },
  Consent: {
    text: ['email', 'ipAtSubscription', 'ipAtConfirmation', 'formText', 'blockReason'],
    required: ['email', 'formText'],
  },
  AuditLog: { text: ['ip', 'userAgent'], json: ['beforeValue', 'afterValue'], required: ['ip', 'userAgent', 'afterValue'] },
};
const colsOf = (c) => [...(c.text ?? []), ...(c.bytes ?? []), ...(c.json ?? [])];
const BLIND = [
  ['Company', 'contactEmailIdx', 'contactEmail'],
  ['Consent', 'emailIdx', 'email'],
  ['MailDelivery', 'recipientIdx', 'recipientAddress'],
];

const containerPort = (name, hostPort, containerPortNr, extra = []) =>
  ['run', '-d', '--name', name, ...SUITE_LABELS, '-p', `127.0.0.1:${hostPort}:${containerPortNr}`, ...extra];

try {
  // ======================================================================= Infrastruktur
  await s.step('Rechnungsdienst-Image bauen und gehärtet starten (127.0.0.1:18180)', async () => {
    await docker(['build', '-t', RENDERER_IMAGE, join(ROOT, 'tools', 'invoice-renderer')], { timeoutMs: 1_200_000 });
    await docker(['rm', '-f', C_RENDERER], { allowFail: true });
    await docker([
      ...containerPort(C_RENDERER, PORT_RENDERER, 8080, [
        '--read-only', '--tmpfs', '/tmp:size=256m', '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges:true',
      ]),
      RENDERER_IMAGE,
    ]);
    await waitHealthy(C_RENDERER, { timeoutMs: 120_000 });
    const hc = await fetch(`http://127.0.0.1:${PORT_RENDERER}/gesundheit`);
    assert(hc.ok, `/gesundheit -> ${hc.status}`);
  }, { timeoutMs: 1_400_000 });

  await s.step('Mailpit starten (SMTP 11125, API 18125)', async () => {
    await docker(['rm', '-f', C_MAILPIT], { allowFail: true });
    await docker([
      'run', '-d', '--name', C_MAILPIT, ...SUITE_LABELS,
      '-p', `127.0.0.1:${PORT_SMTP}:1025`, '-p', `127.0.0.1:${PORT_MAILPIT}:8025`, MAILPIT_IMAGE,
    ], { timeoutMs: 300_000 });
    mp = mailpit(`http://127.0.0.1:${PORT_MAILPIT}`);
    await waitFor(async () => (await fetch(`http://127.0.0.1:${PORT_MAILPIT}/livez`).catch(() => null))?.ok, { timeoutMs: 60_000, label: 'Mailpit' });
    await mp.clear();
  }, { timeoutMs: 330_000 });

  // ======================================================================= (1) Start und Einrichtung
  await s.step('(1a) frische Datenbank: Control startet, Tresor "uninitialized" (health, vault/status)', async () => {
    writeFileSync(join(OUT, 'manifest.e2e.yaml'), MANIFEST);
    ctl = await startControl({
      port: PORT_CONTROL, dbName: DB, suite: SUITE, vault: false,
      env: {
        MANIFEST_PATH: join(OUT, 'manifest.e2e.yaml'),
        RECHNUNGSDIENST_URL: `http://127.0.0.1:${PORT_RENDERER}`,
        SMTP_HOST: '127.0.0.1', SMTP_PORT: String(PORT_SMTP), SMTP_TLS_ERZWINGEN: '0',
        SMTP_FROM: 'Demo Software <noreply@example.com>',
        MAIL_DOMAIN: 'example.com',
        CONTROL_INQUIRY_KEY: INQUIRY_KEY,
      },
    });
    db = sqlClient({ container: DB_CONTAINER, dbName: DB, user: DB_USER });
    const h = await jget('/api/health');
    assert(h.status === 200 && h.body?.status === 'uninitialized', `health: HTTP ${h.status} ${JSON.stringify(h.body)}`);
    const v = await jget('/api/vault/status');
    assert(v.body?.state === 'uninitialized', `vault/status: ${JSON.stringify(v.body)}`);
  }, { timeoutMs: 700_000 });
  if (!ctl) throw new Error('Control nicht gestartet – Abbruch der Suite');

  await s.step('(1b) vor der Einrichtung: Anmeldung geht, Verwaltung und Formulare antworten 423 vault_locked', async () => {
    await login();
    const c = await get('/api/companies');
    assert(c.status === 423, `GET /api/companies: HTTP ${c.status} statt 423`);
    assert(bodyText(c).includes('vault_locked'), `kein vault_locked im Fehlertext: ${bodyText(c).slice(0, 200)}`);
    const i = await publicPost('/api/public/inquiry', { inquiryKind: 'demo', email: 'vorher@vault-e2e.example.com' });
    assert(i.status === 423, `POST /api/public/inquiry: HTTP ${i.status} statt 423`);
    const rows = await db(`SELECT count(*) FROM "Company"`);
    assert(rows.out === '0', `Company-Zeilen ohne Tresor: ${rows.out}`);
  });

  await s.step('(1c) Einrichtung: Passphrase + einmaliger Wiederherstellungsschlüssel, danach "unlocked"; zweite Einrichtung abgelehnt', async () => {
    st.passphrase = `vault-e2e-${Math.random().toString(36).slice(2)}-${Date.now().toString(36)}-Zz9`;
    const r = await prot('POST', '/api/vault/setup', { passphrase: st.passphrase });
    expectOk(r, 'POST /api/vault/setup');
    st.recoveryKey = r.body?.recoveryKey;
    assert(typeof st.recoveryKey === 'string' && st.recoveryKey.replace(/[\s-]/g, '').length >= 20, `Wiederherstellungsschlüssel unplausibel: ${JSON.stringify(st.recoveryKey)}`);
    writeFileSync(join(OUT, 'recovery-key.txt'), `${st.recoveryKey}\n`, { mode: 0o600 });
    const v = await jget('/api/vault/status');
    assert(v.body?.state === 'unlocked', `vault/status nach Einrichtung: ${JSON.stringify(v.body)}`);
    const h = await jget('/api/health');
    assert(h.body?.status === 'unlocked', `health nach Einrichtung: ${JSON.stringify(h.body)}`);
    const again = await prot('POST', '/api/vault/setup', { passphrase: `${st.passphrase}-zwei` });
    assert(!again.ok && again.status >= 400 && again.status < 500, `zweite Einrichtung: HTTP ${again.status} statt 4xx`);
    st.windowFrom = new Date(); // ab jetzt ist der Tresor offen; Audit-Zeilen der Anmeldung/Einrichtung liegen davor
    const wraps = await db(`SELECT kind, count(*) FROM "Vault" GROUP BY kind ORDER BY kind`);
    assert(/passphrase\|1/.test(wraps.out) && /recovery\|1/.test(wraps.out), `Vault-Zeilen: ${wraps.out}`);
  });

  // ======================================================================= (2) Daten anlegen
  await s.step('(2a) Firmendaten (Aussteller) speichern, Organisation mit Name/E-Mail/Anschrift anlegen, IBAN setzen', async () => {
    const put = await prot('PUT', '/api/settings/issuer', { profile: GMBH.profile, accentColor: null });
    expectOk(put, 'PUT /api/settings/issuer');
    const c = await prot('POST', '/api/companies', { ...ORG });
    expectOk(c, 'POST /api/companies');
    st.companyId = c.body.id;
    assert(c.body.name === ORG.name, `Name in der Antwort: ${c.body.name}`);
    const p = await prot('PATCH', `/api/companies/${st.companyId}/payment-details`, { iban: IBAN });
    expectOk(p, 'PATCH payment-details');
    const back = await get(`/api/companies/${st.companyId}`);
    expectOk(back, 'GET /api/companies/:id');
    assert(back.body.name === ORG.name && back.body.contactEmail === ORG.contactEmail, 'Name/E-Mail beim Lesen nicht im Klartext');
  });

  await s.step('(2b) Notiz anlegen, Einwilligung eintragen (öffentliches Formular), Mailpit leeren', async () => {
    const n = await prot('POST', '/api/notes', { companyId: st.companyId, text: NOTE_TEXT });
    expectOk(n, 'POST /api/notes');
    await mp.clear();
    const c = await publicPost('/api/consent/subscription', { email: CONSENT_EMAIL, formText: CONSENT_TEXT, origin: 'e2e-vault' });
    assert(c.status === 200, `POST /api/consent/subscription: HTTP ${c.status} ${JSON.stringify(c.body).slice(0, 200)}`);
    const row = await waitFor(async () => {
      const r = await db(`SELECT status FROM "Consent"`);
      return r.out || null;
    }, { timeoutMs: 15_000, label: 'Consent-Zeile' });
    st.consentStatusBefore = row.split('\n')[0];
    const cnt = await db(`SELECT count(*) FROM "Consent"`);
    assert(cnt.out === '1', `Consent-Zeilen: ${cnt.out}`);
  });

  await s.step('(2c) Rechnung: Entwurf, festschreiben, Versand an Mailpit (PDF-Anhang), Dokument abrufen', async () => {
    const period = monthRange();
    const d = await prot('POST', `/api/companies/${st.companyId}/invoices`, {
      invoiceDate: today(), servicePeriodFrom: period.from, servicePeriodUntil: period.until,
      introduction: INVOICE_INTRO, lines: [{ ...LINE }],
    });
    expectOk(d, 'Entwurf anlegen');
    st.invoiceId = d.body.id;
    const f = await prot('POST', `/api/invoices/${st.invoiceId}/finalize`, { confirmation: 'festschreiben' });
    expectOk(f, 'finalize');
    st.invoiceNumber = f.body.invoiceNumber;
    assert(st.invoiceNumber, 'keine Rechnungsnummer');
    const send = await prot('POST', `/api/invoices/${st.invoiceId}/send`, {});
    expectOk(send, 'send');
    const m = await mp.waitFor((x) => x.To?.some((t) => t.Address === ORG.billingEmail), 'Rechnungsmail');
    assert(m.Subject.includes(st.invoiceNumber), `Betreff ohne Rechnungsnummer: ${m.Subject}`);
    const pdf = await sess.api('GET', `/api/invoices/${st.invoiceId}/document`, undefined, { raw: true });
    assert(pdf.status === 200 && pdf.body.subarray(0, 4).toString() === '%PDF', `GET document: HTTP ${pdf.status}`);
    st.pdfSha = sha256(pdf.body);
    const row = await db(`SELECT "pdfSha256" FROM "Invoice" WHERE id='${st.invoiceId}'`);
    assert(row.out === st.pdfSha, `pdfSha256 in der DB (${row.out}) != SHA-256 des Dokuments (${st.pdfSha}): Hash muss über den Klartext laufen`);
    note(`Rechnung ${st.invoiceNumber}: PDF ${pdf.body.length} B, sha256 ${st.pdfSha.slice(0, 16)}…`);
  }, { timeoutMs: 240_000 });

  // ======================================================================= (3) Rohabfrage
  const ts = (d) => d.toISOString().replace('Z', '');
  await s.step('(3a) psql: Company, Note, InvoiceLine, Invoice (inkl. pdfContent-Kopfzeile ENC1), MailDelivery, Consent ohne Klartext', async () => {
    for (const table of ['Company', 'Note', 'InvoiceLine', 'Invoice', 'MailDelivery', 'Consent']) {
      const spec = COLS[table];
      const rep = await columnReport(table, spec);
      assertEncrypted(table, rep, colsOf(spec), spec.required);
    }
    const hdr = await db(`SELECT encode(substring("pdfContent" from 1 for 4),'escape') FROM "Invoice" WHERE id='${st.invoiceId}'`);
    assert(hdr.out === 'ENC1', `pdfContent beginnt nicht mit ENC1: "${hdr.out}"`);
    const pdfMagic = await db(`SELECT count(*) FROM "Invoice" WHERE "pdfContent" IS NOT NULL AND position('\\x25504446'::bytea in "pdfContent") = 1`);
    assert(pdfMagic.out === '0', 'pdfContent enthält ein unverschlüsseltes %PDF');
    const wholeRow = await db(`SELECT count(*) FROM "Company" WHERE "Company"::text ILIKE '%zebrafink%' OR "Company"::text ILIKE '%brombeerstrunk%' OR "Company"::text ILIKE '%${IBAN}%'`);
    assert(wholeRow.out === '0', `Company-Zeile enthält Klartext (ganze Zeile als Text): ${wholeRow.out} Treffer`);
  });

  await s.step('(3b) psql: AuditLog (Zeiten nach der Einrichtung) trägt in ip, userAgent, beforeValue, afterValue nur Chiffretext', async () => {
    const where = `"timestamp" >= '${ts(st.windowFrom)}' AND "timestamp" <= '${ts(new Date())}'`;
    const rep = await columnReport('AuditLog', COLS.AuditLog, where);
    assertEncrypted('AuditLog', rep, colsOf(COLS.AuditLog), COLS.AuditLog.required);
    const total = await db(`SELECT count(*) FROM "AuditLog"`);
    const outside = await db(
      `SELECT count(*) FROM "AuditLog" WHERE NOT (${where}) AND ((ip IS NOT NULL AND ip NOT LIKE '${PREFIX}%') OR ("userAgent" IS NOT NULL AND "userAgent" NOT LIKE '${PREFIX}%'))`,
    );
    note(`AuditLog gesamt ${total.out} Zeilen; ${outside.out} Zeilen außerhalb des Prüffensters (Anmeldung/Einrichtung vor dem Entsperren) mit Klartext-IP/Agent`);
  });

  await s.step('(3c) Blind-Index-Spalten gefüllt, ohne Klartext (Company.contactEmailIdx, Consent.emailIdx, MailDelivery.recipientIdx)', async () => {
    for (const [table, idx, src] of BLIND) {
      const r = await db(`SELECT count(*) FILTER (WHERE ${q(idx)} IS NOT NULL), count(*) FILTER (WHERE ${q(idx)} IS NULL AND ${q(src)} IS NOT NULL), min(length(${q(idx)})), count(*) FILTER (WHERE ${q(idx)} LIKE '%@%' OR ${q(idx)} LIKE '${PREFIX}%') FROM ${q(table)}`);
      const [filled, missing, minLen, plainish] = r.out.split('|').map(Number);
      assert(filled > 0, `${table}.${idx}: keine gefüllten Werte`);
      assert(missing === 0, `${table}.${idx}: ${missing} Zeilen mit Quellwert, aber ohne Index`);
      assert(minLen >= 32, `${table}.${idx}: Index zu kurz (${minLen})`);
      assert(plainish === 0, `${table}.${idx}: sieht wie Klartext/Chiffretext aus`);
    }
  });

  // ======================================================================= (4) pg_dump
  await s.step('(4) pg_dump der ganzen Datenbank: kein Testwert (Name, E-Mail, IBAN, Notiz, ...) als Text oder Hex', async () => {
    const dump = await docker(['exec', DB_CONTAINER, 'pg_dump', '-U', DB_USER, '-d', DB, '--no-owner'], { timeoutMs: 120_000 });
    const dumpPath = join(OUT, 'dump.sql');
    writeFileSync(dumpPath, dump.stdout);
    const lines = dump.stdout.split('\n');
    assert(lines.length > 500 && dump.stdout.includes('COPY public."Company"'), 'Dump unvollständig');
    const hits = [];
    let table = '-';
    for (const line of lines) {
      const m = /^COPY public\."?([A-Za-z_]+)"? /.exec(line);
      if (m) table = m[1];
      else if (line === '\\.') table = '-';
      const low = line.toLowerCase();
      for (const [label, value] of NEEDLES) {
        const v = value.toLowerCase();
        const hex = Buffer.from(value, 'utf8').toString('hex');
        if (low.includes(v) || low.includes(hex)) hits.push(`${label} in ${table}`);
      }
    }
    const unique = [...new Set(hits)];
    assert(unique.length === 0, `Klartext im Dump: ${unique.join('; ')}`);
    const encCount = (dump.stdout.match(/enc:v1:/g) ?? []).length;
    assert(encCount > 50, `Dump enthält nur ${encCount} Chiffretext-Werte`);
    note(`pg_dump: ${(dump.stdout.length / 1024).toFixed(0)} KiB, ${lines.length} Zeilen, ${NEEDLES.length} Suchwerte, 0 Treffer, ${encCount} Chiffretext-Werte`);
  }, { timeoutMs: 200_000 });

  // ======================================================================= (5) Neustart
  await s.step('(5a) Neustart: health "locked", /api/companies und öffentliche Formulare antworten 423', async () => {
    await ctl.restart();
    const h = await jget('/api/health');
    assert(h.status === 200 && h.body?.status === 'locked', `health nach Neustart: HTTP ${h.status} ${JSON.stringify(h.body)}`);
    const v = await jget('/api/vault/status');
    assert(v.body?.state === 'locked', `vault/status nach Neustart: ${JSON.stringify(v.body)}`);
    await ensureSession(); // Anmeldung funktioniert auch bei gesperrtem Tresor
    for (const path of ['/api/companies', '/api/invoices', '/api/notes?companyId=' + st.companyId]) {
      const r = await get(path);
      assert(r.status === 423, `GET ${path}: HTTP ${r.status} statt 423`);
      assert(bodyText(r).includes('vault_locked'), `kein vault_locked bei ${path}`);
    }
    const i = await publicPost('/api/public/inquiry', { inquiryKind: 'demo', email: ORG.contactEmail });
    assert(i.status === 423, `Anfrageformular bei gesperrtem Tresor: HTTP ${i.status} statt 423`);
    const c = await publicPost('/api/consent/subscription', { email: CONSENT_EMAIL, formText: CONSENT_TEXT });
    assert(c.status === 423, `Newsletter-Formular bei gesperrtem Tresor: HTTP ${c.status} statt 423`);
    const cnt = await db(`SELECT (SELECT count(*) FROM "Company") || '/' || (SELECT count(*) FROM "Consent")`);
    assert(cnt.out === '1/1', `Zeilen nach abgewiesenen Formularen (Company/Consent): ${cnt.out}`);
  }, { timeoutMs: 200_000 });

  await s.step('(5b) falsche Passphrase und falscher Wiederherstellungsschlüssel werden abgelehnt (401), Tresor bleibt gesperrt', async () => {
    const wrong = await sess.api('POST', '/api/vault/unlock', { secret: `${st.passphrase}-falsch` });
    assert(wrong.status === 401, `falsche Passphrase: HTTP ${wrong.status} statt 401 (${bodyText(wrong).slice(0, 160)})`);
    assert(bodyText(wrong).includes('vault_wrong_secret'), `Fehlercode: ${bodyText(wrong).slice(0, 160)}`);
    // Erstes Zeichen: das letzte Base32-Zeichen eines 256-Bit-Schlüssels trägt nur 1 Bit, ein Wechsel wäre oft wirkungslos.
    const flipped = st.recoveryKey.replace(/^[A-Za-z2-7]/, (c) => (c.toLowerCase() === 'a' ? 'B' : 'A'));
    assert(flipped !== st.recoveryKey, 'konnte den Wiederherstellungsschlüssel nicht abwandeln');
    const wrongKey = await sess.api('POST', '/api/vault/unlock', { secret: flipped });
    assert(wrongKey.status === 401, `falscher Schlüssel: HTTP ${wrongKey.status} statt 401`);
    const v = await jget('/api/vault/status');
    assert(v.body?.state === 'locked', `Zustand nach Fehlversuchen: ${JSON.stringify(v.body)}`);
    const c = await get('/api/companies');
    assert(c.status === 423, `GET /api/companies nach Fehlversuchen: HTTP ${c.status}`);
  });

  await s.step('(5c) Wiederherstellungsschlüssel entsperrt; Organisation, Notiz und Mailverlauf sind wieder im Klartext lesbar', async () => {
    const u = await sess.api('POST', '/api/vault/unlock', { secret: st.recoveryKey });
    expectOk(u, 'unlock mit Wiederherstellungsschlüssel');
    assert(u.body?.state === 'unlocked', `Antwort: ${JSON.stringify(u.body)}`);
    const h = await jget('/api/health');
    assert(h.body?.status === 'unlocked', `health nach Entsperren: ${JSON.stringify(h.body)}`);
    const c = await get(`/api/companies/${st.companyId}`);
    expectOk(c, 'GET company');
    assert(c.body.name === ORG.name && c.body.contactEmail === ORG.contactEmail && c.body.city === ORG.city, 'Stammdaten nach Entsperren nicht lesbar');
    const n = await get(`/api/notes?companyId=${st.companyId}`);
    expectOk(n, 'GET notes');
    assert((n.body.notes ?? []).some((x) => x.text === NOTE_TEXT), 'Notiztext nach Entsperren nicht lesbar');
    const inv = await get(`/api/invoices/${st.invoiceId}`);
    expectOk(inv, 'GET invoice');
    assert(inv.body.invoiceNumber === st.invoiceNumber, 'Rechnungsnummer weicht ab');
    assert(JSON.stringify(inv.body).includes(ORG.name), 'Empfängername fehlt in der Rechnung');
  });

  // ======================================================================= (5d) Suche, Dublette, Consent
  await s.step('(5d) Suche nach Namensteil und Ansprechperson findet die Organisation (im Speicher über entschlüsselte Liste)', async () => {
    for (const term of ['quellenho', 'ZEBRAFINK', 'brombeer', 'wiesenbrunn']) {
      const r = await get(`/api/companies?search=${encodeURIComponent(term)}`);
      expectOk(r, `Suche "${term}"`);
      assert((r.body.companies ?? []).some((x) => x.id === st.companyId), `Suche "${term}" findet die Organisation nicht (${r.body.total} Treffer)`);
    }
    const none = await get(`/api/companies?search=${encodeURIComponent('gibtesnicht')}`);
    expectOk(none, 'Suche ohne Treffer');
    assert((none.body.companies ?? []).length === 0, 'Suche nach Unsinn liefert Treffer');
  });

  await s.step('(5e) Dublettenprüfung über Blind-Index: Anfrage mit derselben Adresse (anders geschrieben) legt keine zweite Organisation an', async () => {
    const before = await db(`SELECT (SELECT count(*) FROM "Company") || '/' || (SELECT count(*) FROM "Note")`);
    const variant = ` ${ORG.contactEmail.toUpperCase()}`.trim();
    const r = await publicPost('/api/public/inquiry', { inquiryKind: 'demo', email: variant, message: 'Bitte um Rückruf, Dublettentest.' });
    assert(r.status === 200, `POST inquiry: HTTP ${r.status} ${JSON.stringify(r.body).slice(0, 200)}`);
    const after = await waitFor(async () => {
      const x = await db(`SELECT (SELECT count(*) FROM "Company") || '/' || (SELECT count(*) FROM "Note")`);
      return x.out !== before.out ? x.out : null;
    }, { timeoutMs: 20_000, label: 'neue Notiz zur Anfrage' });
    const [cb, nb] = before.out.split('/').map(Number);
    const [ca, na] = after.split('/').map(Number);
    assert(ca === cb, `Dublette nicht erkannt: Organisationen ${cb} -> ${ca}`);
    assert(na > nb, `keine Notiz an der bestehenden Organisation: ${nb} -> ${na}`);
    const idx = await db(`SELECT count(DISTINCT "contactEmailIdx") FROM "Company"`);
    assert(idx.out === '1', `Blind-Index-Werte: ${idx.out}`);
  });

  await s.step('(5f) Einwilligung über Blind-Index: dieselbe Adresse (Großschreibung) bleibt EINE Zeile; manuelle Sperre findet sie', async () => {
    const dup = await publicPost('/api/consent/subscription', { email: CONSENT_EMAIL.toUpperCase(), formText: CONSENT_TEXT, origin: 'e2e-vault' });
    assert(dup.status === 200, `zweite Eintragung: HTTP ${dup.status}`);
    await sleep(1500);
    const cnt = await db(`SELECT count(*) FROM "Consent"`);
    assert(cnt.out === '1', `Consent-Zeilen nach zweiter Eintragung: ${cnt.out} (Eindeutigkeit über emailIdx)`);
    const blocked = await prot('POST', '/api/consent/block', {
      email: CONSENT_EMAIL.toUpperCase(), reason: 'unsubscribed', justification: 'E2E-Test: Widerspruch per Brief eingegangen.',
    });
    expectOk(blocked, 'POST /api/consent/block');
    const after = await db(`SELECT status, count(*) OVER () FROM "Consent"`);
    const [status, total] = after.out.split('|');
    assert(total === '1', `Consent-Zeilen nach Sperre: ${total}`);
    assert(status !== st.consentStatusBefore, `Status unverändert (${status}): die Sperre fand die verschlüsselte Adresse nicht`);
    const rep = await columnReport('Consent', COLS.Consent);
    assertEncrypted('Consent (nach Sperre)', rep, colsOf(COLS.Consent), [...COLS.Consent.required, 'blockReason']);
  });

  // ======================================================================= (6) Integrität und GoBD
  await s.step('(6a) Integritätslauf ok, Dokument nach dem Entsperren bitgleich (SHA-256 wie vor dem Neustart)', async () => {
    const r = await get(`/api/invoices/${st.invoiceId}/integrity`);
    expectOk(r, 'integrity');
    assert(r.body.ok === true || r.body.valid === true || r.body.status === 'ok', `Integrität nicht ok: ${JSON.stringify(r.body).slice(0, 300)}`);
    const pdf = await sess.api('GET', `/api/invoices/${st.invoiceId}/document`, undefined, { raw: true });
    assert(pdf.status === 200, `GET document: HTTP ${pdf.status}`);
    assert(sha256(pdf.body) === st.pdfSha, 'PDF nach dem Neustart weicht vom Dokument davor ab');
    const row = await db(`SELECT "pdfSha256" FROM "Invoice" WHERE id='${st.invoiceId}'`);
    assert(row.out === st.pdfSha, 'pdfSha256 der DB weicht ab');
    const trig = await db(`UPDATE "Invoice" SET "invoiceNumber" = 'X-1' WHERE id='${st.invoiceId}'`, { allowFail: true });
    assert(trig.code !== 0, 'festgeschriebene Rechnung ließ sich per SQL ändern (Trigger)');
  });

  await s.step('(6b) GoBD-Export: ZIP entpacken, sha256sum -c hashes.sha256 ohne Abweichung', async () => {
    const res = await prot('POST', '/api/invoices/export/gobd', { from: `${new Date().getUTCFullYear()}-01-01`, to: today() }, { raw: true });
    assert(res.status === 200, `GoBD-Export: HTTP ${res.status} ${res.body.toString().slice(0, 200)}`);
    assert(res.body.subarray(0, 2).toString() === 'PK', 'Export ist kein ZIP');
    const zip = join(OUT, 'gobd-export.zip');
    writeFileSync(zip, res.body);
    const dir = join(OUT, 'gobd-export');
    rmSync(dir, { recursive: true, force: true });
    mkdirSync(dir, { recursive: true });
    await run('unzip', ['-oq', zip, '-d', dir]);
    const files = readdirSync(dir, { recursive: true });
    assert(files.includes('hashes.sha256'), `hashes.sha256 fehlt (${files.slice(0, 8).join(', ')})`);
    let chk;
    try {
      chk = await run('sha256sum', ['-c', 'hashes.sha256'], { cwd: dir, allowFail: true });
    } catch {
      chk = await run('shasum', ['-a', '256', '-c', 'hashes.sha256'], { cwd: dir, allowFail: true });
    }
    writeFileSync(join(OUT, 'gobd-checksum.txt'), `${chk.stdout}\n${chk.stderr}`);
    assert(chk.code === 0, `Prüfsummen: ${(chk.stdout + chk.stderr).slice(0, 300)}`);
    const okLines = chk.stdout.split('\n').filter((l) => /: OK$/.test(l)).length;
    assert(okLines >= 2, `nur ${okLines} geprüfte Dateien`);
    const pdfFiles = files.filter((f) => /\.pdf$/i.test(String(f)));
    assert(pdfFiles.length >= 1, 'kein PDF im Export');
    const exported = readFileSync(join(dir, String(pdfFiles[0])));
    assert(exported.subarray(0, 4).toString() === '%PDF', 'exportiertes PDF ist nicht entschlüsselt (kein %PDF)');
    assert(sha256(exported) === st.pdfSha, 'exportiertes PDF weicht vom ausgelieferten Dokument ab');
    note(`GoBD-Export: ${okLines} Dateien mit Prüfsumme OK, PDF im Klartext und hashgleich`);
  }, { timeoutMs: 180_000 });

  // ======================================================================= (7) Passphrase nach zweitem Neustart
  await s.step('(7) zweiter Neustart: gesperrt (423); die Passphrase entsperrt; Daten wieder lesbar', async () => {
    await ctl.restart();
    await ensureSession();
    const locked = await get('/api/companies');
    assert(locked.status === 423, `GET /api/companies nach zweitem Neustart: HTTP ${locked.status} statt 423`);
    const u = await sess.api('POST', '/api/vault/unlock', { secret: st.passphrase });
    expectOk(u, 'unlock mit Passphrase');
    const c = await get(`/api/companies/${st.companyId}`);
    expectOk(c, 'GET company');
    assert(c.body.name === ORG.name, 'Name nach Passphrase-Entsperrung nicht lesbar');
    const integ = await get(`/api/invoices/${st.invoiceId}/integrity`);
    expectOk(integ, 'integrity');
  }, { timeoutMs: 200_000 });
} finally {
  try {
    if (notes.length) writeFileSync(join(OUT, 'notes.json'), JSON.stringify(notes, null, 2));
  } catch { /* egal */ }
  if (ctl) await ctl.stop().catch(() => {});
  if (process.env.E2E_KEEP_CONTAINERS !== '1') {
    await docker(['rm', '-f', C_RENDERER, C_MAILPIT], { allowFail: true });
  }
  s.finish();
}
