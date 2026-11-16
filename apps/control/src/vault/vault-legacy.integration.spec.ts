import { randomUUID } from 'crypto';
import {
  cleanUp,
  createCompany,
  disconnect,
  newPrefix,
  prisma,
} from '../test-support/company-provisioning';
import { unlockTestVault } from '../test-support/vault';
import { rawClientOf } from '../prisma/field-encryption';

jest.setTimeout(120_000);

const PREFIX = newPrefix('legacy');

afterAll(async () => {
  await cleanUp(PREFIX);
  await disconnect();
});

const invoiceData = (companyId: string, extra: Record<string, unknown> = {}) => ({
  companyId,
  invoiceDate: new Date('2026-05-01'),
  servicePeriodFrom: new Date('2026-05-01'),
  servicePeriodUntil: new Date('2026-05-31'),
  dueDate: new Date('2026-05-15'),
  recipientName: `${PREFIX} Empfänger`,
  recipientAddress: 'Musterstraße 1',
  issuerCompanyName: 'Aussteller GmbH',
  issuerAddress: 'Ausstellerweg 2',
  ...extra,
});

describe('Altbestand im Klartext (M3)', () => {
  it('zählt festgeschriebene Rechnungen und Protokolleinträge vor dem Tresor ohne Chiffre-Kennung', async () => {
    const vault = await unlockTestVault(prisma);
    const company = await createCompany(PREFIX);
    const raw = rawClientOf(prisma) as any; // eslint-disable-line @typescript-eslint/no-explicit-any
    const before = await vault.legacyPlaintext();

    // Klartext, festgeschrieben: Altbestand.
    await raw.invoice.create({
      data: { id: randomUUID(), ...invoiceData(company.id, { finalizedAt: new Date(), invoiceNumber: `${PREFIX}-A1`, status: 'finalized' }) },
    });
    // Verschlüsselt, festgeschrieben: zählt nicht.
    await prisma.invoice.create({
      data: { id: randomUUID(), ...invoiceData(company.id, { finalizedAt: new Date(), invoiceNumber: `${PREFIX}-A2`, status: 'finalized' }) } as any, // eslint-disable-line @typescript-eslint/no-explicit-any
    });
    // Klartext, aber ENTWURF: kein Altbestand dieser Art (der Einmal-Lauf verschlüsselt ihn).
    await raw.invoice.create({ data: { id: randomUUID(), ...invoiceData(company.id) } });
    // Protokolleintrag im Klartext vor der Einrichtung des Tresors.
    await raw.auditLog.create({
      data: { id: randomUUID(), actor: PREFIX, action: 'test.legacy', objectType: 'Test', ip: '203.0.113.9', timestamp: new Date('2020-01-01T00:00:00Z') },
    });
    // Protokolleintrag im Klartext NACH der Einrichtung (bei gesperrtem Tresor geschrieben): kein Altbestand.
    await raw.auditLog.create({
      data: { id: randomUUID(), actor: PREFIX, action: 'test.locked', objectType: 'Test', ip: '203.0.113.10' },
    });
    // Verschlüsselter Eintrag vor dem Stichtag: zählt nicht.
    await raw.auditLog.create({
      data: { id: randomUUID(), actor: PREFIX, action: 'test.enc', objectType: 'Test', ip: 'enc:v1:AAAA', timestamp: new Date('2020-01-02T00:00:00Z') },
    });

    const after = await vault.legacyPlaintext();
    expect(after.invoices - before.invoices).toBe(1);
    expect(after.auditEntries - before.auditEntries).toBe(1);
  });
});
