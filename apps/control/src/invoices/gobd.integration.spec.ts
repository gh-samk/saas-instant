import { createHash } from 'node:crypto';
import { ConfigService } from '@nestjs/config';
import { datePlusDays } from '@saas-instant/shared';
import { strFromU8, unzipSync } from 'fflate';
import { AUDIT_ACTION, AuditService } from '../audit/audit.service';
import {
  cleanUp,
  createCompany,
  disconnect,
  newPrefix,
  prisma,
} from '../test-support/company-provisioning';
import { IssuerConfigService } from './document/issuer.config';
import type { InvoiceRenderer } from './document/invoice-renderer.client';
import { InvoiceDocumentService } from './document.service';
import { GobdExportService } from './gobd-export.service';
import { InvoiceHistoryService } from './invoice-history.service';
import { IntegrityService, INTEGRITY_ACTOR, findDocumentFindings } from './integrity.service';
import { checkDocument } from './integrity';
import { InvoiceService } from './invoice.service';
import { ARCHIVE_PAGE_SIZE, InvoiceArchiveService, type ArchiveItem } from './invoice-archive.service';
import { PaymentService } from './payment.service';
import { PricingConfigService } from './pricing.config';
import {
  clearDocumentTamperedCache,
  documentTampered,
} from '../tasks/sources/document-tampered.source';
import { PRICE_PRESETS } from './pricing.config';

/**
 * GoBD GEGEN ECHTES POSTGRES.
 *
 * Belegt, was die Datenbank-Trigger der Baseline-Migration versprechen
 * (festgeschriebene Rechnungen und AuditLog unveraenderlich, Entwuerfe
 * loeschbar, definierte Folgefelder erlaubt) und dass Integritaetslauf,
 * Aufgabenquelle, Verlauf und Export darauf aufsetzen.
 *
 * Eine Manipulation, die der Trigger verhindert, laesst sich nur durch
 * Umgehen des Triggers herstellen: `SET LOCAL session_replication_role =
 * replica` innerhalb EINER Transaktion (wirkt nur dort, nichts bleibt
 * veraendert zurueck). Das ist ausdruecklich nur Testcode — die Anwendung hat
 * keinen solchen Weg.
 */

jest.setTimeout(120_000);

const PREFIX = newPrefix('gobd');
const SOURCE = { ip: '203.0.113.11', userAgent: 'Jest-Integration' };
const actor = { userId: null, name: 'sam' };
// Eigene Jahre, damit der global je Jahr laufende Nummernkreis nicht mit
// anderen Suiten kollidiert.
const YEAR = 2095;
const GAP_YEAR = 2094;

const ISSUER_ENV: Record<string, string> = {
  CONTROL_INVOICE_ISSUER: 'Testhaus Software GmbH & Co. KG',
  CONTROL_INVOICE_STREET: 'Werkstattweg 7',
  CONTROL_INVOICE_POSTAL_CODE: '36037',
  CONTROL_INVOICE_CITY: 'Fulda',
  CONTROL_INVOICE_SEAT: 'Fulda',
  CONTROL_INVOICE_USTIDNR: 'DE811569869',
  CONTROL_INVOICE_COMMERCIAL_REGISTER_A: 'HRA 12345',
  CONTROL_INVOICE_REGISTER_COURT: 'Amtsgericht Fulda',
  CONTROL_INVOICE_GENERAL_PARTNER: 'Testhaus Verwaltungs GmbH',
  CONTROL_INVOICE_GENERAL_PARTNER_SEAT: 'Fulda',
  CONTROL_INVOICE_GENERAL_PARTNER_GERICHT: 'Amtsgericht Fulda',
  CONTROL_INVOICE_COMMERCIAL_REGISTER_B: 'HRB 54321',
  CONTROL_INVOICE_MANAGING_DIRECTOR: 'Erika Beispiel',
  CONTROL_INVOICE_CONTACT_NAME: 'Rechnungsstelle Testhaus',
  CONTROL_INVOICE_PHONE: '+49 661 000000',
  CONTROL_INVOICE_EMAIL: 'rechnung@testhaus.example.com',
  CONTROL_INVOICE_BANK: 'Testbank Fulda',
  CONTROL_INVOICE_IBAN: 'DE89370400440532013000',
  CONTROL_INVOICE_BIC: 'COBADEFFXXX',
  CONTROL_INVOICE_CREDITOR_ID: 'DE09ZZZ00000000001',
  CONTROL_INVOICE_DATE_RETROACTIVE_DAYS: '40000',
  CONTROL_INVOICE_DATE_AHEAD_DAYS: '40000',
};
const env = (values: Record<string, string>) =>
  ({ get: (name: string) => values[name] }) as unknown as ConfigService;

const audit = new AuditService(prisma);
const issuer = new IssuerConfigService(env(ISSUER_ENV));
const invoices = new InvoiceService(
  prisma,
  audit,
  new PricingConfigService(env({})),
  issuer,
  env(ISSUER_ENV),
);
const payments = new PaymentService(prisma, audit);
const integrity = new IntegrityService(prisma, audit);
const history = new InvoiceHistoryService(prisma);
const exporter = new GobdExportService(prisma, audit);

const renderer: InvoiceRenderer = {
  isConfigured: () => true,
  create: async (_html, xml) => Buffer.from(`%PDF-1.7 Schein-PDF ${createHash('md5').update(xml).digest('hex')}`),
};
const documents = new InvoiceDocumentService(prisma, audit, issuer, renderer);

const sha = (data: Uint8Array | string) => createHash('sha256').update(data).digest('hex');

async function draft(label: string, year: number): Promise<{ companyId: string; invoiceId: string }> {
  const invoiceDate = `${year}-03-01`;
  const company = await createCompany(PREFIX, {
    street: 'Ziegelgasse',
    houseNumber: '14',
    postalCode: '99423',
    city: 'Weimar',
    country: 'DE',
    contactEmail: `${label}@example.com`,
  });
  const invoice = await invoices.draftCreate(
    company.id,
    {
      invoiceDate,
      servicePeriodFrom: invoiceDate,
      servicePeriodUntil: datePlusDays(invoiceDate, 364),
      lines: [{ label: 'Jahresbeitrag, Stufe 2', quantity: 1, unitPriceNetCent: 38_500, taxRate: 19 }],
    },
    actor,
    SOURCE,
  );
  return { companyId: company.id, invoiceId: invoice.id };
}

/** Festgeschriebene Rechnung mit PDF, XML und XRechnung. */
async function finalizedWithDocuments(label: string, year = YEAR) {
  const created = await draft(label, year);
  await invoices.finalize(created.invoiceId, actor, SOURCE);
  await documents.download('pdf', created.invoiceId, actor, SOURCE);
  await documents.download('xrechnung', created.invoiceId, actor, SOURCE);
  return created;
}

/** Fuehrt SQL mit ausgeschalteten Triggern aus — nur in dieser einen Transaktion. */
async function withoutTriggers(sql: string, ...values: unknown[]): Promise<void> {
  await prisma.$transaction(async (tx) => {
    await tx.$executeRawUnsafe('SET LOCAL session_replication_role = replica');
    await tx.$executeRawUnsafe(sql, ...values);
  });
}

const raw = (sql: string, ...values: unknown[]) => prisma.$executeRawUnsafe(sql, ...values);

afterAll(async () => {
  await cleanUp(PREFIX);
  await disconnect();
});

describe('Datenbank-Trigger: festgeschriebene Rechnung', () => {
  let a: { companyId: string; invoiceId: string };

  beforeAll(async () => {
    a = await finalizedWithDocuments('trigger-a');
  });

  it('lehnt UPDATE von pdfContent per rohem SQL ab (Manipulation des Belegs)', async () => {
    await expect(
      raw(`UPDATE "Invoice" SET "pdfContent" = $1 WHERE "id" = $2`, Buffer.from('gefaelscht'), a.invoiceId),
    ).rejects.toThrow(/GoBD/);
    await expect(
      raw(`UPDATE "Invoice" SET "xmlContent" = $1 WHERE "id" = $2`, Buffer.from('gefaelscht'), a.invoiceId),
    ).rejects.toThrow(/GoBD/);
    await expect(
      raw(`UPDATE "Invoice" SET "pdfSha256" = $1 WHERE "id" = $2`, 'f'.repeat(64), a.invoiceId),
    ).rejects.toThrow(/GoBD/);
  });

  it('lehnt UPDATE der Betraege und Stammdaten ab', async () => {
    await expect(
      raw(`UPDATE "InvoiceLine" SET "netAmount" = 1.00 WHERE "invoiceId" = $1`, a.invoiceId),
    ).rejects.toThrow(/GoBD/);
    await expect(
      raw(`UPDATE "InvoiceLine" SET "quantity" = 99 WHERE "invoiceId" = $1`, a.invoiceId),
    ).rejects.toThrow(/GoBD/);
    await expect(
      raw(`UPDATE "Invoice" SET "recipientName" = 'Anderer' WHERE "id" = $1`, a.invoiceId),
    ).rejects.toThrow(/GoBD/);
    await expect(
      raw(`UPDATE "Invoice" SET "invoiceNumber" = '2095-999' WHERE "id" = $1`, a.invoiceId),
    ).rejects.toThrow(/GoBD/);
    await expect(
      raw(`UPDATE "Invoice" SET "finalizedAt" = NULL WHERE "id" = $1`, a.invoiceId),
    ).rejects.toThrow(/GoBD/);
    await expect(
      raw(`UPDATE "Invoice" SET "retentionUntil" = '2001-01-01' WHERE "id" = $1`, a.invoiceId),
    ).rejects.toThrow(/GoBD/);
  });

  it('lehnt DELETE von Rechnung und Posten ab', async () => {
    await expect(raw(`DELETE FROM "Invoice" WHERE "id" = $1`, a.invoiceId)).rejects.toThrow(/GoBD/);
    await expect(raw(`DELETE FROM "InvoiceLine" WHERE "invoiceId" = $1`, a.invoiceId)).rejects.toThrow(/GoBD/);
    expect(await prisma.invoice.count({ where: { id: a.invoiceId } })).toBe(1);
  });

  it('laesst die definierten Folgefelder zu (Status, Zahlung, Uebertragung)', async () => {
    // Genau die Pfade des Dienstes: Versand-Vermerk, Zahlung, Uebertragungsvermerk.
    await raw(`UPDATE "Invoice" SET "status" = 'sent' WHERE "id" = $1`, a.invoiceId);
    await raw(`UPDATE "Invoice" SET "transferStatus" = 'uebertragen' WHERE "id" = $1`, a.invoiceId);
    const row = await prisma.invoice.findUniqueOrThrow({ where: { id: a.invoiceId } });
    expect(row.status).toBe('sent');
    expect(row.transferStatus).toBe('uebertragen');
  });

  it('laesst Dokumentspalten nur einmal von NULL auf einen Wert setzen (set-once)', async () => {
    const fresh = await draft('trigger-once', YEAR);
    await invoices.finalize(fresh.invoiceId, actor, SOURCE);
    // NULL -> Wert: erlaubt (genau der Pfad des Dokumentdienstes).
    await raw(`UPDATE "Invoice" SET "xmlContent" = $1, "xmlSha256" = $2 WHERE "id" = $3`, Buffer.from('<a/>'), sha('<a/>'), fresh.invoiceId);
    // Wert -> anderer Wert: abgelehnt.
    await expect(
      raw(`UPDATE "Invoice" SET "xmlContent" = $1 WHERE "id" = $2`, Buffer.from('<b/>'), fresh.invoiceId),
    ).rejects.toThrow(/GoBD/);
  });
});

describe('Datenbank-Trigger: Entwurf und AuditLog', () => {
  it('ein Entwurf (ohne Nummer) bleibt loeschbar — samt Posten', async () => {
    const d = await draft('entwurf', YEAR);
    await raw(`DELETE FROM "InvoiceLine" WHERE "invoiceId" = $1`, d.invoiceId);
    await raw(`DELETE FROM "Invoice" WHERE "id" = $1`, d.invoiceId);
    expect(await prisma.invoice.count({ where: { id: d.invoiceId } })).toBe(0);
  });

  it('der Dienst loescht einen Entwurf, nie eine nummerierte Rechnung', async () => {
    const d = await draft('entwurf-dienst', YEAR);
    await expect(invoices.draftDelete(d.invoiceId, actor, SOURCE)).resolves.toEqual({ deleted: true });
    const f = await draft('nummeriert', YEAR);
    await invoices.finalize(f.invoiceId, actor, SOURCE);
    await expect(invoices.draftDelete(f.invoiceId, actor, SOURCE)).rejects.toThrow();
    expect(await prisma.invoice.count({ where: { id: f.invoiceId } })).toBe(1);
  });

  it('AuditLog: UPDATE und DELETE werden abgelehnt', async () => {
    const entry = await prisma.auditLog.findFirstOrThrow({ where: { action: AUDIT_ACTION.invoiceFinalized } });
    await expect(raw(`UPDATE "AuditLog" SET "action" = 'x' WHERE "id" = $1`, entry.id)).rejects.toThrow(/append-only/);
    await expect(raw(`UPDATE "AuditLog" SET "actor" = 'x' WHERE "id" = $1`, entry.id)).rejects.toThrow(/append-only/);
    await expect(raw(`DELETE FROM "AuditLog" WHERE "id" = $1`, entry.id)).rejects.toThrow(/append-only/);
    expect(await prisma.auditLog.count({ where: { id: entry.id } })).toBe(1);
  });

  it('jeder legitime Schreibpfad nach dem Festschreiben passt zu den Triggern', async () => {
    // Vergangenes Jahr, damit ein Zahlungsdatum zwischen Rechnungsdatum und heute liegen kann.
    const created = await draft('pfade', 2024);
    await invoices.finalize(created.invoiceId, actor, SOURCE);
    // Dokumenterzeugung (PDF, XML, XRechnung, documentGeneratedAt)
    await documents.download('pdf', created.invoiceId, actor, SOURCE);
    await documents.download('xrechnung', created.invoiceId, actor, SOURCE);
    // Versand-Vermerk (status -> sent)
    await invoices.sendNote(created.invoiceId);
    // Zahlung (paymentDate, paidAmount, status -> paid)
    const paid = await payments.note(created.invoiceId, '2024-03-05', 45_815, actor, SOURCE);
    expect(paid.status).toBe('paid');
    // Uebertragungsvermerk
    await payments.noteTransfer(created.invoiceId, 'uebertragen', actor, SOURCE);
    // Storno-Verknuepfung (Original -> cancelled, neue Stornorechnung mit eigener Nummer)
    const result = await invoices.cancel(created.invoiceId, 'Test', actor, SOURCE);
    expect(result.cancellation.invoiceNumber).toBeTruthy();
    const original = await prisma.invoice.findUniqueOrThrow({ where: { id: created.invoiceId } });
    expect(original.status).toBe('cancelled');
    expect(original.transferStatus).toBe('uebertragen');
    // Und ein Integritaetslauf ueber diesen Beleg findet nichts.
    expect((await integrity.check(created.invoiceId, actor, SOURCE)).ok).toBe(true);
  });
});

describe('Integritaetspruefung', () => {
  let ok: { companyId: string; invoiceId: string };
  let bad: { companyId: string; invoiceId: string };

  beforeAll(async () => {
    ok = await finalizedWithDocuments('integritaet-ok');
    bad = await finalizedWithDocuments('integritaet-bad');
  });

  it('unveraenderter Beleg: ok, drei Pruefsummen gleich, kein Audit-Eintrag', async () => {
    const result = await integrity.check(ok.invoiceId, actor, SOURCE);
    expect(result.ok).toBe(true);
    expect(result.checks.map((c) => c.check)).toEqual([
      'pdf_sha256',
      'xml_sha256',
      'xrechnung_sha256',
      'number_sequence',
    ]);
    // xml wurde mit dem PDF miterzeugt; alle drei liegen vor und stimmen.
    expect(result.checks.filter((c) => c.status === 'ok')).toHaveLength(4);
    const failed = await prisma.auditLog.count({
      where: { action: AUDIT_ACTION.invoiceIntegrityFailed, objectId: ok.invoiceId },
    });
    expect(failed).toBe(0);
  });

  it('ein Entwurf hat nichts zu pruefen', async () => {
    const d = await draft('integritaet-entwurf', YEAR);
    const result = await integrity.check(d.invoiceId, actor, SOURCE);
    expect(result).toMatchObject({ finalized: false, ok: true, checks: [] });
  });

  it('Manipulation (Trigger umgangen): Abweichung wird gemeldet, protokolliert und als Aufgabe sichtbar', async () => {
    const before = await prisma.invoice.findUniqueOrThrow({ where: { id: bad.invoiceId } });
    // Der Trigger lehnt den Weg ab ...
    await expect(
      raw(`UPDATE "Invoice" SET "pdfContent" = $1 WHERE "id" = $2`, Buffer.from('gefaelscht'), bad.invoiceId),
    ).rejects.toThrow(/GoBD/);
    // ... also wird er fuer EINE Transaktion ausser Kraft gesetzt (Testcode).
    await withoutTriggers(`UPDATE "Invoice" SET "pdfContent" = $1 WHERE "id" = $2`, Buffer.from('gefaelscht'), bad.invoiceId);

    const result = await integrity.check(bad.invoiceId, actor, SOURCE);
    expect(result.ok).toBe(false);
    const pdf = result.checks.find((c) => c.check === 'pdf_sha256');
    expect(pdf).toMatchObject({ ok: false, status: 'mismatch' });
    expect(pdf?.detail).toEqual({ expected: before.pdfSha256, actual: sha('gefaelscht') });
    expect(result.checks.find((c) => c.check === 'xml_sha256')?.ok).toBe(true);

    // Audit-Eintrag
    const entries = await prisma.auditLog.findMany({
      where: { action: AUDIT_ACTION.invoiceIntegrityFailed, objectId: bad.invoiceId },
    });
    expect(entries).toHaveLength(1);
    expect(entries[0]?.actor).toBe('sam');

    // Dieselbe Aussage aus der datenbankseitigen Berechnung (SQL sha256).
    const sql = await findDocumentFindings(prisma, 500);
    const finding = sql.findings.find((f) => f.id === bad.invoiceId);
    expect(finding?.formats).toEqual([{ format: 'pdf', status: 'mismatch' }]);
    expect(sql.findings.find((f) => f.id === ok.invoiceId)).toBeUndefined();
    const row = await prisma.invoice.findUniqueOrThrow({ where: { id: bad.invoiceId } });
    expect(checkDocument(row.pdfContent, row.pdfSha256).status).toBe('mismatch');

    // Aufgabe im Dashboard
    clearDocumentTamperedCache(prisma);
    const tasks = await documentTampered.collect({
      prisma,
      todayDay: `${new Date().getUTCFullYear()}-01-01`,
      now: new Date(),
      since: '2026-01-01',
      limit: 25,
      priceTable: PRICE_PRESETS,
      outbox: [],
    });
    const mine = tasks.tasks.find((t) => t.company?.id === bad.companyId);
    expect(mine).toMatchObject({ kind: 'document_tampered', title: 'Beleg manipuliert', urgency: 'high' });
    expect(tasks.tasks.find((t) => t.company?.id === ok.companyId)).toBeUndefined();
  });

  it('der naechtliche Lauf schreibt Audit-Eintraege und aendert keine Rechnungsspalte', async () => {
    const snapshot = JSON.stringify(
      await prisma.invoice.findMany({ orderBy: { id: 'asc' }, select: { id: true, status: true, pdfSha256: true, transferStatus: true, documentGeneratedAt: true } }),
    );
    const result = await integrity.runAll();
    expect(result.documentFindings).toBeGreaterThanOrEqual(1);
    const nightly = await prisma.auditLog.findMany({
      where: { action: AUDIT_ACTION.invoiceIntegrityFailed, actor: INTEGRITY_ACTOR, objectId: bad.invoiceId },
    });
    expect(nightly).toHaveLength(1);
    // Zweiter Lauf am selben Tag: kein weiterer Eintrag je Rechnung (7-Tage-Dedupe).
    await integrity.runAll();
    expect(
      await prisma.auditLog.count({
        where: { action: AUDIT_ACTION.invoiceIntegrityFailed, actor: INTEGRITY_ACTOR, objectId: bad.invoiceId },
      }),
    ).toBe(1);
    const after = JSON.stringify(
      await prisma.invoice.findMany({ orderBy: { id: 'asc' }, select: { id: true, status: true, pdfSha256: true, transferStatus: true, documentGeneratedAt: true } }),
    );
    expect(after).toBe(snapshot);
  });

  it('meldet eine Luecke im Nummernkreis', async () => {
    const one = await draft('luecke-1', GAP_YEAR);
    const two = await draft('luecke-2', GAP_YEAR);
    const three = await draft('luecke-3', GAP_YEAR);
    await invoices.finalize(one.invoiceId, actor, SOURCE);
    const middle = await invoices.finalize(two.invoiceId, actor, SOURCE);
    await invoices.finalize(three.invoiceId, actor, SOURCE);
    expect(middle.invoiceNumber).toBe(`${GAP_YEAR}-002`);

    // Nummer 2 verschwindet (Trigger umgangen, nur Testcode).
    await withoutTriggers(`DELETE FROM "InvoiceLine" WHERE "invoiceId" = $1`, two.invoiceId);
    await withoutTriggers(`DELETE FROM "Invoice" WHERE "id" = $1`, two.invoiceId);

    const result = await integrity.check(three.invoiceId, actor, SOURCE);
    expect(result.ok).toBe(false);
    const line = result.checks.find((c) => c.check === 'number_sequence');
    expect(line?.ok).toBe(false);
    expect(JSON.stringify(line?.detail)).toContain(`"missing":[2]`);

    await integrity.runAll();
    const entries = await prisma.auditLog.findMany({
      where: { objectType: 'InvoiceNumberSequence', objectId: String(GAP_YEAR), actor: INTEGRITY_ACTOR },
    });
    expect(entries.length).toBeGreaterThanOrEqual(1);
  });
});

describe('Verlauf', () => {
  it('zeigt erzeugt, festgeschrieben, Dokument, Abruf — ohne IP', async () => {
    const created = await draft('verlauf', YEAR);
    await invoices.finalize(created.invoiceId, actor, SOURCE);
    await documents.download('pdf', created.invoiceId, actor, SOURCE);
    const entries = await history.history(created.invoiceId);
    const actions = entries.map((e) => e.action);
    expect(actions).toEqual(
      expect.arrayContaining([
        AUDIT_ACTION.invoiceDraftCreated,
        AUDIT_ACTION.invoiceFinalized,
        AUDIT_ACTION.invoiceDocumentGenerated,
        AUDIT_ACTION.invoiceDocumentDownloaded,
      ]),
    );
    expect(entries.find((e) => e.action === AUDIT_ACTION.invoiceDocumentDownloaded)?.format).toBe('pdf');
    for (const e of entries) {
      expect(Object.keys(e).sort()).toEqual(expect.arrayContaining(['action', 'actor', 'at']));
      expect(e.at).toMatch(/Z$/);
      expect(JSON.stringify(e)).not.toContain('203.0.113.11');
    }
    const times = entries.map((e) => e.at);
    expect([...times].sort()).toEqual(times);
  });
});

describe('Verschluesselung der Dokumente und Archiv-Endpunkt', () => {
  it('legt die Dokumentspalten verschluesselt ab, die Pruefsumme gilt dem Klartext', async () => {
    const created = await finalizedWithDocuments('verschluesselt');
    const raw = await prisma.$queryRaw<{ head: string; pdfSha256: string }[]>`
      SELECT encode(substring("pdfContent" from 1 for 4), 'escape') AS head, "pdfSha256"
      FROM "Invoice" WHERE "id" = ${created.invoiceId}`;
    expect(raw[0].head).toBe('ENC1');
    const row = await prisma.invoice.findUniqueOrThrow({ where: { id: created.invoiceId } });
    expect(Buffer.from(row.pdfContent as Uint8Array).toString('utf8')).toContain('%PDF-1.7');
    expect(sha(row.pdfContent as Uint8Array)).toBe(raw[0].pdfSha256);
    expect((await integrity.check(created.invoiceId, actor, SOURCE)).ok).toBe(true);
    expect((await findDocumentFindings(prisma, 500)).findings.map((f) => f.id)).not.toContain(created.invoiceId);
  });

  it('liefert das Archiv entschluesselt, seitenweise und mit gueltiger Pruefsumme', async () => {
    const created = await finalizedWithDocuments('archiv');
    const archive = new InvoiceArchiveService(prisma);
    const seen: ArchiveItem[] = [];
    let after: string | undefined;
    for (let guard = 0; guard < 1000; guard++) {
      const page = await archive.page(after);
      expect(page.items.length).toBeLessThanOrEqual(ARCHIVE_PAGE_SIZE);
      seen.push(...page.items);
      if (page.next === null) break;
      after = page.next;
    }
    const item = seen.find((i) => i.invoiceId === created.invoiceId);
    expect(item).toBeDefined();
    expect(item!.documents.map((d) => d.kind).sort()).toEqual(['pdf', 'xml', 'xrechnung']);
    for (const d of item!.documents) {
      expect(sha(Buffer.from(d.base64, 'base64'))).toBe(d.sha256);
    }
    const pdf = item!.documents.find((d) => d.kind === 'pdf')!;
    expect(Buffer.from(pdf.base64, 'base64').toString('utf8')).toContain('%PDF-1.7');
    expect(new Set(seen.map((i) => i.invoiceId)).size).toBe(seen.length);
  });
});

describe('GoBD-Export (echte Datenbank)', () => {
  it('liefert ein ZIP, das sha256sum -c besteht, und index.csv passt zu den Belegen', async () => {
    const one = await finalizedWithDocuments('export-1', 2093);
    const two = await finalizedWithDocuments('export-2', 2093);
    const chunks: Uint8Array[] = [];
    const { count } = await exporter.stream(
      { from: '2093-01-01', to: '2093-12-31' },
      actor,
      SOURCE,
      (c) => void chunks.push(c),
    );
    expect(count).toBe(2);
    const files = unzipSync(new Uint8Array(Buffer.concat(chunks)));

    // sha256sum -c
    const hashLines = strFromU8(files['hashes.sha256'] as Uint8Array).trim().split('\n');
    expect(hashLines.length).toBe(Object.keys(files).length - 1);
    for (const line of hashLines) {
      const m = /^([0-9a-f]{64}) {2}(.+)$/.exec(line) as RegExpExecArray;
      expect(sha(files[m[2] as string] as Uint8Array)).toBe(m[1]);
    }

    // Dateien und Bytes entsprechen dem Archiv in der Datenbank.
    for (const id of [one.invoiceId, two.invoiceId]) {
      const row = await prisma.invoice.findUniqueOrThrow({ where: { id } });
      const base = `invoices/2093/${row.invoiceNumber}`;
      expect(sha(files[`${base}.pdf`] as Uint8Array)).toBe(row.pdfSha256);
      expect(sha(files[`${base}.xml`] as Uint8Array)).toBe(row.xmlSha256);
      expect(sha(files[`${base}-xrechnung.xml`] as Uint8Array)).toBe(row.xrechnungSha256);
    }

    const csv = strFromU8(files['index.csv'] as Uint8Array);
    const rows = csv.replace(/^﻿/, '').trim().split('\r\n');
    expect(rows).toHaveLength(3);
    expect(rows[1]).toContain('"2093-001"');
    expect(rows[1]).toContain('"385.00";"73.15";"458.15";"EUR"');
    expect(rows[1]).toMatch(/"20\d\d-12-31"/);
    expect(rows[1]?.endsWith('"ok"')).toBe(true);

    // Audit
    const logged = await prisma.auditLog.findFirstOrThrow({
      where: { action: AUDIT_ACTION.invoiceGobdExport },
      orderBy: { timestamp: 'desc' },
    });
    expect(logged.afterValue).toEqual({ from: '2093-01-01', to: '2093-12-31', count: 2 });
  });

  it('ein leerer Zeitraum ergibt ein gueltiges Archiv ohne Belege', async () => {
    const chunks: Uint8Array[] = [];
    const { count } = await exporter.stream(
      { from: '2001-01-01', to: '2001-01-02' },
      actor,
      SOURCE,
      (c) => void chunks.push(c),
    );
    expect(count).toBe(0);
    expect(Object.keys(unzipSync(new Uint8Array(Buffer.concat(chunks)))).sort()).toEqual([
      'README.txt',
      'hashes.sha256',
      'index-description.json',
      'index.csv',
    ]);
  });
});
