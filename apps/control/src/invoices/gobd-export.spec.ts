import { createHash } from 'node:crypto';
import { unzipSync, strFromU8 } from 'fflate';
import { Prisma } from '.prisma/control-client';
import { AUDIT_ACTION } from '../audit/audit.service';
import {
  GOBD_EXPORT_MAX_INVOICES,
  GobdExportRangeError,
  GobdExportService,
  GobdExportTooLargeError,
  INDEX_COLUMNS,
  buildHashFile,
  buildIndexCsv,
  csvCell,
  safeName,
  type IndexRow,
} from './gobd-export.service';

const SOURCE = { ip: '203.0.113.1', userAgent: 'Jest' };
const sha = (data: Uint8Array | string) =>
  createHash('sha256').update(data).digest('hex');

const ROW: IndexRow = {
  number: '2026-001',
  date: '2026-03-01',
  recipient: 'Muster "GmbH"; Köln',
  netCent: 38_500,
  taxCent: 7_315,
  grossCent: 45_815,
  currency: 'EUR',
  status: 'sent',
  pdfSha256: 'a'.repeat(64),
  xmlSha256: 'b'.repeat(64),
  xrechnungSha256: null,
  retentionUntil: '2034-12-31',
  integrity: 'ok',
};

describe('index.csv', () => {
  it('beginnt mit BOM und der festen Kopfzeile, Trenner Semikolon, CRLF', () => {
    const csv = buildIndexCsv([ROW]);
    expect(csv.startsWith('﻿')).toBe(true);
    const lines = csv.slice(1).split('\r\n');
    expect(lines[0]).toBe(INDEX_COLUMNS.map((c) => `"${c}"`).join(';'));
    expect(INDEX_COLUMNS.slice(0, 12)).toEqual([
      'Nummer', 'Datum', 'Empfaenger', 'Netto', 'Steuer', 'Brutto', 'Waehrung',
      'Status', 'PdfSha256', 'XmlSha256', 'XRechnungSha256', 'AufbewahrungBis',
    ]);
    expect(lines[2]).toBe('');
    expect(csv.endsWith('\r\n')).toBe(true);
  });

  it('schreibt Betraege mit Punkt und zwei Stellen, Anfuehrungszeichen verdoppelt', () => {
    const line = buildIndexCsv([ROW]).slice(1).split('\r\n')[1] as string;
    expect(line).toBe(
      [
        '"2026-001"', '"2026-03-01"', '"Muster ""GmbH""; Köln"', '"385.00"',
        '"73.15"', '"458.15"', '"EUR"', '"sent"', `"${'a'.repeat(64)}"`,
        `"${'b'.repeat(64)}"`, '""', '"2034-12-31"', '"ok"',
      ].join(';'),
    );
  });

  it('schuetzt Textzellen vor Formelauswertung, Zahlen bleiben unberuehrt', () => {
    expect(csvCell('=SUMME(A1)')).toBe(`"'=SUMME(A1)"`);
    expect(csvCell('-x')).toBe(`"'-x"`);
    expect(csvCell('@a')).toBe(`"'@a"`);
    expect(csvCell('-12.50', false)).toBe('"-12.50"');
    const negative = buildIndexCsv([{ ...ROW, netCent: -38_500, taxCent: -7_315, grossCent: -45_815 }]);
    expect(negative).toContain('"-385.00"');
  });

  it('entfernt Zeilenumbrueche aus Zellen', () => {
    expect(csvCell('a\nb\r\nc')).toBe('"a b c"');
  });
});

describe('hashes.sha256', () => {
  it('hat das Format von sha256sum: Hash, zwei Leerzeichen, Pfad', () => {
    const text = buildHashFile([
      { path: 'invoices/2026/2026-001.pdf', sha256: 'c'.repeat(64) },
      { path: 'index.csv', sha256: 'd'.repeat(64) },
    ]);
    expect(text).toBe(
      `${'c'.repeat(64)}  invoices/2026/2026-001.pdf\n${'d'.repeat(64)}  index.csv\n`,
    );
    for (const line of text.trim().split('\n')) {
      expect(line).toMatch(/^[0-9a-f]{64} {2}[^\s].*$/);
    }
  });

  it('safeName laesst keine Pfadtrenner zu', () => {
    expect(safeName('2026-001')).toBe('2026-001');
    expect(safeName('../x/2026')).toBe('___x_2026');
  });
});

/** Ein Rechnungsdatensatz fuer die Datenbank-Attrappe. */
function invoiceRow(n: number, withDocuments = true) {
  const number = `2026-${String(n).padStart(3, '0')}`;
  const pdf = Buffer.from(`%PDF Beleg ${number}`);
  const xml = Buffer.from(`<xml ${number}/>`);
  return {
    id: `id-${n}`,
    invoiceNumber: number,
    invoiceDate: new Date('2026-03-01T00:00:00Z'),
    finalizedAt: new Date('2026-03-02T10:00:00Z'),
    status: 'finalized',
    currency: 'EUR',
    recipientName: `Kunde ${n}`,
    retentionUntil: new Date('2034-12-31T00:00:00Z'),
    pdfContent: withDocuments ? pdf : null,
    xmlContent: withDocuments ? xml : null,
    xrechnungContent: null,
    pdfSha256: withDocuments ? sha(pdf) : null,
    xmlSha256: withDocuments ? sha(xml) : null,
    xrechnungSha256: null,
    lines: [
      {
        netAmount: new Prisma.Decimal('100.00'),
        taxAmount: new Prisma.Decimal('19.00'),
        grossAmount: new Prisma.Decimal('119.00'),
      },
    ],
  };
}

function build(rows: ReturnType<typeof invoiceRow>[]) {
  const auditCalls: unknown[] = [];
  const prisma = {
    invoice: {
      count: jest.fn(async () => rows.length),
      findMany: jest.fn(
        async (args: { take: number; cursor?: { id: string }; skip?: number }) => {
          const start = args.cursor
            ? rows.findIndex((r) => r.id === args.cursor?.id) + (args.skip ?? 0)
            : 0;
          return rows.slice(start, start + args.take);
        },
      ),
    },
  };
  const audit = { log: jest.fn(async (e: unknown) => void auditCalls.push(e)) };
  const service = new GobdExportService(prisma as never, audit as never);
  return { service, prisma, audit, auditCalls };
}

async function exportToFiles(service: GobdExportService, range = { from: '2026-01-01', to: '2026-12-31' }) {
  const chunks: Uint8Array[] = [];
  await service.stream(range, { userId: 'u1', name: 'sam' }, SOURCE, (c) => {
    chunks.push(c);
  });
  const total = Buffer.concat(chunks);
  return unzipSync(new Uint8Array(total));
}

describe('GoBD-Export (ZIP, Attrappe)', () => {
  it('liefert die vereinbarte Struktur und jede Zeile von hashes.sha256 stimmt (sha256sum -c)', async () => {
    const rows = Array.from({ length: 120 }, (_, i) => invoiceRow(i + 1)); // > 2 Seiten
    const { service } = build(rows);
    const files = await exportToFiles(service);

    expect(Object.keys(files)).toEqual(
      expect.arrayContaining([
        'README.txt',
        'index.csv',
        'index-description.json',
        'hashes.sha256',
        'invoices/2026/2026-001.pdf',
        'invoices/2026/2026-001.xml',
        'invoices/2026/2026-120.pdf',
      ]),
    );
    // XRechnung nur, wenn vorhanden.
    expect(Object.keys(files).some((n) => n.endsWith('-xrechnung.xml'))).toBe(false);

    // sha256sum -c: jede Zeile, jede Datei, und nichts fehlt.
    const lines = strFromU8(files['hashes.sha256'] as Uint8Array).trim().split('\n');
    const verified = new Set<string>();
    for (const line of lines) {
      const m = /^([0-9a-f]{64}) {2}(.+)$/.exec(line);
      expect(m).not.toBeNull();
      const [, hash, path] = m as RegExpExecArray;
      expect(files[path as string]).toBeDefined();
      expect(sha(files[path as string] as Uint8Array)).toBe(hash);
      verified.add(path as string);
    }
    const expected = Object.keys(files).filter((n) => n !== 'hashes.sha256');
    expect([...verified].sort()).toEqual(expected.sort());

    const csv = strFromU8(files['index.csv'] as Uint8Array);
    expect(csv.split('\r\n').filter(Boolean)).toHaveLength(121);
    expect(strFromU8(files['README.txt'] as Uint8Array)).toContain('keine Rechtsberatung');
    expect(strFromU8(files['README.txt'] as Uint8Array)).toContain('sha256sum -c hashes.sha256');
  });

  it('schreibt einen Audit-Eintrag vor dem ersten Byte', async () => {
    const { service, auditCalls } = build([invoiceRow(1)]);
    const order: string[] = [];
    (service as unknown as { audit: { log: jest.Mock } }).audit.log.mockImplementation(
      async () => void order.push('audit'),
    );
    await service.stream(
      { from: '2026-01-01', to: '2026-12-31' },
      { userId: 'u1', name: 'sam' },
      SOURCE,
      () => void order.push('chunk'),
    );
    expect(order[0]).toBe('audit');
    expect(order.filter((o) => o === 'audit')).toHaveLength(1);
    void auditCalls;
  });

  it('protokolliert Zeitraum und Anzahl als invoice.gobd_export', async () => {
    const { service, audit } = build([invoiceRow(1), invoiceRow(2)]);
    await exportToFiles(service);
    expect(audit.log).toHaveBeenCalledWith(
      expect.objectContaining({
        action: AUDIT_ACTION.invoiceGobdExport,
        actor: 'sam',
        afterValue: { from: '2026-01-01', to: '2026-12-31', count: 2 },
      }),
    );
  });

  it('markiert in index.csv eine Abweichung, liefert die Bytes aber unveraendert', async () => {
    const tampered = invoiceRow(1);
    tampered.pdfContent = Buffer.from('MANIPULIERT');
    const { service } = build([tampered]);
    const files = await exportToFiles(service);
    expect(strFromU8(files['index.csv'] as Uint8Array)).toContain('"abweichung"');
    expect(strFromU8(files['invoices/2026/2026-001.pdf'] as Uint8Array)).toBe('MANIPULIERT');
    // hashes.sha256 fuehrt die TATSAECHLICHEN Bytes, damit `sha256sum -c` besteht.
    expect(strFromU8(files['hashes.sha256'] as Uint8Array)).toContain(sha('MANIPULIERT'));
  });

  it('lehnt einen umgekehrten Zeitraum ab', async () => {
    const { service } = build([]);
    await expect(
      service.prepare({ from: '2026-12-31', to: '2026-01-01' }),
    ).rejects.toBeInstanceOf(GobdExportRangeError);
  });

  it(`lehnt mehr als ${GOBD_EXPORT_MAX_INVOICES} Rechnungen ab, ohne etwas zu schreiben`, async () => {
    const { service, prisma, audit } = build([]);
    prisma.invoice.count.mockResolvedValue(GOBD_EXPORT_MAX_INVOICES + 1);
    const write = jest.fn();
    await expect(
      service.stream({ from: '2026-01-01', to: '2026-12-31' }, { userId: null, name: 'x' }, SOURCE, write),
    ).rejects.toBeInstanceOf(GobdExportTooLargeError);
    expect(write).not.toHaveBeenCalled();
    expect(audit.log).not.toHaveBeenCalled();
  });

  it('exportiert nur festgeschriebene, nummerierte Rechnungen im Zeitraum', async () => {
    const { service, prisma } = build([]);
    await service.prepare({ from: '2026-01-01', to: '2026-03-31' });
    const where = (prisma.invoice.count.mock.calls[0] as unknown as [{ where: Record<string, unknown> }])[0].where;
    expect(where['finalizedAt']).toEqual({ not: null });
    expect(where['invoiceNumber']).toEqual({ not: null });
    expect(where['invoiceDate']).toEqual({
      gte: new Date('2026-01-01T00:00:00Z'),
      lte: new Date('2026-03-31T00:00:00Z'),
    });
  });

  it('liefert auch bei null Rechnungen ein gueltiges Archiv', async () => {
    const { service } = build([]);
    const files = await exportToFiles(service);
    expect(Object.keys(files).sort()).toEqual(
      ['README.txt', 'hashes.sha256', 'index-description.json', 'index.csv'],
    );
  });
});
