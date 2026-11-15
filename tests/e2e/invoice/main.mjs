// Suite "invoice": Echttest der Rechnungserzeugung (ZUGFeRD + XRechnung), Validatoren, Mailversand.
// Aufbau: Rechnungsdienst (gehärtet, 127.0.0.1:18080), Mailpit (SMTP 11025, API 18025), Control-API (13002).
// Alle Fixtures sind frei erfunden (example.com, Musterstadt); Docker-Ressourcen tragen das Label e2e=true.
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startControl, makeClient, ROOT } from '../lib/control.mjs';
import { docker, run, waitHealthy, logs } from '../lib/docker.mjs';
import { createSuite, assert, E2E_OUT, waitFor, sleep } from '../lib/util.mjs';
import { mailpit, sqlClient, extractAttachedXml, sha256, today, monthRange, creditorIdValid } from './helpers.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const SUITE = 'invoice';
const s = createSuite(SUITE, { stepTimeoutMs: 180_000 });
const OUT = join(E2E_OUT, SUITE);
const TOOLS = join(E2E_OUT, 'tools');
mkdirSync(OUT, { recursive: true });
mkdirSync(TOOLS, { recursive: true });

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

// Fiktiver Aussteller. Abweichung von der Vorgabe: USt-IdNr. DE123456789 und IBAN DE02120300000000202051 sind im
// Produkt die PLATZHALTER-Werte (isPlaceholderIssuer) und würden das Festschreiben zu Recht sperren -> andere Muster.
const ISSUER = {
  name: 'Beispiel GmbH & Co. KG',
  vatId: 'DE136695976',
  iban: 'DE89370400440532013000',
  bic: 'COBADEFFXXX',
  creditorId: 'DE98ZZZ09999999999',
};
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
  issuer:
    legalForm: company
    name: ${ISSUER.name}
    address: Musterstraße 1, 99999 Musterstadt
    street: Musterstraße 1
    postalCode: "99999"
    city: Musterstadt
    country: DE
    seat: Musterstadt
    taxId: ${ISSUER.vatId}
    email: rechnung@example.com
    phone: "+49 30 1234567"
    contactName: Erika Mustermann
    creditorId: ${ISSUER.creditorId}
    bankName: Beispielbank
    iban: ${ISSUER.iban}
    bic: ${ISSUER.bic}
    registerCourt: Amtsgericht Musterstadt
    registerNumber: HRA 99999
    generalPartnerName: Beispiel Verwaltungs GmbH
    generalPartnerSeat: Musterstadt
    generalPartnerRegisterCourt: Amtsgericht Musterstadt
    generalPartnerRegisterNumber: HRB 99999
    managingDirectors: Erika Mustermann
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
const inv = {}; // key -> { companyId, id, number, pdf, xml, xr }

/** Aufruf mit Nachweis des zweiten Faktors im Body. */
const withProof = async (method, path, body = {}) => api(method, path, { ...body, ...(await proof()) });
const expectOk = (r, what) => assert(r.ok, `${what}: HTTP ${r.status} ${JSON.stringify(r.body).slice(0, 300)}`);

const containerPort = (name, hostPort, containerPortNr, extra = []) =>
  ['run', '-d', '--name', name, '--label', 'e2e=true', '-p', `127.0.0.1:${hostPort}:${containerPortNr}`, ...extra];

try {
  // ======================================================================= Infrastruktur
  await s.step('Rechnungsdienst-Image bauen (tools/invoice-renderer)', async () => {
    const have = await docker(['image', 'inspect', RENDERER_IMAGE], { allowFail: true });
    if (have.code === 0 && process.env.E2E_REBUILD_RENDERER !== '1') return;
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
      'run', '-d', '--name', C_MAILPIT, '--label', 'e2e=true',
      '-p', `127.0.0.1:${PORT_SMTP}:1025`, '-p', `127.0.0.1:${PORT_MAILPIT}:8025`, MAILPIT_IMAGE,
    ], { timeoutMs: 300_000 });
    mp = mailpit(`http://127.0.0.1:${PORT_MAILPIT}`);
    await waitFor(async () => (await fetch(`http://127.0.0.1:${PORT_MAILPIT}/livez`).catch(() => null))?.ok, { timeoutMs: 60_000, label: 'Mailpit' });
    await mp.clear();
  }, { timeoutMs: 330_000 });

  await s.step('Control-API starten (Manifest mit Aussteller, Renderer, SMTP -> Mailpit)', async () => {
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
    api = sess.api; proof = sess.proof;
    const pc = await fetch(`${ctl.url}/api/public-config`).then((r) => r.json());
    note(`public-config: ${JSON.stringify(pc)}`);
  }, { timeoutMs: 600_000 });
  if (!ctl) throw new Error('Control nicht gestartet – Abbruch der Suite');

  // ======================================================================= (1) Preise
  await s.step('(1) Preisliste per Admin-API setzen (PUT mit Nachweis) und per GET prüfen', async () => {
    const put = await withProof('PUT', '/api/settings/prices', PRICES);
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
    const bad = await withProof('PUT', '/api/settings/prices', {
      ...PRICES, tiers: [{ ...PRICES.tiers[0], maxPersons: null }, { ...PRICES.tiers[1], maxPersons: null }],
    });
    assert(bad.status === 400, `unstimmige Preisliste: HTTP ${bad.status} statt 400`);
    const audit = await db(`SELECT count(*) FROM "AuditLog" WHERE action LIKE 'price%'`);
    assert(Number(audit.out) >= 1, 'kein Audit-Eintrag zur Preisänderung');
  });

  // ======================================================================= (2) Kunden
  const addrBehoerde = { street: 'Amtsstraße', houseNumber: '5', postalCode: '99999', city: 'Musterstadt', country: 'DE' };
  const mkCompany = (extra) => ({ legalForm: 'Körperschaft', ...extra });
  await s.step('(2) Kunden anlegen: Behörde (Leitweg-ID) und Handels GmbH (USt-IdNr.)', async () => {
    const b = await api('POST', '/api/companies', mkCompany({
      name: 'Beispiel Behörde', buyerType: 'authority', buyerReference: '04011000-12345-67',
      billingEmail: 'rechnung@behoerde.example.com', contactName: 'Hans Beispiel', contactEmail: 'kontakt@behoerde.example.com',
      ...addrBehoerde, paymentInterval: 'yearly', paymentMethod: 'bank_transfer',
    }));
    expectOk(b, 'POST /api/companies (Behörde)');
    inv.b = { companyId: b.body.id };
    const h = await api('POST', '/api/companies', mkCompany({
      name: 'Beispiel Handels GmbH', buyerType: 'business', vatId: 'DE987654321',
      billingEmail: 'rechnung@handels.example.com', contactName: 'Petra Beispiel', contactEmail: 'kontakt@handels.example.com',
      street: 'Handelsweg', houseNumber: '12', postalCode: '99999', city: 'Musterstadt', country: 'DE',
      paymentInterval: 'yearly', paymentMethod: 'bank_transfer',
    }));
    expectOk(h, 'POST /api/companies (Handels GmbH)');
    inv.h = { companyId: h.body.id };
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

  await s.step('(3c) Behörde ohne Leitweg-ID: Festschreiben scheitert vorab (keine Nummer verbrannt)', async () => {
    const { draft } = await makeDraftFromSuggestionNoTier();
    const r = await withProof('POST', `/api/invoices/${draft.id}/finalize`, { confirmation: 'festschreiben' });
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

  await s.step('(3d) Festschreiben (Nachweis): Nummer und retentionUntil gesetzt', async () => {
    for (const key of ['b', 'h']) {
      const r = await withProof('POST', `/api/invoices/${inv[key].id}/finalize`, { confirmation: 'festschreiben' });
      expectOk(r, `Festschreiben ${key}`);
      assert(/^\d{4}-\d+/.test(r.body.invoiceNumber ?? ''), `Nummer ${r.body.invoiceNumber}`);
      assert(r.body.finalizedAt, 'finalizedAt fehlt');
      assert(r.body.retentionUntil, 'retentionUntil fehlt');
      inv[key].number = r.body.invoiceNumber;
      inv[key].retentionUntil = r.body.retentionUntil;
      inv[key].gross = r.body.grossAmount ?? r.body.total ?? null;
    }
    const y = new Date().getUTCFullYear();
    assert(String(inv.b.retentionUntil).startsWith(String(y + 8)), `retentionUntil ${inv.b.retentionUntil} (erwartet ${y + 8}-12-31)`);
    note(`Nummern: ${inv.b.number} (Behörde), ${inv.h.number} (Handels GmbH); retentionUntil ${inv.b.retentionUntil}`);
  });

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
    const r = await ph.api('POST', `/api/invoices/${d.body.id}/finalize`, { confirmation: 'festschreiben', ...(await ph.proof()) });
    assert(!r.ok && r.status >= 400 && r.status < 500, `Platzhalter-Aussteller: erwartet 4xx, bekam ${r.status}`);
    note(`Platzhalter-Aussteller verweigert: HTTP ${r.status} ${JSON.stringify(r.body).slice(0, 160)}`);
    const det = await ph.api('GET', `/api/invoices/${d.body.id}`);
    assert(det.body.invoiceNumber === null, 'Nummer trotz Platzhalter-Aussteller vergeben');
  }, { timeoutMs: 400_000 });
  if (ctlPh) await ctlPh.stop().catch(() => {});

  // ======================================================================= (4) Dokumente
  async function fetchDoc(path) {
    const r = await api('GET', path, undefined, { raw: true });
    return r;
  }
  await s.step('(4) Dokumente abrufen: ZUGFeRD-PDF, Factur-X-XML, XRechnung -> Dateien, PDF-Struktur, SHA-256 gegen DB', async () => {
    for (const [key, label] of [['b', 'behoerde'], ['h', 'handels']]) {
      const pdf = await fetchDoc(`/api/invoices/${inv[key].id}/document`);
      assert(pdf.status === 200, `GET document ${key}: HTTP ${pdf.status} ${pdf.body.toString().slice(0, 300)}`);
      const xml = await fetchDoc(`/api/invoices/${inv[key].id}/xml`);
      assert(xml.status === 200, `GET xml ${key}: HTTP ${xml.status} ${xml.body.toString().slice(0, 300)}`);
      const xr = await fetchDoc(`/api/invoices/${inv[key].id}/xrechnung`);
      assert(xr.status === 200, `GET xrechnung ${key}: HTTP ${xr.status} ${xr.body.toString().slice(0, 300)}`);
      inv[key].pdf = pdf.body; inv[key].xml = xml.body; inv[key].xr = xr.body;
      inv[key].label = label;
      mkdirSync(join(OUT), { recursive: true });
      writeFileSync(join(OUT, `rechnung-${label}.pdf`), pdf.body);
      writeFileSync(join(OUT, `rechnung-${label}.factur-x.xml`), xml.body);
      writeFileSync(join(OUT, `rechnung-${label}.xrechnung.xml`), xr.body);
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

  // ======================================================================= (5) Validierung
  await s.step('(5a) PDF/A-3b mit veraPDF (Docker verapdf/cli)', async () => {
    const have = await docker(['image', 'inspect', 'verapdf/cli'], { allowFail: true });
    if (have.code !== 0) await docker(['pull', 'verapdf/cli'], { timeoutMs: 600_000 });
    const ver = await docker(['run', '--rm', '--label', 'e2e=true', 'verapdf/cli', '--version'], { allowFail: true });
    note(`veraPDF: ${(ver.stdout || ver.stderr).trim().split('\n').slice(0, 2).join(' | ')}`);
    let allCompliant = true;
    const verdicts = [];
    for (const key of ['b', 'h']) {
      const r = await docker(
        ['run', '--rm', '--label', 'e2e=true', '-v', `${OUT}:/data:ro`, 'verapdf/cli', '--format', 'mrr', '--flavour', '3b', `/data/rechnung-${inv[key].label}.pdf`],
        { allowFail: true, timeoutMs: 300_000 },
      );
      writeOut(`verapdf-${inv[key].label}.xml`, r.stdout || r.stderr);
      const compliant = /isCompliant="true"/.test(r.stdout);
      const failed = (r.stdout.match(/failedRules="(\d+)"/) ?? [])[1];
      verdicts.push(`${inv[key].label}: ${compliant ? 'PDF/A-3b konform' : `NICHT konform (failedRules ${failed})`}`);
      if (!compliant) allCompliant = false;
    }
    note(`veraPDF-Ergebnis: ${verdicts.join('; ')}`);
    assert(allCompliant, `veraPDF: ${verdicts.join('; ')}`);
  }, { timeoutMs: 900_000 });

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
    const results = {};
    for (const f of readdirSync(work).filter((n) => n.endsWith('.xml'))) {
      const r = await docker([
        'run', '--rm', '--label', 'e2e=true', '-v', `${TOOLS}:/tools:ro`, '-v', `${work}:/work`, 'eclipse-temurin:17-jre',
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
  }, { timeoutMs: 1_500_000 });

  // ======================================================================= (6) Vorschau
  await s.step('(6) PDF -> PNG (sips) als Vorschau', async () => {
    let n = 0;
    for (const key of ['b', 'h']) {
      n++;
      const dst = join(OUT, `vorschau-${n}.png`);
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
    const r = await withProof('POST', `/api/invoices/${inv.h.id}/send`, {});
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
    const ts = await withProof('POST', `/api/broadcast/templates/${tpl.body.id}/test-send`, {});
    expectOk(ts, 'test-send');
    assert(ts.body.sent !== false, `Testversand nicht gesendet: ${JSON.stringify(ts.body)}`);
    // der Versand läuft über die Warteschlange -> Lauf anstoßen
    await withProof('POST', '/api/broadcast/queue/run', {});
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
  return api('POST', path, { ...body, ...(await proof()) }, { raw: true });
}
