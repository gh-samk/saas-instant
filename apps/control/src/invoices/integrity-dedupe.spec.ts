import { createHash } from 'node:crypto';
import { AUDIT_ACTION } from '../audit/audit.service';
import {
  INTEGRITY_ACTOR,
  INTEGRITY_AUDIT_DEDUPE_DAYS,
  IntegrityService,
} from './integrity.service';

const NOW = new Date('2026-09-20T02:40:00Z');
const DAY = 86_400_000;


/** Dokumentzeile, die der Pruefung den gewuenschten Status liefert (Inhalt und Pruefsumme). */
function documentRow(
  row: { id: string; invoiceNumber: string | null; pdf: string; xml: string; xrechnung: string },
) {
  const content = Buffer.from('inhalt');
  const good = createHash('sha256').update(content).digest('hex');
  const part = (status: string) =>
    status === 'absent'
      ? { content: null, hash: null }
      : status === 'mismatch'
        ? { content, hash: 'f'.repeat(64) }
        : { content, hash: good };
  const [pdf, xml, xr] = [part(row.pdf), part(row.xml), part(row.xrechnung)];
  return {
    id: row.id,
    invoiceNumber: row.invoiceNumber,
    pdfContent: pdf.content,
    pdfSha256: pdf.hash,
    xmlContent: xml.content,
    xmlSha256: xml.hash,
    xrechnungContent: xr.content,
    xrechnungSha256: xr.hash,
  };
}

/** Attrappe: ein Befund (Rechnung inv-1) und ein Audit-Log, das Zeitfilter versteht. */
function setup(numbers: string[] = []) {
  const entries: { objectType: string; objectId: string; timestamp: Date }[] = [];
  const prisma = {
    invoice: {
      findMany: jest.fn(async (args: { where: Record<string, unknown>; cursor?: unknown }) =>
        'finalizedAt' in args.where
          ? args.cursor
            ? []
            : [documentRow({ id: 'inv-1', invoiceNumber: '2026-001', pdf: 'mismatch', xml: 'ok', xrechnung: 'ok' })]
          : numbers.map((invoiceNumber) => ({ invoiceNumber })),
      ),
    },
    auditLog: {
      findFirst: jest.fn(
        async (args: {
          where: { actor: string; objectType: string; objectId: string; timestamp: { gte: Date } };
        }) => {
          expect(args.where.actor).toBe(INTEGRITY_ACTOR);
          return (
            entries.find(
              (e) =>
                e.objectType === args.where.objectType &&
                e.objectId === args.where.objectId &&
                e.timestamp >= args.where.timestamp.gte,
            ) ?? null
          );
        },
      ),
    },
  };
  const audit = {
    log: jest.fn(async (e: { objectType: string; objectId: string }) => {
      entries.push({ objectType: e.objectType, objectId: e.objectId, timestamp: currentNow });
    }),
  };
  let currentNow = NOW;
  const service = new IntegrityService(prisma as never, audit as never);
  return {
    audit,
    run: (at: Date) => {
      currentNow = at;
      return service.runAll(at);
    },
  };
}

describe('Naechtlicher Integritaetslauf: Dedupe je Rechnung', () => {
  it('schreibt je Rechnung hoechstens einen Eintrag in 7 Tagen', async () => {
    const { audit, run } = setup();
    expect((await run(NOW)).audited).toBe(1);
    expect((await run(new Date(NOW.getTime() + DAY))).audited).toBe(0);
    expect((await run(new Date(NOW.getTime() + (INTEGRITY_AUDIT_DEDUPE_DAYS - 1) * DAY))).audited).toBe(0);
    expect(audit.log).toHaveBeenCalledTimes(1);
    expect(audit.log).toHaveBeenCalledWith(
      expect.objectContaining({
        action: AUDIT_ACTION.invoiceIntegrityFailed,
        objectId: 'inv-1',
        actor: INTEGRITY_ACTOR,
      }),
    );
  });

  it('nach 7 Tagen schreibt der Lauf wieder; der Befund selbst wird weiter gezaehlt', async () => {
    const { audit, run } = setup();
    await run(NOW);
    const later = await run(new Date(NOW.getTime() + (INTEGRITY_AUDIT_DEDUPE_DAYS + 1) * DAY));
    expect(later.audited).toBe(1);
    expect(later.documentFindings).toBe(1);
    expect(audit.log).toHaveBeenCalledTimes(2);
  });

  it('gilt auch fuer Luecken im Nummernkreis (je Jahr)', async () => {
    const { audit, run } = setup(['2026-001', '2026-003']);
    const first = await run(NOW);
    expect(first.gapYears).toEqual([2026]);
    expect(first.audited).toBe(2);
    const second = await run(new Date(NOW.getTime() + DAY));
    expect(second.gapYears).toEqual([2026]);
    expect(second.audited).toBe(0);
    expect(audit.log).toHaveBeenCalledTimes(2);
  });
});
