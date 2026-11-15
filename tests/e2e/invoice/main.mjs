// Suite "invoice": Echttest der Rechnungserzeugung (ZUGFeRD + XRechnung), Validatoren, Mailversand.
// Aufbau: Rechnungsdienst (gehärtet, 127.0.0.1:18080), Mailpit (SMTP 11025, API 18025), Control-API (13002).
// Der Aussteller kommt NICHT mehr aus dem Manifest, sondern per PUT /api/settings/issuer (Einstellungen -> Firmendaten):
//  - Matrix: für jede Rechtsform unvollständig (422 issuer_incomplete mit genauer Feldliste) und vollständig
//    (festgeschrieben, PDF/XML enthalten alle Pflichtzeilen, Name/Anschrift nicht doppelt);
//  - Design: Logo, Akzentfarbe (auch abgelehnte Werte), öffentliche Konfiguration;
//  - Ergebnisdateien in ${E2E_OUT}/invoice/ (ZUGFeRD-PDF, XRechnung-XML, Vorschau-PNG je Hauptrechnung).
// Alle Fixtures sind frei erfunden (example.com, Musterstadt); Docker-Ressourcen tragen e2e=true und e2e.suite=invoice.
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startControl, makeClient, ROOT } from '../lib/control.mjs';
import { docker, run, waitHealthy } from '../lib/docker.mjs';
import { createSuite, assert, E2E_OUT, waitFor, sleep } from '../lib/util.mjs';
import {
  mailpit, sqlClient, extractAttachedXml, sha256, today, monthRange, pacer, pdfHasColor, pdfImageObjects,
  normText, countOf, xmlUnescape,
} from './helpers.mjs';
import { FORMS, brokenProfile, makeLogoPng, JPEG_BYTES, spacedIban } from './fixtures.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const SUITE = 'invoice';
const s = createSuite(SUITE, { stepTimeoutMs: 180_000 });
const OUT = join(E2E_OUT, SUITE);
const TOOLS = join(E2E_OUT, 'tools');
mkdirSync(OUT, { recursive: true });
mkdirSync(TOOLS, { recursive: true });
mkdirSync(join(OUT, 'formen'), { recursive: true });
mkdirSync(join(OUT, 'design'), { recursive: true });

// ---- Festlegungen -----------------------------------------------------------------------------
const PORT_RENDERER = 18080;
const PORT_SMTP = 11025;
const PORT_MAILPIT = 18025;
const PORT_CONTROL = Number(process.env.E2E_INVOICE_CONTROL_PORT) || 13002;
const PORT_CONTROL_PLACEHOLDER = Number(process.env.E2E_INVOICE_CONTROL_PORT_PH) || 13003;
// run.sh/cleanup erlauben nur Datenbanken e2e_* (siehe lib/control.mjs); control_e2e_invoice -> e2e_invoice.
const DB = 'e2e_invoice';
const DB_PH = 'e2e_invoice_ph';
const DB_CONTAINER = process.env.E2E_DB_CONTAINER || 'si-test-db';
const C_RENDERER = 'e2e-invoice-renderer';
const C_MAILPIT = 'e2e-invoice-mailpit';
const RENDERER_IMAGE = 'si-e2e-invoice-renderer';
const MAILPIT_IMAGE = 'axllent/mailpit:latest';
const KOSIT_JAR_VERSION = '1.6.3';
const KOSIT_CONF_VERSION = 'v2026-08-31';
const KOSIT_JAR_URL = `https://github.com/itplr-kosit/validator/releases/download/v${KOSIT_JAR_VERSION}/validator-${KOSIT_JAR_VERSION}-standalone.jar`;
const KOSIT_CONF_URL = `https://github.com/itplr-kosit/validator-configuration-xrechnung/releases/download/${KOSIT_CONF_VERSION}/xrechnung-3.0.2-validator-configuration-2026-08-31.zip`;
const INQUIRY_KEY = 'e2e-inquiry-key-0123456789abcdef';
// Jede Ressource dieser Suite trägt beide Labels: run.sh räumt nur die eigene Suite ab (E2E_CLEAN_SUITE).
const SUITE_LABELS = ['--label', 'e2e=true', '--label', `e2e.suite=${SUITE}`];
const ACCENT = '#0B5C8A';
const KG = FORMS.find((f) => f.key === 'gmbh-co-kg');
const GMBH = FORMS.find((f) => f.key === 'gmbh');

// Das Manifest trägt nur noch Produkt, Mail und Aufbewahrung; der Aussteller kommt aus den Firmendaten.
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

const PRICES = {
  taxRatePercent: 19,
  paymentTermDays: 14,
  averageDays: 30,
  currency: 'EUR',
  tiers: [
    { key: 'klein', label: 'Klein (bis 10 Personen)', maxPersons: 10, monthlyCent: 4900, halfYearlyCent: 26950, yearlyCent: 53900, setupCent: 9900 },
    { key: 'mittel', label: 'Mittel (bis 50 Personen)', maxPersons: 50, monthlyCent: 9900, halfYearlyCent: 54450, yearlyCent: 108900, setupCent: 9900 },
    { key: 'gross', label: 'Groß (ab 51 Personen)', maxPersons: null, monthlyCent: 19900, halfYearlyCent: 109450, yearlyCent: 218900, setupCent: 9900 },
  ],
};

// ---- Zustand ----------------------------------------------------------------------------------
const ctx = {
  notes: [], // für Bericht: Versionen, Fallbacks, Produktfunde
  productFindings: [],
};
const note = (t) => { ctx.notes.push(t); console.log(`HINWEIS ${t}`); };
const finding = (t) => { ctx.productFindings.push(t); console.log(`PRODUKTFUND ${t}`); };
const writeOut = (name, data) => { writeFileSync(join(OUT, name), data); return join(OUT, name); };

let ctl; let ctlPh; let api; let proof; let db; let mp;
const inv = {}; // key -> { companyId, id, number, pdf, xml, xr, label }
ctx.docs = []; // Dokumente für die Textprüfung: { id, rel, fx, number, recipient, images, ... }
ctx.pdfs = []; // alle erzeugten PDFs (Pfad relativ zu OUT) für veraPDF

const expectOk = (r, what) => assert(r.ok, `${what}: HTTP ${r.status} ${JSON.stringify(r.body).slice(0, 300)}`);

// ---- Zweiter Faktor: Sitzung frisch halten statt bei jedem Aufruf einen TOTP-Code zu verbrauchen -----------
// Die Control-API verlangt den Nachweis nur, wenn die Anmeldung älter als 10 Minuten ist (FRESH_SESSION_MS). Wer
// frisch angemeldet ist, schickt keinen Code; ein roher Datei-Upload (Logo) KANN keinen im Body mitschicken. Nach
// 7 Minuten wird neu angemeldet (ein TOTP-Schritt). Fällt die Abkürzung aus (401/403), geht es mit Nachweis weiter.
const SESSION_FRESH_MS = 7 * 60_000;
let sessionAt = 0;
async function relogin() {
  for (let attempt = 0; ; attempt++) {
    try {
      const sess = await ctl.login();
      api = sess.api; proof = sess.proof; sessionAt = Date.now();
      return;
    } catch (e) {
      if (attempt >= 1) throw e;
      await sleep(31_000); // der TOTP-Schritt war schon verbraucht: ins nächste Fenster
    }
  }
}
async function prot(method, path, body, opts) {
  if (Date.now() - sessionAt > SESSION_FRESH_MS) await relogin();
  let r;
  for (let attempt = 0; attempt < 4; attempt++) {
    r = await api(method, path, body, opts);
    if (r.status !== 429) break;
    await sleep((Number(r.headers?.get?.('retry-after')) || 15) * 1000 + 500);
  }
  const plain = body && typeof body === 'object' && !(body instanceof Uint8Array);
  if ((r.status === 401 || r.status === 403) && plain && !('totpCode' in body)) {
    r = await api(method, path, { ...body, ...(await proof()) }, opts);
  }
  return r;
}
/** Die Routen erlauben 10 Aufrufe je Minute; wir bleiben darunter und warten nur, wenn es nötig ist. */
const pace = pacer({ limit: 9, windowMs: 60_000 });

/** Firmendaten speichern (Entwurf: auch unvollständig erlaubt). */
async function setIssuer(profile, accentColor = null) {
  await pace('issuer-put');
  return prot('PUT', '/api/settings/issuer', { profile, accentColor });
}
async function finalizeInv(id) {
  await pace('finalize');
  return prot('POST', `/api/invoices/${id}/finalize`, { confirmation: 'festschreiben' });
}
const fetchDoc = (path) => api('GET', path, undefined, { raw: true });
const fieldMap = (issues) => Object.fromEntries((issues ?? []).map((i) => [i.field, i.code]));
const sameMap = (a, b) => JSON.stringify(Object.entries(a).sort()) === JSON.stringify(Object.entries(b).sort());
const PLAIN_LINE = { label: 'Demo Software – Nutzung', description: 'Monatliche Nutzung', quantity: 1, unitPriceNetCent: 4900, taxRate: 19, unit: 'MON' };

const containerPort = (name, hostPort, containerPortNr, extra = []) =>
  ['run', '-d', '--name', name, ...SUITE_LABELS, '-p', `127.0.0.1:${hostPort}:${containerPortNr}`, ...extra];

try {
  // ======================================================================= Infrastruktur
  await s.step('Rechnungsdienst-Image bauen (tools/invoice-renderer)', async () => {
    // IMMER bauen: Der Docker-Schichtcache macht einen unveränderten Bau billig, ein
    // veraltetes Image (ohne Schrift Inter) dagegen ließ den Lauf still mit DejaVu rendern.
    await docker(['build', '-t', RENDERER_IMAGE, join(ROOT, 'tools', 'invoice-renderer')], { timeoutMs: 1_200_000 });
  }, { timeoutMs: 1_300_000 });

  await s.step('Rechnungsdienst gehärtet starten (read-only, tmpfs, cap_drop ALL, no-new-privileges, 127.0.0.1:18080)', async () => {
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
    const insp = await docker(['inspect', '-f', '{{.HostConfig.ReadonlyRootfs}} {{.HostConfig.CapDrop}} {{.HostConfig.SecurityOpt}}', C_RENDERER]);
    note(`Rechnungsdienst-Härtung (inspect): ${insp.stdout.trim()}`);
    assert(insp.stdout.startsWith('true'), 'Rechnungsdienst läuft nicht read-only');
  }, { timeoutMs: 200_000 });

  await s.step('Mailpit starten (SMTP 11025, API 18025)', async () => {
    await docker(['rm', '-f', C_MAILPIT], { allowFail: true });
    await docker([
      'run', '-d', '--name', C_MAILPIT, ...SUITE_LABELS,
      '-p', `127.0.0.1:${PORT_SMTP}:1025`, '-p', `127.0.0.1:${PORT_MAILPIT}:8025`, MAILPIT_IMAGE,
    ], { timeoutMs: 300_000 });
    mp = mailpit(`http://127.0.0.1:${PORT_MAILPIT}`);
    await waitFor(async () => (await fetch(`http://127.0.0.1:${PORT_MAILPIT}/livez`).catch(() => null))?.ok, { timeoutMs: 60_000, label: 'Mailpit' });
    await mp.clear();
  }, { timeoutMs: 330_000 });

  await s.step('Control-API starten (Manifest ohne Aussteller, Renderer, SMTP -> Mailpit)', async () => {
    writeOut('manifest.e2e.yaml', MANIFEST);
    ctl = await startControl({
      port: PORT_CONTROL, dbName: DB, suite: SUITE,
      env: {
        MANIFEST_PATH: join(OUT, 'manifest.e2e.yaml'),
        RECHNUNGSDIENST_URL: `http://127.0.0.1:${PORT_RENDERER}`,
        SMTP_HOST: '127.0.0.1', SMTP_PORT: String(PORT_SMTP), SMTP_TLS_ERZWINGEN: '0',
        SMTP_FROM: 'Demo Software <noreply@example.com>',
        MAIL_DOMAIN: 'example.com',
        CONTROL_INQUIRY_KEY: INQUIRY_KEY,
      },
    });
    db = sqlClient({ container: DB_CONTAINER, dbName: DB });
    const sess = await ctl.login();
    api = sess.api; proof = sess.proof; sessionAt = Date.now();
    const pc = await fetch(`${ctl.url}/api/public-config`).then((r) => r.json());
    note(`public-config: ${JSON.stringify(pc)}`);
    assert(pc.accentColor === null && pc.hasLogo === false, `public-config ohne Firmendaten: ${JSON.stringify(pc)}`);
  }, { timeoutMs: 600_000 });
  if (!ctl) throw new Error('Control nicht gestartet – Abbruch der Suite');

  await s.step('PDF-Textwerkzeug bereitstellen (PDFBox aus dem Rechnungsdienst-Image, Quelltext PdfText.java)', async () => {
    const jar = join(TOOLS, 'mustang-cli.jar');
    if (!existsSync(jar)) await docker(['cp', `${C_RENDERER}:/opt/mustang-cli.jar`, jar]);
    assert(existsSync(jar), 'mustang-cli.jar nicht aus dem Rechnungsdienst-Image kopiert');
  });

  // ======================================================================= (1) Preise
  await s.step('(1) Preisliste per Admin-API setzen (PUT mit Nachweis) und per GET prüfen', async () => {
    const put = await prot('PUT', '/api/settings/prices', PRICES);
    expectOk(put, 'PUT /api/settings/prices');
    const got = await api('GET', '/api/settings/prices');
    expectOk(got, 'GET /api/settings/prices');
    assert(got.body.taxRatePercent === 19, `Steuersatz ${got.body.taxRatePercent}`);
    const active = got.body.tiers.filter((t) => !t.archived);
    assert(active.length === 3, `aktive Stufen: ${active.length}`);
    for (const t of PRICES.tiers) {
      const g = active.find((x) => x.key === t.key);
      assert(g && g.monthlyCent === t.monthlyCent && g.setupCent === t.setupCent && g.maxPersons === t.maxPersons, `Stufe ${t.key} weicht ab`);
    }
    // Eine unstimmige Liste (zwei offene Stufen) wird abgelehnt
    const bad = await prot('PUT', '/api/settings/prices', {
      ...PRICES, tiers: [{ ...PRICES.tiers[0], maxPersons: null }, { ...PRICES.tiers[1], maxPersons: null }],
    });
    assert(bad.status === 400, `unstimmige Preisliste: HTTP ${bad.status} statt 400`);
    const audit = await db(`SELECT count(*) FROM "AuditLog" WHERE action LIKE 'price%'`);
    assert(Number(audit.out) >= 1, 'kein Audit-Eintrag zur Preisänderung');
  });

  // ======================================================================= (2) Kunden
  // Der Empfängerort ist NICHT der Ort des Ausstellers, damit "PLZ Ort" des Ausstellers im PDF genau einmal vorkommen darf.
  const addrBehoerde = { street: 'Amtsstraße', houseNumber: '5', postalCode: '88888', city: 'Mustertal', country: 'DE' };
  const mkCompany = (extra) => ({ legalForm: 'Körperschaft', ...extra });
  await s.step('(2) Kunden anlegen: Behörde (Leitweg-ID) und Handels GmbH (USt-IdNr.)', async () => {
    const b = await api('POST', '/api/companies', mkCompany({
      name: 'Beispiel Behörde', buyerType: 'authority', buyerReference: '04011000-12345-67',
      billingEmail: 'rechnung@behoerde.example.com', contactName: 'Hans Beispiel', contactEmail: 'kontakt@behoerde.example.com',
      ...addrBehoerde, paymentInterval: 'yearly', paymentMethod: 'bank_transfer',
    }));
    expectOk(b, 'POST /api/companies (Behörde)');
    inv.b = { companyId: b.body.id, label: 'gmbh-co-kg-behoerde', fx: KG, recipient: 'Beispiel Behörde' };
    const h = await api('POST', '/api/companies', mkCompany({
      name: 'Beispiel Handels GmbH', buyerType: 'business', vatId: 'DE987654321',
      billingEmail: 'rechnung@handels.example.com', contactName: 'Petra Beispiel', contactEmail: 'kontakt@handels.example.com',
      street: 'Handelsweg', houseNumber: '12', postalCode: '88888', city: 'Mustertal', country: 'DE',
      paymentInterval: 'yearly', paymentMethod: 'bank_transfer',
    }));
    expectOk(h, 'POST /api/companies (Handels GmbH)');
    inv.h = { companyId: h.body.id, label: 'gmbh-unternehmen', fx: GMBH, recipient: 'Beispiel Handels GmbH' };
    const nl = await api('POST', '/api/companies', mkCompany({
      name: 'Beispiel Behörde ohne Leitweg', buyerType: 'authority', billingEmail: 'x@behoerde.example.com',
      contactName: 'N N', contactEmail: 'n@behoerde.example.com', ...addrBehoerde, paymentInterval: 'yearly', paymentMethod: 'bank_transfer',
    }));
    expectOk(nl, 'POST /api/companies (Behörde ohne Leitweg-ID)');
    inv.nl = { companyId: nl.body.id };
    assert(b.body.buyerType === 'authority' && b.body.buyerReference === '04011000-12345-67', 'buyerType/buyerReference nicht übernommen');
    assert(h.body.vatId === 'DE987654321', 'vatId nicht übernommen');
  });

  await s.step('(2b) Testdaten für den Preisvorschlag: Instanz + Messwerte je Kunde (Fixture per SQL)', async () => {
    // Behörde: 8 aktive Personen -> Stufe klein; Handels GmbH: 30 -> Stufe mittel.
    for (const [key, sub, persons] of [['b', 'behoerde', 8], ['h', 'handels', 30]]) {
      const id = inv[key].companyId;
      const r1 = await db(`INSERT INTO "Instance" (id, "companyId", subdomain) VALUES (gen_random_uuid(), '${id}', '${sub}') RETURNING id`);
      const instId = r1.out.split('\n')[0];
      await db(
        `INSERT INTO "Metric" (id, "instanceId", date, "activePersons", "fetchSuccessful") ` +
        `SELECT gen_random_uuid(), '${instId}', d::date, ${persons}, true FROM generate_series(current_date - 29, current_date, '1 day') d`,
      );
      const start = new Date(Date.now() - 120 * 86400_000).toISOString().slice(0, 10);
      const p = await api('PATCH', `/api/companies/${id}`, { instanceStartDate: start });
      expectOk(p, 'PATCH instanceStartDate');
    }
  });

  // ======================================================================= (3) Rechnungen
  const period = monthRange();
  async function makeDraftFromSuggestion(key, labelPrefix) {
    const id = inv[key].companyId;
    const sug = await api('GET', `/api/companies/${id}/price-suggestion`);
    expectOk(sug, 'price-suggestion');
    assert(sug.body.tier, `kein Stufenvorschlag (blockers ${JSON.stringify(sug.body.blockers)})`);
    const tier = sug.body.tier;
    const draft = await api('POST', `/api/companies/${id}/invoices`, {
      invoiceDate: today(), servicePeriodFrom: period.from, servicePeriodUntil: period.until,
      introduction: 'Vielen Dank für Ihr Vertrauen. Wir berechnen Ihnen für den Leistungszeitraum:',
      lines: [{
        label: `${labelPrefix} – ${tier.label}`, description: 'Monatliche Nutzung', quantity: 1,
        unitPriceNetCent: tier.monthlyCent, taxRate: 19, unit: 'MON', priceTierKey: tier.key,
      }],
    });
    expectOk(draft, 'Entwurf anlegen');
    return { tier, draft: draft.body };
  }

  await s.step('(3a) Behörde: Entwurf mit Preisvorschlag -> Posten übernimmt priceTierKey/Preis', async () => {
    const { tier, draft } = await makeDraftFromSuggestion('b', 'Demo Software');
    assert(tier.key === 'klein', `Vorschlag Stufe ${tier.key} (erwartet klein)`);
    inv.b.id = draft.id;
    assert(draft.invoiceNumber === null, 'Entwurf hat schon eine Nummer');
    const line = draft.lines[0];
    assert(line.priceTierKey === 'klein', `Posten priceTierKey = ${line.priceTierKey}`);
    assert(line.priceTierLabel, 'priceTierLabel fehlt am Posten');
    assert(line.unitPriceNet === '49.00', `Posten-Preis ${line.unitPriceNet} (erwartet 49.00)`);
  });
  await s.step('(3b) Handels GmbH: Entwurf mit Preisvorschlag -> Stufe mittel', async () => {
    const { tier, draft } = await makeDraftFromSuggestion('h', 'Demo Software');
    assert(tier.key === 'mittel', `Vorschlag Stufe ${tier.key} (erwartet mittel)`);
    inv.h.id = draft.id;
    assert(draft.lines[0].priceTierKey === 'mittel', 'priceTierKey nicht übernommen');
  });

  await s.step('(3c0) Firmendaten ab Werk sind Platzhalter: Festschreiben verweigert (invoice_issuer_placeholder); danach GmbH & Co. KG setzen', async () => {
    const first = await api('GET', '/api/settings/issuer');
    expectOk(first, 'GET /api/settings/issuer');
    const r0 = await finalizeInv(inv.b.id);
    assert(r0.status === 422, `Platzhalter-Firmendaten: HTTP ${r0.status} statt 422`);
    assert(r0.body?.error?.code === 'invoice_issuer_placeholder', `Fehlercode ${r0.body?.error?.code}`);
    const put = await setIssuer(KG.profile);
    expectOk(put, 'PUT /api/settings/issuer (GmbH & Co. KG)');
    assert(put.body.missing.length === 0, `Pflichtangaben der KG unvollständig: ${JSON.stringify(put.body.missing)}`);
    assert(put.body.profile.name === KG.profile.name, 'Firmenname nicht gespeichert');
    const back = await api('GET', '/api/settings/issuer');
    assert(back.body.profile.generalPartner.name === KG.profile.generalPartner.name, 'Komplementärin nicht gespeichert');
    const audit = await db(`SELECT count(*) FROM "AuditLog" WHERE action LIKE 'issuer%'`);
    assert(Number(audit.out) >= 1, 'kein Audit-Eintrag zu den Firmendaten');
  });

  await s.step('(3c) Behörde ohne Leitweg-ID: Festschreiben scheitert vorab (keine Nummer verbrannt)', async () => {
    const { draft } = await makeDraftFromSuggestionNoTier();
    const r = await finalizeInv(draft.id);
    assert(!r.ok && r.status >= 400 && r.status < 500, `erwartet 4xx, bekam ${r.status}`);
    note(`Behörde ohne Leitweg-ID: HTTP ${r.status} ${JSON.stringify(r.body).slice(0, 200)}`);
    const d = await api('GET', `/api/invoices/${draft.id}`);
    assert(d.body.invoiceNumber === null, 'Nummer wurde trotz Ablehnung vergeben');
  });
  async function makeDraftFromSuggestionNoTier() {
    const draft = await api('POST', `/api/companies/${inv.nl.companyId}/invoices`, {
      invoiceDate: today(), servicePeriodFrom: period.from, servicePeriodUntil: period.until,
      lines: [{ label: 'Demo Software – Nutzung', quantity: 1, unitPriceNetCent: 4900, taxRate: 19, unit: 'MON' }],
    });
    expectOk(draft, 'Entwurf (ohne Leitweg)');
    return { draft: draft.body };
  }

  await s.step('(3d) Festschreiben mit den Firmendaten je Rechtsform (b: GmbH & Co. KG, h: GmbH): Nummer, retentionUntil, Dokumente sofort erzeugt', async () => {
    for (const key of ['b', 'h']) {
      // Die Dokumente entstehen beim ersten Abruf aus dem AKTUELLEN Profil (Logo, Pflichtzeilen). Darum: Profil
      // setzen, festschreiben und die Dokumente SOFORT erzeugen, bevor das Profil der nächsten Rechtsform gilt.
      const put = await setIssuer(inv[key].fx.profile);
      expectOk(put, `PUT /api/settings/issuer (${inv[key].fx.key})`);
      const r = await finalizeInv(inv[key].id);
      expectOk(r, `Festschreiben ${key}`);
      assert(/^\d{4}-\d+/.test(r.body.invoiceNumber ?? ''), `Nummer ${r.body.invoiceNumber}`);
      assert(r.body.finalizedAt, 'finalizedAt fehlt');
      assert(r.body.retentionUntil, 'retentionUntil fehlt');
      inv[key].number = r.body.invoiceNumber;
      inv[key].retentionUntil = r.body.retentionUntil;
      inv[key].gross = r.body.grossAmount ?? r.body.total ?? null;
      for (const kind of ['document', 'xml', 'xrechnung']) {
        const d = await fetchDoc(`/api/invoices/${inv[key].id}/${kind}`);
        assert(d.status === 200, `GET ${kind} ${key}: HTTP ${d.status} ${d.body.toString().slice(0, 300)}`);
      }
    }
    const y = new Date().getUTCFullYear();
    assert(String(inv.b.retentionUntil).startsWith(String(y + 8)), `retentionUntil ${inv.b.retentionUntil} (erwartet ${y + 8}-12-31)`);
    note(`Nummern: ${inv.b.number} (GmbH & Co. KG an Behörde), ${inv.h.number} (GmbH an Unternehmenskunde); retentionUntil ${inv.b.retentionUntil}`);
  }, { timeoutMs: 400_000 });

  await s.step('(3e) Platzhalter-Aussteller (zweite Control-Instanz ohne Manifest) wird verweigert', async () => {
    ctlPh = await startControl({
      port: PORT_CONTROL_PLACEHOLDER, dbName: DB_PH, suite: SUITE, build: false,
      env: {
        MANIFEST_PATH: join(OUT, 'does-not-exist.yaml'),
        RECHNUNGSDIENST_URL: `http://127.0.0.1:${PORT_RENDERER}`,
      },
    });
    const ph = await ctlPh.login();
    const c = await ph.api('POST', '/api/companies', mkCompany({
      name: 'Beispiel Platzhalter-Kunde', buyerType: 'business', billingEmail: 'p@example.com',
      contactName: 'P P', contactEmail: 'p@example.com', street: 'Weg', houseNumber: '1', postalCode: '99999', city: 'Musterstadt', country: 'DE',
      paymentInterval: 'yearly', paymentMethod: 'bank_transfer',
    }));
    expectOk(c, 'Kunde (Platzhalter-Instanz)');
    const d = await ph.api('POST', `/api/companies/${c.body.id}/invoices`, {
      invoiceDate: today(), servicePeriodFrom: period.from, servicePeriodUntil: period.until,
      lines: [{ label: 'Muster', quantity: 1, unitPriceNetCent: 1000, taxRate: 19, unit: 'MON' }],
    });
    expectOk(d, 'Entwurf (Platzhalter-Instanz)');
    // frisch angemeldet: kein zweiter Code nötig (und kein Warten auf das nächste 30-s-Fenster)
    const r = await ph.api('POST', `/api/invoices/${d.body.id}/finalize`, { confirmation: 'festschreiben' });
    assert(!r.ok && r.status >= 400 && r.status < 500, `Platzhalter-Aussteller: erwartet 4xx, bekam ${r.status}`);
    assert(r.body?.error?.code === 'invoice_issuer_placeholder', `Platzhalter-Aussteller: Fehlercode ${r.body?.error?.code} (HTTP ${r.status})`);
    note(`Platzhalter-Aussteller verweigert: HTTP ${r.status} ${JSON.stringify(r.body).slice(0, 160)}`);
    const det = await ph.api('GET', `/api/invoices/${d.body.id}`);
    assert(det.body.invoiceNumber === null, 'Nummer trotz Platzhalter-Aussteller vergeben');
  }, { timeoutMs: 400_000 });
  if (ctlPh) await ctlPh.stop().catch(() => {});

  // ======================================================================= (4) Dokumente
  await s.step('(4) Dokumente abrufen: ZUGFeRD-PDF, Factur-X-XML, XRechnung -> Dateien, PDF-Struktur, SHA-256 gegen DB', async () => {
    for (const key of ['b', 'h']) {
      const label = inv[key].label;
      const pdf = await fetchDoc(`/api/invoices/${inv[key].id}/document`);
      assert(pdf.status === 200, `GET document ${key}: HTTP ${pdf.status} ${pdf.body.toString().slice(0, 300)}`);
      const xml = await fetchDoc(`/api/invoices/${inv[key].id}/xml`);
      assert(xml.status === 200, `GET xml ${key}: HTTP ${xml.status} ${xml.body.toString().slice(0, 300)}`);
      const xr = await fetchDoc(`/api/invoices/${inv[key].id}/xrechnung`);
      assert(xr.status === 200, `GET xrechnung ${key}: HTTP ${xr.status} ${xr.body.toString().slice(0, 300)}`);
      inv[key].pdf = pdf.body; inv[key].xml = xml.body; inv[key].xr = xr.body;
      mkdirSync(join(OUT), { recursive: true });
      writeFileSync(join(OUT, `rechnung-${label}.pdf`), pdf.body);
      writeFileSync(join(OUT, `rechnung-${label}.factur-x.xml`), xml.body);
      writeFileSync(join(OUT, `rechnung-${label}.xrechnung.xml`), xr.body);
      ctx.pdfs.push(`rechnung-${label}.pdf`);
      ctx.docs.push({
        id: `rechnung-${label}`, rel: `rechnung-${label}.pdf`, fx: inv[key].fx, number: inv[key].number,
        recipient: inv[key].recipient, images: 0, leitweg: key === 'b' ? '04011000-12345-67' : null,
      });
      assert(pdf.body.subarray(0, 4).toString() === '%PDF', 'PDF beginnt nicht mit %PDF');
      assert(/<rsm:CrossIndustryInvoice|CrossIndustryInvoice/.test(xml.body.toString()), 'XML ist kein CII');
      assert(xr.body.toString().includes('xrechnung_3.0'), 'XRechnung-XML ohne Kennung xrechnung_3.0');
      assert(!xml.body.toString().includes('xrechnung_3.0'), 'Factur-X-XML trägt irrtümlich die XRechnung-Kennung');
      const att = extractAttachedXml(pdf.body);
      assert(att.nameInPdf, 'Anhangname factur-x.xml nicht im PDF gefunden');
      assert(att.xml, 'eingebettetes CII-XML nicht im PDF gefunden');
      assert(sha256(Buffer.from(att.xml, 'utf8')) === sha256(xml.body) || att.xml.trim() === xml.body.toString().trim(),
        'eingebettetes XML ist nicht identisch mit GET /xml');
      const row = await db(
        `SELECT encode(sha256("pdfContent"),'hex'), "pdfSha256", "xmlSha256", encode(sha256("xmlContent"::bytea),'hex') FROM "Invoice" WHERE id='${inv[key].id}'`,
        { allowFail: true },
      );
      assert(row.code === 0, `SQL-Hash: ${row.err.slice(0, 200)}`);
      const [calc, storedPdf, storedXml] = row.out.split('|');
      assert(sha256(pdf.body) === calc, 'SHA-256 des abgerufenen PDF != Hash der DB-Bytes');
      assert(storedPdf === calc, `gespeicherter pdfSha256 (${storedPdf}) != berechneter (${calc})`);
      assert(storedXml === sha256(xml.body), 'xmlSha256 in der DB != SHA-256 des abgerufenen XML');
      note(`${label}: PDF ${pdf.body.length} B sha256 ${sha256(pdf.body).slice(0, 16)}…, XML ${xml.body.length} B, XRechnung ${xr.body.length} B`);
    }
  });

  // ======================================================================= (M) Matrix der Rechtsformen
  async function createPlainDraft(companyId) {
    const d = await api('POST', `/api/companies/${companyId}/invoices`, {
      invoiceDate: today(), servicePeriodFrom: period.from, servicePeriodUntil: period.until,
      introduction: 'Vielen Dank für Ihr Vertrauen. Wir berechnen Ihnen für den Leistungszeitraum:',
      lines: [{ ...PLAIN_LINE }],
    });
    expectOk(d, 'Entwurf anlegen');
    return d.body;
  }
  const baseName = (rel) => rel.replace(/^.*\//, '').replace(/\.pdf$/, '');

  /** Text (PDFBox) und Bildzahl der PDFs, in einem Containerlauf. Liefert { [rel]: { text, images } }. */
  async function pdfText(rels) {
    mkdirSync(join(OUT, 'pdftext'), { recursive: true });
    const user = typeof process.getuid === 'function' ? ['--user', `${process.getuid()}:${process.getgid()}`] : [];
    const r = await docker([
      'run', '--rm', ...SUITE_LABELS, ...user, '--entrypoint', 'java',
      '-v', `${HERE}:/src:ro`, '-v', `${TOOLS}:/tools:ro`, '-v', `${OUT}:/data`, RENDERER_IMAGE,
      '-cp', '/tools/mustang-cli.jar', '/src/PdfText.java', '/data/pdftext', ...rels.map((p) => `/data/${p}`),
    ], { timeoutMs: 300_000 });
    const images = {};
    for (const m of r.stdout.matchAll(/^IMAGES (\S+) (\d+)$/gm)) images[m[1]] = Number(m[2]);
    const fonts = {};
    for (const m of r.stdout.matchAll(/^FONTS (\S+) (.*)$/gm)) fonts[m[1]] = m[2].trim();
    const out = {};
    for (const rel of rels) {
      out[rel] = { text: readFileSync(join(OUT, 'pdftext', `${baseName(rel)}.txt`), 'utf8'), images: images[baseName(rel)], fonts: fonts[baseName(rel)] ?? '' };
    }
    return out;
  }

  /** Prüft ein Dokument gegen die Firmendaten seiner Form. Liefert die Liste der Abweichungen (leer = in Ordnung). */
  function checkDocText(d, rawText, imageCount) {
    const t = normText(rawText);
    const p = d.fx.profile;
    const problems = [];
    const need = (needle, what) => { if (!t.includes(normText(needle))) problems.push(`${what} fehlt: "${needle}"`); };
    const once = (needle, what) => {
      const n = countOf(t, normText(needle));
      if (n !== 1) problems.push(`${what} steht ${n}x im PDF (erwartet genau 1x): "${needle}"`);
    };
    once(p.name, 'Firmenname');
    once(p.street, 'Straße des Ausstellers');
    once(`${p.postalCode} ${p.city}`, 'PLZ und Ort des Ausstellers');
    for (const l of d.fx.legalLines) need(l, 'Pflichtzeile');
    need(`Tel. ${p.phone}`, 'Telefon'); need(p.email, 'E-Mail'); need(p.web, 'Web');
    need(`IBAN ${spacedIban(p.iban)}`, 'IBAN'); need(p.bankName, 'Bank'); need(`BIC ${p.bic}`, 'BIC');
    need(d.recipient, 'Empfänger'); need(d.number, 'Rechnungsnummer');
    if (d.leitweg) need(d.leitweg, 'Leitweg-ID');
    if (/Verwaltung Verwaltung/i.test(t)) problems.push('"Verwaltung Verwaltung" im PDF');
    if (d.images === 'min1') {
      if (!(imageCount >= 1)) problems.push(`Logo erwartet, aber ${imageCount} Bild(er) im PDF`);
    } else if (imageCount !== d.images) problems.push(`${imageCount} Bild(er) im PDF, erwartet ${d.images}`);
    return problems;
  }

  for (const fx of FORMS) {
    await s.step(`(M) ${fx.label}: unvollständig -> 422 issuer_incomplete mit Feldliste; vollständig -> festgeschrieben, PDF/XML`, async () => {
      const draft = await createPlainDraft(inv.h.companyId);

      // (a) absichtlich unvollständig: Speichern geht (Entwurf), Festschreiben nicht
      const put1 = await setIssuer(brokenProfile(fx));
      expectOk(put1, 'PUT unvollständiges Profil');
      assert(sameMap(fieldMap(put1.body.missing), fx.expected),
        `Antwort "missing" ${JSON.stringify(fieldMap(put1.body.missing))} != erwartet ${JSON.stringify(fx.expected)}`);
      const f1 = await finalizeInv(draft.id);
      assert(f1.status === 422, `unvollständig: HTTP ${f1.status} statt 422 (${JSON.stringify(f1.body).slice(0, 200)})`);
      assert(f1.body?.error?.code === 'issuer_incomplete', `Fehlercode ${f1.body?.error?.code} statt issuer_incomplete`);
      const issues = f1.body.error.detail?.issues ?? [];
      assert(sameMap(fieldMap(issues), fx.expected), `Feldliste ${JSON.stringify(fieldMap(issues))} != erwartet ${JSON.stringify(fx.expected)}`);
      assert(issues.every((i) => typeof i.label === 'string' && i.label.length > 0), 'Feld ohne Bezeichnung in der Meldung');
      const d1 = await api('GET', `/api/invoices/${draft.id}`);
      assert(d1.body.invoiceNumber === null, `Nummer ${d1.body.invoiceNumber} trotz unvollständiger Firmendaten vergeben`);

      // (b) vollständig: dieselbe Rechnung lässt sich jetzt festschreiben
      const put2 = await setIssuer(fx.profile);
      expectOk(put2, 'PUT vollständiges Profil');
      assert(put2.body.missing.length === 0, `Profil noch unvollständig: ${JSON.stringify(put2.body.missing)}`);
      const f2 = await finalizeInv(draft.id);
      expectOk(f2, 'Festschreiben (vollständig)');
      const number = f2.body.invoiceNumber;
      assert(/^\d{4}-\d+/.test(number ?? ''), `Nummer ${number}`);

      const pdf = await fetchDoc(`/api/invoices/${draft.id}/document`);
      assert(pdf.status === 200, `GET document: HTTP ${pdf.status} ${pdf.body.toString().slice(0, 300)}`);
      const xml = await fetchDoc(`/api/invoices/${draft.id}/xml`);
      assert(xml.status === 200, `GET xml: HTTP ${xml.status}`);
      assert(pdf.body.subarray(0, 4).toString() === '%PDF', 'PDF beginnt nicht mit %PDF');
      const att = extractAttachedXml(pdf.body);
      assert(att.xml && att.xml.trim() === xml.body.toString().trim(), 'eingebettetes factur-x.xml != GET /xml');
      writeFileSync(join(OUT, 'formen', `${fx.key}.pdf`), pdf.body);
      writeFileSync(join(OUT, 'formen', `${fx.key}.factur-x.xml`), xml.body);

      // Pflichtzeilen und Stammdaten stehen auch im strukturierten Teil (BT-33 = Pflichtzeilen mit " | ")
      const x = normText(xmlUnescape(xml.body.toString('utf8')));
      const p = fx.profile;
      const lacking = [...fx.legalLines, p.name, p.street, p.city, p.iban, p.vatId || p.taxNumber]
        .filter((v) => !x.includes(normText(v)));
      assert(lacking.length === 0, `im Factur-X-XML fehlen: ${lacking.join(' | ')}`);

      if (fx.xr) {
        const xr = await fetchDoc(`/api/invoices/${draft.id}/xrechnung`);
        assert(xr.status === 200, `GET xrechnung: HTTP ${xr.status}`);
        assert(xr.body.toString().includes('xrechnung_3.0'), 'XRechnung ohne Kennung xrechnung_3.0');
        writeFileSync(join(OUT, 'formen', `${fx.key}.xrechnung.xml`), xr.body);
        (ctx.xrFiles ??= []).push({ name: `formen-${fx.key}.xrechnung.xml`, rel: `formen/${fx.key}.xrechnung.xml` });
      }
      ctx.pdfs.push(`formen/${fx.key}.pdf`);
      ctx.docs.push({ id: fx.key, rel: `formen/${fx.key}.pdf`, fx, number, recipient: inv.h.recipient, images: 0 });
    }, { timeoutMs: 480_000 });
  }

  await s.step('(M-Text) PDF-Text aller Rechnungen: alle Pflichtzeilen der Rechtsform enthalten, Firmenname/Anschrift genau einmal, kein Bild ohne Logo', async () => {
    const got = await pdfText(ctx.docs.map((d) => d.rel));
    const failures = [];
    for (const d of ctx.docs) {
      const g = got[d.rel];
      const problems = checkDocText(d, g.text, g.images);
      // Schrift: Inter muss eingebettet sein, DejaVu (Systemrückfall) darf nicht vorkommen.
      if (!/Inter/i.test(g.fonts)) problems.push(`Inter nicht eingebettet (Schriften: ${g.fonts || 'keine'})`);
      if (/DejaVu/i.test(g.fonts)) problems.push(`DejaVu im PDF (Schriften: ${g.fonts})`);
      if (problems.length) failures.push(`${d.id}: ${problems.join('; ')}`);
    }
    assert(failures.length === 0, `PDF-Text weicht ab -> ${failures.join(' || ')}`.slice(0, 1500));
    note(`PDF-Text geprüft für ${ctx.docs.length} Rechnungen (${ctx.docs.map((d) => d.id).join(', ')}); Text unter ${join(OUT, 'pdftext')}`);
  }, { timeoutMs: 360_000 });

  // ======================================================================= (D) Logo und Akzentfarbe
  const PNG = makeLogoPng();
  const publicConfig = async () => (await fetch(`${ctl.url}/api/public-config`)).json();
  /** Rechnung mit den gerade gültigen Firmendaten (GmbH) ausstellen; liefert { id, number, pdf, rel }. */
  async function issueDesignInvoice(name) {
    const draft = await createPlainDraft(inv.h.companyId);
    const f = await finalizeInv(draft.id);
    expectOk(f, `Festschreiben (${name})`);
    const pdf = await fetchDoc(`/api/invoices/${draft.id}/document`);
    assert(pdf.status === 200, `GET document (${name}): HTTP ${pdf.status}`);
    const rel = `design/${name}.pdf`;
    writeFileSync(join(OUT, rel), pdf.body);
    ctx.pdfs.push(rel);
    return { id: draft.id, number: f.body.invoiceNumber, pdf: pdf.body, rel };
  }
  const designDoc = (made, images) => ({
    id: baseName(made.rel), rel: made.rel, fx: GMBH, number: made.number, recipient: inv.h.recipient, images,
  });
  const logoOpts = { headers: { 'content-type': 'image/png' } };

  await s.step('(D1) Logo: Nicht-Bild und falscher Typ werden abgelehnt (415), PNG wird gespeichert und öffentlich ausgeliefert', async () => {
    expectOk(await setIssuer(GMBH.profile), 'PUT GmbH-Profil');
    await pace('logo');
    const notImage = await prot('POST', '/api/settings/issuer/logo', Buffer.from('das ist kein Bild'), logoOpts);
    assert(notImage.status === 415 && notImage.body?.error?.code === 'logo_invalid', `Text als PNG: HTTP ${notImage.status} ${JSON.stringify(notImage.body).slice(0, 160)}`);
    await pace('logo');
    const mismatch = await prot('POST', '/api/settings/issuer/logo', JPEG_BYTES, logoOpts);
    assert(mismatch.status === 415 && mismatch.body?.error?.code === 'logo_invalid', `JPEG als PNG deklariert: HTTP ${mismatch.status}`);
    assert((await publicConfig()).hasLogo === false, 'hasLogo nach abgelehnten Uploads true');
    await pace('logo');
    const up = await prot('POST', '/api/settings/issuer/logo', PNG, logoOpts);
    expectOk(up, 'Logo hochladen');
    const meta = up.body.logo;
    assert(meta.hasLogo === true && meta.mime === 'image/png' && meta.sha256 === sha256(PNG) && meta.sizeBytes === PNG.length,
      `Logo-Metadaten ${JSON.stringify(meta)}`);
    const pub = await fetch(`${ctl.url}/api/public/logo`);
    assert(pub.status === 200 && /^image\/png/.test(pub.headers.get('content-type') ?? ''), `GET /api/public/logo -> ${pub.status}`);
    assert(sha256(Buffer.from(await pub.arrayBuffer())) === sha256(PNG), 'ausgeliefertes Logo != hochgeladenes');
    assert((await publicConfig()).hasLogo === true, 'public-config.hasLogo nach Upload nicht true');
  }, { timeoutMs: 300_000 });

  await s.step('(D2) Rechnung mit Logo: Bild im PDF, Firmenname weiterhin genau einmal, Akzentfarbe nicht gesetzt', async () => {
    const r = await issueDesignInvoice('mit-logo');
    assert(pdfImageObjects(r.pdf) >= 1, 'kein Bild-XObject im PDF');
    const d = designDoc(r, 'min1');
    ctx.docs.push(d);
    const t = (await pdfText([r.rel]))[r.rel];
    const problems = checkDocText(d, t.text, t.images);
    assert(problems.length === 0, problems.join('; '));
    assert(!pdfHasColor(r.pdf, ACCENT.toLowerCase()), 'Akzentfarbe im PDF, obwohl keine gesetzt ist');
  }, { timeoutMs: 360_000 });

  await s.step('(D3) Akzentfarbe: zu hell (#FFFF00) und ungültig werden mit 422 abgelehnt; #0B5C8A gilt in public-config und im PDF-Titel', async () => {
    const ok = await setIssuer(GMBH.profile, ACCENT);
    expectOk(ok, 'PUT mit Akzentfarbe');
    assert(ok.body.accentColor === ACCENT.toLowerCase(), `accentColor ${ok.body.accentColor}`);
    assert(/^#[0-9a-f]{6}$/.test(ok.body.accentOnDark ?? ''), `accentOnDark ${ok.body.accentOnDark}`);
    const pc = await publicConfig();
    assert(pc.accentColor === ACCENT.toLowerCase(), `public-config.accentColor ${pc.accentColor}`);
    assert(/^#[0-9a-f]{6}$/.test(pc.accentOnDark ?? ''), `public-config.accentOnDark ${pc.accentOnDark}`);

    const yellow = await setIssuer(GMBH.profile, '#FFFF00');
    assert(yellow.status === 422 && yellow.body?.error?.code === 'accent_color_invalid', `#FFFF00: HTTP ${yellow.status} ${JSON.stringify(yellow.body).slice(0, 200)}`);
    assert(yellow.body.error.detail?.reason === 'contrast', `Grund ${yellow.body.error.detail?.reason} statt contrast`);
    const word = await setIssuer(GMBH.profile, 'blau');
    assert(word.status === 422 && word.body?.error?.detail?.reason === 'format', `"blau": HTTP ${word.status} ${JSON.stringify(word.body).slice(0, 200)}`);
    const after = await api('GET', '/api/settings/issuer');
    assert(after.body.accentColor === ACCENT.toLowerCase(), `Akzentfarbe nach abgelehnten Werten: ${after.body.accentColor}`);
    assert((await publicConfig()).accentColor === ACCENT.toLowerCase(), 'public-config nach abgelehnten Werten verändert');

    const r = await issueDesignInvoice('mit-logo-akzent');
    assert(pdfImageObjects(r.pdf) >= 1, 'kein Bild-XObject im PDF');
    // Mit Logo gibt es keine Initialmarke: die Akzentfarbe kann nur noch am Titel (und Linien) hängen.
    assert(pdfHasColor(r.pdf, ACCENT.toLowerCase()), `Akzentfarbe ${ACCENT} kommt im PDF nicht als Füll-/Textfarbe vor (Titel nicht eingefärbt?)`);
    const d = designDoc(r, 'min1');
    ctx.docs.push(d);
    const t = (await pdfText([r.rel]))[r.rel];
    const problems = checkDocText(d, t.text, t.images);
    assert(problems.length === 0, problems.join('; '));
  }, { timeoutMs: 420_000 });

  await s.step('(D4) Ohne Logo: Firmenname statt Bild (kein Bild im PDF), Logo-Route 404, Akzentfarbe bleibt', async () => {
    await pace('logo');
    const del = await prot('DELETE', '/api/settings/issuer/logo');
    expectOk(del, 'Logo löschen');
    assert(del.body.logo.hasLogo === false, 'Logo nach dem Löschen noch gesetzt');
    const pub = await fetch(`${ctl.url}/api/public/logo`);
    assert(pub.status === 404, `GET /api/public/logo nach Löschen: ${pub.status}`);
    const pc = await publicConfig();
    assert(pc.hasLogo === false && pc.accentColor === ACCENT.toLowerCase(), `public-config ${JSON.stringify(pc)}`);
    const r = await issueDesignInvoice('ohne-logo-akzent');
    const d = designDoc(r, 0);
    ctx.docs.push(d);
    const t = (await pdfText([r.rel]))[r.rel];
    const problems = checkDocText(d, t.text, t.images);
    assert(problems.length === 0, problems.join('; '));
    assert(pdfHasColor(r.pdf, ACCENT.toLowerCase()), 'Akzentfarbe fehlt im PDF ohne Logo');
    // Akzentfarbe zurücknehmen -> public-config wieder leer
    expectOk(await setIssuer(GMBH.profile, null), 'PUT ohne Akzentfarbe');
    assert((await publicConfig()).accentColor === null, 'Akzentfarbe nach null nicht zurückgesetzt');
  }, { timeoutMs: 420_000 });

  // ======================================================================= (5) Validierung
  await s.step('(5a) PDF/A-3b mit veraPDF (Docker verapdf/cli) für ALLE erzeugten PDFs (Hauptrechnungen, Matrix, Design)', async () => {
    const have = await docker(['image', 'inspect', 'verapdf/cli'], { allowFail: true });
    if (have.code !== 0) await docker(['pull', 'verapdf/cli'], { timeoutMs: 600_000 });
    const ver = await docker(['run', '--rm', ...SUITE_LABELS, 'verapdf/cli', '--version'], { allowFail: true });
    note(`veraPDF: ${(ver.stdout || ver.stderr).trim().split('\n').slice(0, 2).join(' | ')}`);
    assert(ctx.pdfs.length >= 14, `nur ${ctx.pdfs.length} PDFs zu prüfen (erwartet mindestens 14)`);
    const bad = [];
    for (const rel of ctx.pdfs) {
      const r = await docker(
        ['run', '--rm', ...SUITE_LABELS, '-v', `${OUT}:/data:ro`, 'verapdf/cli', '--format', 'mrr', '--flavour', '3b', `/data/${rel}`],
        { allowFail: true, timeoutMs: 300_000 },
      );
      writeOut(`verapdf-${baseName(rel)}.xml`, r.stdout || r.stderr);
      const compliant = /isCompliant="true"/.test(r.stdout);
      const failed = (r.stdout.match(/failedRules="(\d+)"/) ?? [])[1];
      if (!compliant) bad.push(`${rel} (failedRules ${failed ?? 'unbekannt'})`);
    }
    note(`veraPDF-Ergebnis: ${ctx.pdfs.length - bad.length}/${ctx.pdfs.length} PDF/A-3b konform${bad.length ? `; NICHT konform: ${bad.join(', ')}` : ''}`);
    assert(bad.length === 0, `veraPDF: nicht konform: ${bad.join(', ')}`);
  }, { timeoutMs: 1_800_000 });

  await s.step('(5b) KoSIT-Validator: XRechnung- und Factur-X-XML (eclipse-temurin:17-jre, Jar/Konfiguration in E2E_OUT/tools)', async () => {
    const jar = join(TOOLS, 'kosit-validator', `validator-${KOSIT_JAR_VERSION}-standalone.jar`);
    const conf = join(TOOLS, 'kosit-config');
    if (!existsSync(jar)) {
      mkdirSync(join(TOOLS, 'kosit-validator'), { recursive: true });
      await run('curl', ['-fsSL', '-o', jar, KOSIT_JAR_URL], { timeoutMs: 300_000 });
    }
    if (!existsSync(join(conf, 'scenarios.xml'))) {
      mkdirSync(conf, { recursive: true });
      await run('curl', ['-fsSL', '-o', join(conf, 'config.zip'), KOSIT_CONF_URL], { timeoutMs: 300_000 });
      await run('unzip', ['-oq', join(conf, 'config.zip'), '-d', conf]);
    }
    const work = join(OUT, 'kosit');
    rmSync(work, { recursive: true, force: true });
    mkdirSync(work, { recursive: true });
    for (const key of ['b', 'h']) {
      writeFileSync(join(work, `${inv[key].label}.xrechnung.xml`), inv[key].xr);
      writeFileSync(join(work, `${inv[key].label}.factur-x.xml`), inv[key].xml);
    }
    // Matrix: XRechnung der Formen GmbH & Co. KG, GmbH und eG (Spezifikation: diese drei zusätzlich mit KoSIT)
    for (const f of ctx.xrFiles ?? []) writeFileSync(join(work, f.name), readFileSync(join(OUT, f.rel)));
    for (const key of ['gmbh-co-kg', 'gmbh', 'eg']) {
      assert((ctx.xrFiles ?? []).some((f) => f.name === `formen-${key}.xrechnung.xml`), `keine XRechnung der Form ${key} für KoSIT`);
    }
    const results = {};
    for (const f of readdirSync(work).filter((n) => n.endsWith('.xml'))) {
      const r = await docker([
        'run', '--rm', ...SUITE_LABELS, '-v', `${TOOLS}:/tools:ro`, '-v', `${work}:/work`, 'eclipse-temurin:17-jre',
        'java', '-jar', `/tools/kosit-validator/validator-${KOSIT_JAR_VERSION}-standalone.jar`,
        '-s', '/tools/kosit-config/scenarios.xml', '-r', '/tools/kosit-config', '-o', '/work/out', '-h', `/work/${f}`,
      ], { allowFail: true, timeoutMs: 400_000 });
      const text = `${r.stdout}\n${r.stderr}`;
      writeOut(`kosit-${f}.log`, text);
      const verdict = /Acceptance recommendation:\s*(\w+)/i.exec(text)?.[1] ?? /(ACCEPTABLE|REJECT)/.exec(text)?.[1] ?? `exit ${r.code}`;
      const messages = text.split('\n').filter((l) => /error|warning|rejected|\[/i.test(l)).slice(0, 12);
      results[f] = { exit: r.code, verdict, messages };
    }
    // Berichte (xml/html) aus dem Arbeitsordner mitnehmen
    writeOut('kosit-ergebnis.json', JSON.stringify({ validator: KOSIT_JAR_VERSION, konfiguration: `xrechnung 3.0.2 (${KOSIT_CONF_VERSION})`, results }, null, 2));
    note(`KoSIT ${KOSIT_JAR_VERSION} + Konfiguration ${KOSIT_CONF_VERSION}: ${JSON.stringify(Object.fromEntries(Object.entries(results).map(([k, v]) => [k, v.verdict])))}`);
    for (const [k, v] of Object.entries(results)) {
      if (k.includes('xrechnung')) assert(/accept/i.test(v.verdict) || v.exit === 0, `KoSIT ${k}: ${v.verdict} ${v.messages.join(' | ').slice(0, 400)}`);
    }
    ctx.kosit = results;
  }, { timeoutMs: 2_400_000 });

  // ======================================================================= (6) Vorschau
  await s.step('(6) PDF -> PNG (sips) als Vorschau: GmbH & Co. KG an Behörde, GmbH an Unternehmenskunde', async () => {
    for (const key of ['b', 'h']) {
      const dst = join(OUT, `vorschau-${inv[key].label}.png`);
      const r = await run('sips', ['-s', 'format', 'png', join(OUT, `rechnung-${inv[key].label}.pdf`), '--out', dst], { allowFail: true });
      assert(r.code === 0 && existsSync(dst), `sips: ${(r.stderr || r.stdout).slice(0, 200)}`);
      const head = readFileSync(dst).subarray(0, 8).toString('hex');
      assert(head === '89504e470d0a1a0a', 'keine gültige PNG-Datei');
    }
  });

  // ======================================================================= (7) Integrität
  await s.step('(7a) GET /integrity ok', async () => {
    for (const key of ['b', 'h']) {
      const r = await api('GET', `/api/invoices/${inv[key].id}/integrity`);
      expectOk(r, 'integrity');
      assert(r.body.ok === true || r.body.valid === true || r.body.status === 'ok', `Integrität nicht ok: ${JSON.stringify(r.body).slice(0, 300)}`);
    }
  });
  await s.step('(7b) Manipulation (UPDATE/DELETE per SQL) wird vom Trigger abgelehnt', async () => {
    const id = inv.b.id;
    const u1 = await db(`UPDATE "Invoice" SET "pdfContent" = decode('00','hex') WHERE id='${id}'`, { allowFail: true });
    assert(u1.code !== 0, 'UPDATE pdfContent wurde NICHT abgelehnt');
    const u2 = await db(`UPDATE "Invoice" SET "invoiceNumber" = 'X-1' WHERE id='${id}'`, { allowFail: true });
    assert(u2.code !== 0, 'UPDATE invoiceNumber wurde NICHT abgelehnt');
    const d = await db(`DELETE FROM "Invoice" WHERE id='${id}'`, { allowFail: true });
    assert(d.code !== 0, 'DELETE wurde NICHT abgelehnt');
    const dl = await db(`DELETE FROM "InvoiceLine" WHERE "invoiceId"='${id}'`, { allowFail: true });
    assert(dl.code !== 0, 'DELETE InvoiceLine wurde NICHT abgelehnt');
    const a = await db(`UPDATE "AuditLog" SET actor='x' WHERE id IN (SELECT id FROM "AuditLog" LIMIT 1)`, { allowFail: true });
    assert(a.code !== 0, 'UPDATE AuditLog wurde NICHT abgelehnt');
    note(`Trigger-Meldung: ${u1.err.split('\n')[0].slice(0, 160)}`);
    const again = await api('GET', `/api/invoices/${id}/integrity`);
    expectOk(again, 'integrity nach Manipulationsversuch');
    const r = await fetchDoc(`/api/invoices/${id}/document`);
    assert(sha256(r.body) === sha256(inv.b.pdf), 'PDF hat sich nach Manipulationsversuch verändert');
  });
  await s.step('(7c) GoBD-Export (POST) als Datei sichern, entpacken und Prüfsummen verifizieren', async () => {
    const res = await rawPost('/api/invoices/export/gobd', { from: `${new Date().getUTCFullYear()}-01-01`, to: today() });
    assert(res.status === 200, `GoBD-Export (raw): HTTP ${res.status} ${res.body.toString().slice(0, 200)}`);
    assert(res.body.subarray(0, 2).toString() === 'PK', 'Export ist kein ZIP');
    const zip = writeOut('gobd-export.zip', res.body);
    const dir = join(OUT, 'gobd-export');
    rmSync(dir, { recursive: true, force: true });
    mkdirSync(dir, { recursive: true });
    await run('unzip', ['-oq', zip, '-d', dir]);
    const files = readdirSync(dir, { recursive: true });
    note(`GoBD-ZIP enthält ${files.length} Einträge, u. a. ${files.slice(0, 6).join(', ')}`);
    assert(files.includes('hashes.sha256'), 'hashes.sha256 fehlt im Export');
    const chk = await run('shasum', ['-a', '256', '-c', 'hashes.sha256'], { cwd: dir, allowFail: true });
    writeOut('gobd-shasum-check.txt', `${chk.stdout}\n${chk.stderr}`);
    assert(chk.code === 0, `shasum -c: ${(chk.stdout + chk.stderr).slice(0, 300)}`);
    const okLines = chk.stdout.split('\n').filter((l) => /: OK$/.test(l)).length;
    assert(okLines >= 2, `nur ${okLines} geprüfte Dateien`);
    note(`GoBD-Export verifiziert: ${okLines} Dateien OK`);
  }, { timeoutMs: 180_000 });

  // ======================================================================= (8) Mail
  await s.step('(8a) Rechnungsversand: Mail, Anhang PDF, Betreff ohne "Verwaltung Verwaltung", Absender', async () => {
    await mp.clear();
    const r = await prot('POST', `/api/invoices/${inv.h.id}/send`, {});
    expectOk(r, 'POST send');
    const m = await mp.waitFor((x) => x.To?.some((t) => t.Address === 'rechnung@handels.example.com'), 'Rechnungsmail');
    const att = m.Attachments ?? [];
    writeOut('mail-rechnung.json', JSON.stringify({ Subject: m.Subject, From: m.From, To: m.To, ReplyTo: m.ReplyTo, Attachments: att.map((a) => ({ n: a.FileName, t: a.ContentType, s: a.Size })), Text: m.Text }, null, 2));
    assert(!/Verwaltung Verwaltung/i.test(m.Subject + m.Text + (m.HTML ?? '')), `"Verwaltung Verwaltung" in der Mail: ${m.Subject}`);
    assert(m.Subject.includes(inv.h.number), `Betreff ohne Rechnungsnummer: ${m.Subject}`);
    assert(m.From.Address === 'noreply@example.com', `Absender ${m.From.Address}`);
    const pdfAtt = att.find((a) => /\.pdf$/i.test(a.FileName));
    assert(pdfAtt, `kein PDF-Anhang (${att.map((a) => a.FileName).join(', ')})`);
    const pdfBytes = await mp.part(m.ID, pdfAtt.PartID);
    assert(pdfBytes.subarray(0, 4).toString() === '%PDF', 'Anhang beginnt nicht mit %PDF');
    assert(sha256(pdfBytes) === sha256(inv.h.pdf), 'PDF-Anhang der Mail weicht vom gespeicherten Dokument ab');
    const xmlAtt = att.find((a) => /\.xml$/i.test(a.FileName));
    note(`Rechnungsmail: Betreff "${m.Subject}", Absender ${m.From.Name} <${m.From.Address}>, Anhänge: ${att.map((a) => a.FileName).join(', ')}${xmlAtt ? '' : ' (kein separater XML-Anhang vorgesehen; XML steckt im PDF)'}`);
  });

  await s.step('(8b) Anmeldecode-Mail (E-Mail-Code-Anmeldung) kommt an und meldet an', async () => {
    await mp.clear();
    const { api: a2 } = makeClient(ctl.url);
    const first = await a2('POST', '/api/auth/login', { identifier: 'test', password: 'entwicklung-passwort' });
    expectOk(first, 'Login Schritt 1');
    assert(first.body?.secondFactorRequired, 'zweiter Faktor nicht verlangt');
    const rq = await a2('POST', '/api/auth/login-code/request', { identifier: 'test' });
    expectOk(rq, 'login-code/request');
    const m = await mp.waitFor((x) => x.To?.some((t) => t.Address === 'test@example.com'), 'Anmeldecode');
    const code = /\b(\d{8})\b/.exec(m.Text ?? '')?.[1];
    assert(code, `kein achtstelliger Code im Text: ${(m.Text ?? '').slice(0, 200)}`);
    assert(!/Verwaltung Verwaltung/i.test(m.Subject + m.Text), 'Doppelname im Anmeldecode');
    note(`Anmeldecode-Mail: Betreff "${m.Subject}", Absender ${m.From.Address}`);
    const fin = await a2('POST', '/api/auth/login/email-code', { code });
    expectOk(fin, 'login/email-code');
    const me = await a2('GET', '/api/auth/me');
    assert(me.ok, `GET /api/auth/me nach Code-Anmeldung: ${me.status}`);
  });

  await s.step('(8c) Einwilligungsmail: Bestätigungslink -> echte Route (200), Rundmail-Abmeldelink -> echte Route (200)', async () => {
    await mp.clear();
    const sub = await fetch(`${ctl.url}/api/consent/subscription`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-inquiry-key': INQUIRY_KEY },
      body: JSON.stringify({
        email: 'test@example.com',
        formText: 'Ich möchte Neuigkeiten von Demo Software per E-Mail erhalten und kann mich jederzeit abmelden.',
        origin: 'e2e-formular',
      }),
    });
    assert(sub.status === 200, `POST /api/consent/subscription -> ${sub.status} ${await sub.text()}`);
    const m = await mp.waitFor((x) => x.To?.some((t) => t.Address === 'test@example.com'), 'Bestätigungsmail');
    const linkOf = (txt, re) => re.exec(txt ?? '')?.[0];
    const confirmUrl = linkOf(m.Text + (m.HTML ?? ''), /https?:\/\/[^\s"'<>]+\/api\/consent\/confirmation\/[A-Za-z0-9_-]+/);
    assert(confirmUrl, `kein Bestätigungslink in der Mail: ${(m.Text ?? '').slice(0, 300)}`);
    const local = confirmUrl.replace(/^https?:\/\/[^/]+/, ctl.url);
    const page = await fetch(local);
    assert(page.status === 200, `GET Bestätigungslink -> ${page.status} (404 = Route fehlt)`);
    const conf = await fetch(local, { method: 'POST' });
    assert(conf.status === 200, `POST Bestätigung -> ${conf.status}`);

    // Rundmail (werblich): Vorlage anlegen, Testversand an die eigene bestätigte Adresse -> Abmeldelink
    const tpl = await api('POST', '/api/broadcast/templates', {
      name: 'E2E Rundmail', channel: 'marketing', subject: 'Neuigkeiten von Demo Software',
      contentText: 'Hallo {{organisation}}, hier gibt es Neuigkeiten zur Demo Software. Abmelden: {{abmeldelink}}',
    });
    expectOk(tpl, 'Vorlage anlegen');
    await mp.clear();
    const ts = await prot('POST', `/api/broadcast/templates/${tpl.body.id}/test-send`, {});
    expectOk(ts, 'test-send');
    assert(ts.body.sent !== false, `Testversand nicht gesendet: ${JSON.stringify(ts.body)}`);
    // der Versand läuft über die Warteschlange -> Lauf anstoßen
    await prot('POST', '/api/broadcast/queue/run', {});
    const rm = await mp.waitFor((x) => /Neuigkeiten/.test(x.Subject), 'Rundmail', 90_000);
    const unsub = linkOf(rm.Text + (rm.HTML ?? ''), /https?:\/\/[^\s"'<>]+\/api\/consent\/unsubscribe\/[A-Za-z0-9_-]+/);
    assert(unsub, 'kein Abmeldelink in der Rundmail');
    const hdr = JSON.stringify(rm.ListUnsubscribe ?? {});
    note(`Rundmail: Betreff "${rm.Subject}", List-Unsubscribe ${hdr.slice(0, 160)}`);
    const ulocal = unsub.replace(/^https?:\/\/[^/]+/, ctl.url);
    const g = await fetch(ulocal);
    assert(g.status === 200, `GET Abmeldelink -> ${g.status} (404 = Route fehlt)`);
    const after = await db(`SELECT status FROM "Consent" WHERE email='test@example.com'`);
    note(`Consent-Status nach Abmelde-Klick: ${after.out}`);
  }, { timeoutMs: 240_000 });

  // ======================================================================= (9) Audit
  await s.step('(9) Audit: Dokumentabrufe stehen im Verlauf (GET /history)', async () => {
    const r = await api('GET', `/api/invoices/${inv.b.id}/history`);
    expectOk(r, 'history');
    const actions = (r.body ?? []).map((e) => e.action ?? e.aktion ?? JSON.stringify(e));
    writeOut('history-behoerde.json', JSON.stringify(r.body, null, 2));
    const downloads = actions.filter((a) => /document_downloaded|download/i.test(a)).length;
    assert(downloads >= 3, `erwartet >= 3 Abrufprotokolle (pdf, xml, xrechnung), gefunden ${downloads}: ${actions.join(', ')}`);
    assert(actions.some((a) => /finaliz/i.test(a)), `kein Festschreib-Eintrag: ${actions.join(', ')}`);
  });
} finally {
  // Berichte
  try {
    if (ctx.notes.length || ctx.productFindings.length) {
      writeFileSync(join(OUT, 'notes.json'), JSON.stringify(ctx, null, 2));
    }
  } catch { /* egal */ }
  if (ctlPh) await ctlPh.stop().catch(() => {});
  if (ctl) await ctl.stop().catch(() => {});
  if (process.env.E2E_KEEP_CONTAINERS !== '1') {
    await docker(['rm', '-f', C_RENDERER, C_MAILPIT], { allowFail: true });
  }
  s.finish();
}

// ---- Rohabruf mit Nachweis im Body (Bytes statt JSON) --------------------------------------------
async function rawPost(path, body) {
  // Rohabruf (Bytes): frische Sitzung genügt; sonst mit Nachweis im Body (siehe prot)
  return prot('POST', path, body, { raw: true });
}
