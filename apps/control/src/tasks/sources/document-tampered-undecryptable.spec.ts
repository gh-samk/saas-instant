import type { PrismaService } from '../../prisma/prisma.service';
import { PRICE_PRESETS } from '../../invoices/pricing.config';
import type { TasksContext } from '../tasks.types';

jest.mock('../../invoices/integrity.service', () => ({
  allInvoiceNumbers: jest.fn(async () => []),
  findDocumentFindings: jest.fn(async () => ({
    total: 1,
    findings: [
      {
        id: 'inv-1',
        invoiceNumber: '2026-001',
        // Nicht lesbar kommt als `mismatch` plus Feld `undecryptable`.
        formats: [
          { format: 'pdf', status: 'mismatch' },
          { format: 'xml', status: 'mismatch' },
        ],
        undecryptable: ['pdf'],
      },
    ],
  })),
}));

import { documentTampered } from './document-tampered.source';

describe('document_tampered: nicht lesbare Belege', () => {
  it('nennt ein nicht entschlüsselbares Dokument mit eigenem Text, ein anderes bleibt „Prüfsumme"', async () => {
    const prisma = {
      invoice: {
        findMany: async () => [
          { id: 'inv-1', company: { id: 'c1', name: 'Muster', status: 'customer' } },
        ],
      },
    } as unknown as PrismaService;
    const context: TasksContext = {
      prisma,
      todayDay: '2026-09-01',
      now: new Date('2026-09-01T08:00:00Z'),
      since: '2026-08-25',
      limit: 25,
      priceTable: PRICE_PRESETS,
      outbox: [],
    };
    const result = await documentTampered.collect(context);
    const reason = result.tasks[0]?.reason ?? '';
    expect(reason).toContain('PDF: Beleg nicht lesbar – Inhalt wurde verändert oder ist beschädigt');
    expect(reason).toContain('XML: Prüfsumme stimmt nicht');
  });
});
