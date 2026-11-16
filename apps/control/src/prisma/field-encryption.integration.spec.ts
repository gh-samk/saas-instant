/* eslint-disable @typescript-eslint/no-explicit-any */
import { randomUUID } from 'crypto';
import { Prisma } from '.prisma/control-client';
import { AuditService } from '../audit/audit.service';
import { blindIndex, consentEmailIndex } from '../crypto/field-crypto';
import {
  cleanUp,
  cleanUpConsents,
  disconnect,
  newPrefix,
  prisma,
} from '../test-support/company-provisioning';
import { unlockTestVault } from '../test-support/vault';
import { EncryptExistingService } from '../vault/encrypt-existing.service';
import { EncryptedFieldQueryError, rawClientOf } from './field-encryption';

jest.setTimeout(120_000);

const PREFIX = newPrefix('fe');
const MAIL_PREFIX = `${PREFIX}-`;
const raw = rawClientOf(prisma)!;
const isEnc = (v: unknown): boolean => typeof v === 'string' && v.startsWith('enc:v1:');

function invoiceData(companyId: string, extra: Record<string, unknown> = {}) {
  return {
    companyId,
    invoiceDate: new Date('2026-05-01'),
    servicePeriodFrom: new Date('2026-05-01'),
    servicePeriodUntil: new Date('2026-05-31'),
    dueDate: new Date('2026-05-15'),
    recipientName: `${PREFIX} Empfänger`,
    recipientAddress: 'Musterstraße 1, 12345 Musterstadt',
    issuerCompanyName: 'Aussteller GmbH',
    issuerAddress: 'Ausstellerweg 2',
    ...extra,
  };
}

const lineData = (description: string | null) => ({
  label: 'Jahresabo',
  description,
  quantity: new Prisma.Decimal(1),
  unitPriceNet: new Prisma.Decimal(100),
  taxRate: new Prisma.Decimal(19),
  netAmount: new Prisma.Decimal(100),
  taxAmount: new Prisma.Decimal(19),
  grossAmount: new Prisma.Decimal(119),
});

afterAll(async () => {
  await cleanUp(PREFIX);
  await cleanUpConsents(MAIL_PREFIX);
  await disconnect();
});

describe('Feldverschlüsselung: Schreiben und Lesen', () => {
  it('Company: in der Datenbank Chiffretext, über den Client Klartext, Blind-Index gesetzt', async () => {
    const created = await prisma.company.create({
      data: {
        name: `${PREFIX} Verein`,
        city: 'Musterstadt',
        contactEmail: 'Anna@Example.com',
        iban: 'DE02120300000000202051',
        status: 'inquiry',
      },
    });
    expect(created.name).toBe(`${PREFIX} Verein`);
    expect(created.contactEmail).toBe('Anna@Example.com');

    const stored = await (raw as any).company.findUniqueOrThrow({ where: { id: created.id } });
    expect(isEnc(stored.name)).toBe(true);
    expect(isEnc(stored.city)).toBe(true);
    expect(isEnc(stored.contactEmail)).toBe(true);
    expect(isEnc(stored.iban)).toBe(true);
    expect(stored.country).toBe('Deutschland'); // nicht verschlüsselt
    expect(stored.status).toBe('inquiry');
    expect(stored.contactEmailIdx).toBe(blindIndex('anna@example.com', 'Company.contactEmail'));

    const read = await prisma.company.findUniqueOrThrow({ where: { id: created.id } });
    expect(read).toMatchObject({ name: `${PREFIX} Verein`, city: 'Musterstadt', iban: 'DE02120300000000202051' });
  });

  it('select ohne id entschlüsselt trotzdem und liefert keine id', async () => {
    const c = await prisma.company.create({ data: { name: `${PREFIX} Nur Name` } });
    const row = await prisma.company.findUniqueOrThrow({ where: { id: c.id }, select: { name: true } });
    expect(row).toEqual({ name: `${PREFIX} Nur Name` });
  });

  it('update über id und über einen anderen Eindeutigkeitsschlüssel; Blind-Index folgt', async () => {
    const c = await prisma.company.create({ data: { name: `${PREFIX} Upd`, contactEmail: 'a@example.com' } });
    await prisma.company.update({ where: { id: c.id }, data: { city: 'Neustadt', contactEmail: 'b@example.com' } });
    const stored = await (raw as any).company.findUniqueOrThrow({ where: { id: c.id } });
    expect(isEnc(stored.city)).toBe(true);
    expect(stored.contactEmailIdx).toBe(blindIndex('b@example.com', 'Company.contactEmail'));
    expect((await prisma.company.findUniqueOrThrow({ where: { id: c.id } })).city).toBe('Neustadt');

    const address = `${MAIL_PREFIX}upd@example.com`;
    const consent = await prisma.consent.create({
      data: { email: address, emailIdx: undefined, formText: 'Ja, bitte.', ipAtSubscription: '203.0.113.4' },
    });
    await prisma.consent.update({ where: { emailIdx: consentEmailIndex(address) }, data: { formText: 'Geändert', blockReason: 'telefonisch' } });
    const back = await prisma.consent.findUniqueOrThrow({ where: { id: consent.id } });
    expect(back).toMatchObject({ email: address, formText: 'Geändert', blockReason: 'telefonisch', ipAtSubscription: '203.0.113.4' });
    const rawConsent = await (raw as any).consent.findUniqueOrThrow({ where: { id: consent.id } });
    expect(isEnc(rawConsent.email)).toBe(true);
    expect(isEnc(rawConsent.formText)).toBe(true);
    expect(rawConsent.emailIdx).toBe(consentEmailIndex(address));
  });

  it('upsert: Anlegen und Ändern', async () => {
    const address = `${MAIL_PREFIX}ups@example.com`;
    const where = { emailIdx: consentEmailIndex(address) };
    await prisma.consent.upsert({ where, create: { email: address, formText: 'A' }, update: { formText: 'B' } });
    await prisma.consent.upsert({ where, create: { email: address, formText: 'A' }, update: { formText: 'B' } });
    const row = await prisma.consent.findUniqueOrThrow({ where });
    expect(row).toMatchObject({ email: address, formText: 'B' });
  });

  it('Eindeutigkeit je Adresse hängt am Blind-Index (zweite Zeile derselben Adresse scheitert, auch bei anderer Schreibweise)', async () => {
    const address = `${MAIL_PREFIX}eind@example.com`;
    await prisma.consent.create({ data: { email: address, formText: 'x' } });
    await expect(
      prisma.consent.create({ data: { email: address.toUpperCase(), formText: 'y' } }),
    ).rejects.toMatchObject({ code: 'P2002' });
  });

  it('createMany und verschachteltes create mit include (Invoice -> lines, Company -> noteEntries)', async () => {
    const company = await prisma.company.create({
      data: {
        name: `${PREFIX} Nested`,
        noteEntries: { create: [{ date: new Date('2026-05-02'), text: 'Telefonat über Preise' }] },
      },
    });
    const invoice = await prisma.invoice.create({
      data: {
        ...invoiceData(company.id, { internalNote: 'nur intern' }),
        lines: { create: [lineData('Leistung A'), lineData(null)] },
      },
      include: { lines: true },
    });
    expect(invoice.lines.map((l) => l.description).sort()).toEqual(['Leistung A', null]);

    const storedLines = await (raw as any).invoiceLine.findMany({ where: { invoiceId: invoice.id } });
    const stored = storedLines.find((l: any) => l.description !== null);
    expect(isEnc(stored.description)).toBe(true);
    const storedInvoice = await (raw as any).invoice.findUniqueOrThrow({ where: { id: invoice.id } });
    expect(isEnc(storedInvoice.recipientName)).toBe(true);
    expect(isEnc(storedInvoice.internalNote)).toBe(true);
    expect(storedInvoice.issuerSeat).toBeNull();

    const nested = await prisma.company.findUniqueOrThrow({
      where: { id: company.id },
      include: { noteEntries: true, invoices: { include: { lines: { select: { description: true } } } } },
    });
    expect(nested.noteEntries[0].text).toBe('Telefonat über Preise');
    expect(nested.invoices[0].recipientName).toBe(`${PREFIX} Empfänger`);
    expect(nested.invoices[0].lines.map((l) => l.description).sort()).toEqual(['Leistung A', null]);
    expect(nested.invoices[0].lines[0]).toEqual({ description: expect.anything() });

    const rawNote = await (raw as any).note.findFirstOrThrow({ where: { companyId: company.id } });
    expect(isEnc(rawNote.text)).toBe(true);

    const many = await prisma.note.createMany({
      data: [
        { companyId: company.id, date: new Date('2026-05-03'), text: 'Eins' },
        { companyId: company.id, date: new Date('2026-05-04'), text: 'Zwei' },
      ],
    });
    expect(many.count).toBe(2);
    const texts = (await prisma.note.findMany({ where: { companyId: company.id } })).map((n) => n.text);
    expect(texts).toEqual(expect.arrayContaining(['Eins', 'Zwei']));
    for (const n of await (raw as any).note.findMany({ where: { companyId: company.id } })) expect(isEnc(n.text)).toBe(true);
  });

  it('Bytes- und Json-Spalten (Entwurf): Dokument und Layout verschlüsselt, Roundtrip exakt', async () => {
    const company = await prisma.company.create({ data: { name: `${PREFIX} Docs` } });
    const invoice = await prisma.invoice.create({
      data: invoiceData(company.id, { issuerLayout: { accent: '#123456', lines: ['a', 'b'] } }),
    });
    const pdf = Buffer.from('%PDF-1.7 geheimer Inhalt');
    await prisma.invoice.update({ where: { id: invoice.id }, data: { pdfContent: pdf, xmlContent: Buffer.from('<xml>x</xml>') } });

    const storedInvoice = await (raw as any).invoice.findUniqueOrThrow({ where: { id: invoice.id } });
    expect(Buffer.from(storedInvoice.pdfContent).subarray(0, 4).toString()).toBe('ENC1');
    expect(Buffer.from(storedInvoice.pdfContent).includes(Buffer.from('geheimer'))).toBe(false);
    expect(typeof storedInvoice.issuerLayout).toBe('string');
    expect(isEnc(storedInvoice.issuerLayout)).toBe(true);

    const read = await prisma.invoice.findUniqueOrThrow({ where: { id: invoice.id } });
    expect(Buffer.from(read.pdfContent!).equals(pdf)).toBe(true);
    expect(read.issuerLayout).toEqual({ accent: '#123456', lines: ['a', 'b'] });
    // NULL-Prüfung ist erlaubt (NULL ist unverschlüsselt).
    expect(await prisma.invoice.count({ where: { id: invoice.id, pdfContent: { not: null } } })).toBe(1);
    expect(await prisma.invoice.count({ where: { id: invoice.id, xrechnungContent: null } })).toBe(1);
  });

  it('MailDelivery: Empfänger und Inhalt verschlüsselt, recipientIdx gesetzt', async () => {
    const address = `${MAIL_PREFIX}mail@example.com`;
    const row = await prisma.mailDelivery.create({
      data: { recipientAddress: address, channel: 'transactional', subject: 'Betreff', contentSnapshot: 'Hallo Anna' },
    });
    const stored = await (raw as any).mailDelivery.findUniqueOrThrow({ where: { id: row.id } });
    expect(isEnc(stored.recipientAddress)).toBe(true);
    expect(isEnc(stored.subject)).toBe(true);
    expect(isEnc(stored.contentSnapshot)).toBe(true);
    expect(stored.recipientIdx).toBe(blindIndex(address, 'MailDelivery.recipient'));
    const found = await prisma.mailDelivery.findMany({ where: { recipientIdx: blindIndex(address, 'MailDelivery.recipient') } });
    expect(found.map((f) => f.contentSnapshot)).toEqual(['Hallo Anna']);
    await prisma.mailDelivery.delete({ where: { id: row.id } });
  });

  it('ein in einen anderen Datensatz kopierter Chiffretext lässt sich nicht lesen (AAD)', async () => {
    const a = await prisma.company.create({ data: { name: `${PREFIX} AAD-A` } });
    const b = await prisma.company.create({ data: { name: `${PREFIX} AAD-B` } });
    const storedA = await (raw as any).company.findUniqueOrThrow({ where: { id: a.id } });
    await (raw as any).company.update({ where: { id: b.id }, data: { name: storedA.name } });
    await expect(prisma.company.findUniqueOrThrow({ where: { id: b.id } })).rejects.toThrow();
    await (raw as any).company.update({ where: { id: b.id }, data: { name: 'Wiederhergestellt' } });
  });

  it('Altdaten ohne Präfix werden unverändert geliefert', async () => {
    const id = randomUUID();
    await (raw as any).company.create({ data: { id, name: `${PREFIX} Alt`, city: 'Altstadt' } });
    const read = await prisma.company.findUniqueOrThrow({ where: { id } });
    expect(read).toMatchObject({ name: `${PREFIX} Alt`, city: 'Altstadt' });
  });

  it('AuditLog: bei entsperrtem Tresor verschlüsselt, bei gesperrtem im Klartext (Anmeldung muss vorher gehen)', async () => {
    const vault = await unlockTestVault(prisma);
    const audit = new AuditService(prisma);
    const marker = `${PREFIX}-audit`;
    await audit.log({ actor: marker, action: 'login.password.success', objectType: 'User', afterValue: { a: 1 }, ip: '203.0.113.5', userAgent: 'UA' });
    await vault.lock();
    await audit.log({ actor: `${marker}-locked`, action: 'login.password.success', objectType: 'User', afterValue: { a: 2 }, ip: '203.0.113.6' });
    await vault.unlock('test-tresor-passphrase-nur-fuer-tests', { userId: null, actor: 'test' }, 'audit');

    const unlocked = await (raw as any).auditLog.findFirstOrThrow({ where: { actor: marker } });
    expect(isEnc(unlocked.ip)).toBe(true);
    expect(isEnc(unlocked.afterValue)).toBe(true);
    const locked = await (raw as any).auditLog.findFirstOrThrow({ where: { actor: `${marker}-locked` } });
    expect(locked.ip).toBe('203.0.113.6');
    const read = await prisma.auditLog.findMany({ where: { actor: { startsWith: marker } }, orderBy: { actor: 'asc' } });
    expect(read.map((r) => r.afterValue)).toEqual([{ a: 1 }, { a: 2 }]);
    expect(read[0].ip).toBe('203.0.113.5');
  });
});

describe('Feldverschlüsselung: Filter und Sortierung auf verschlüsselten Feldern werfen', () => {
  it.each([
    ['where equals', () => prisma.company.findMany({ where: { name: 'x' } })],
    ['where contains', () => prisma.company.findMany({ where: { name: { contains: 'x', mode: 'insensitive' } } })],
    ['where in OR', () => prisma.company.findMany({ where: { OR: [{ city: 'a' }, { status: 'inquiry' }] } })],
    ['where NOT', () => prisma.company.count({ where: { NOT: { iban: 'x' } } })],
    ['orderBy', () => prisma.company.findMany({ orderBy: { name: 'asc' } })],
    ['orderBy Liste', () => prisma.company.findMany({ orderBy: [{ status: 'asc' }, { name: 'asc' }] })],
    ['Relationsfilter', () => prisma.invoice.findMany({ where: { company: { name: 'x' } } })],
    ['Relationsfilter some', () => prisma.company.findMany({ where: { noteEntries: { some: { text: { contains: 'x' } } } } })],
    ['verschachteltes where im include', () => prisma.company.findMany({ include: { noteEntries: { where: { text: 'x' } } } })],
    ['verschachteltes orderBy im select', () => prisma.company.findMany({ select: { noteEntries: { orderBy: { text: 'asc' } } } })],
    ['Relation orderBy', () => prisma.invoice.findMany({ orderBy: { company: { name: 'asc' } } })],
    ['Consent.email', () => prisma.consent.findMany({ where: { email: 'a@example.com' } })],
    ['updateMany where', () => prisma.company.updateMany({ where: { name: 'x' }, data: { status: 'inquiry' } })],
    ['deleteMany where', () => prisma.company.deleteMany({ where: { name: 'nicht-vorhanden-xyz' } })],
    ['groupBy', () => (prisma.company as any).groupBy({ by: ['city'], _count: true })],
    ['distinct', () => prisma.company.findMany({ distinct: ['city'] })],
  ])('%s', async (_name, run) => {
    await expect(Promise.resolve().then(run)).rejects.toBeInstanceOf(EncryptedFieldQueryError);
  });

  it('Fehlermeldung nennt Feld und – wo vorhanden – die Blind-Index-Spalte', async () => {
    await expect(prisma.consent.findMany({ where: { email: 'a@example.com' } })).rejects.toThrow(/Consent\.email.*emailIdx/);
    await expect(prisma.company.findMany({ where: { name: 'x' } })).rejects.toThrow(/Company\.name.*Speicher/);
  });

  it('unverschlüsselte Felder und Blind-Index-Spalten bleiben filterbar', async () => {
    await expect(prisma.company.findMany({ where: { status: 'inquiry' }, orderBy: { createdAt: 'desc' }, take: 1 })).resolves.toBeDefined();
    await expect(prisma.company.findMany({ where: { contactEmailIdx: blindIndex('a@example.com', 'Company.contactEmail') } })).resolves.toBeDefined();
  });

  it('updateMany auf verschlüsselten Feldern ohne id im where wirft; mit id geht es', async () => {
    const c = await prisma.company.create({ data: { name: `${PREFIX} UM` } });
    await expect(prisma.company.updateMany({ where: { status: 'inquiry' }, data: { city: 'X' } })).rejects.toBeInstanceOf(EncryptedFieldQueryError);
    await prisma.company.updateMany({ where: { id: c.id, status: 'inquiry' }, data: { city: 'Sonst' } });
    expect((await prisma.company.findUniqueOrThrow({ where: { id: c.id } })).city).toBe('Sonst');
  });
});

describe('encrypt-existing', () => {
  it('verschlüsselt veränderbare Klartextzeilen, lässt Festgeschriebenes in Ruhe, ist idempotent', async () => {
    const vault = await unlockTestVault(prisma);
    const audit = new AuditService(prisma);
    const service = new EncryptExistingService(prisma, vault, audit);

    const companyId = randomUUID();
    await (raw as any).company.create({
      data: { id: companyId, name: `${PREFIX} Bestand`, contactEmail: 'Alt@Example.com', iban: 'DE001' },
    });
    const before = await (raw as any).company.findUniqueOrThrow({ where: { id: companyId } });
    const noteId = randomUUID();
    await (raw as any).note.create({ data: { id: noteId, companyId, date: new Date('2026-01-01'), text: 'Alt-Notiz' } });
    const consentId = randomUUID();
    const address = `${MAIL_PREFIX}bestand@example.com`;
    await (raw as any).consent.create({ data: { id: consentId, email: address, formText: 'Alt-Text', ipAtSubscription: '203.0.113.7' } });
    const draftId = randomUUID();
    await (raw as any).invoice.create({ data: { id: draftId, ...invoiceData(companyId), lines: { create: [{ id: randomUUID(), ...lineData('Alt-Posten') }] } } });
    const finalId = randomUUID();
    const finalLineId = randomUUID();
    await (raw as any).invoice.create({
      data: {
        id: finalId,
        ...invoiceData(companyId, { finalizedAt: new Date(), invoiceNumber: `${PREFIX}-001`, status: 'finalized' }),
        lines: { create: [{ id: finalLineId, ...lineData('Festgeschrieben') }] },
      },
    });

    const counts = await service.run();
    expect(counts.Company).toBeGreaterThanOrEqual(1);
    expect(counts.Note).toBeGreaterThanOrEqual(1);
    expect(counts.Consent).toBeGreaterThanOrEqual(1);
    expect(counts.Invoice).toBeGreaterThanOrEqual(1);
    expect(counts.InvoiceLine).toBeGreaterThanOrEqual(1);

    const company = await (raw as any).company.findUniqueOrThrow({ where: { id: companyId } });
    expect(isEnc(company.name)).toBe(true);
    expect(isEnc(company.iban)).toBe(true);
    expect(company.contactEmailIdx).toBe(blindIndex('alt@example.com', 'Company.contactEmail'));
    expect(company.updatedAt.getTime()).toBe(before.updatedAt.getTime());
    expect(isEnc((await (raw as any).note.findUniqueOrThrow({ where: { id: noteId } })).text)).toBe(true);
    const consent = await (raw as any).consent.findUniqueOrThrow({ where: { id: consentId } });
    expect(isEnc(consent.email)).toBe(true);
    expect(consent.emailIdx).toBe(consentEmailIndex(address));
    expect(isEnc((await (raw as any).invoice.findUniqueOrThrow({ where: { id: draftId } })).recipientName)).toBe(true);

    // Festgeschrieben bleibt, wie es war.
    expect((await (raw as any).invoice.findUniqueOrThrow({ where: { id: finalId } })).recipientName).toBe(`${PREFIX} Empfänger`);
    expect((await (raw as any).invoiceLine.findUniqueOrThrow({ where: { id: finalLineId } })).description).toBe('Festgeschrieben');
    // ... und ist über den Client weiter lesbar (Klartext-Altdaten).
    const viaClient = await prisma.invoice.findUniqueOrThrow({ where: { id: finalId }, include: { lines: true } });
    expect(viaClient.lines[0].description).toBe('Festgeschrieben');

    // Alles bleibt über den Client lesbar.
    const read = await prisma.company.findUniqueOrThrow({ where: { id: companyId } });
    expect(read).toMatchObject({ name: `${PREFIX} Bestand`, contactEmail: 'Alt@Example.com', iban: 'DE001' });

    // Idempotent: nichts mehr zu tun an unseren Zeilen.
    const second = await service.run();
    expect(second.Company).toBe(0);
    expect(second.Consent).toBe(0);
    expect(second.Invoice).toBe(0);
  });
});
