import { randomUUID } from 'crypto';
import type { ConfigService } from '@nestjs/config';
import { AUDIT_ACTION, AuditService } from '../audit/audit.service';
import { consentEmailIndex } from '../crypto/field-crypto';
import { keyring } from '../crypto/keyring';
import type { MailService } from '../mail/mail.service';
import {
  cleanUp,
  cleanUpConsents,
  createCompany,
  disconnect,
  prisma,
} from '../test-support/company-provisioning';
import { unlockTestVault } from '../test-support/vault';
import { ConsentService } from './consent.service';

/**
 * DIE EIN-KLICK-ABMELDUNG BEI GESPERRTEM TRESOR.
 *
 * Ein Widerspruch darf nicht warten, bis jemand die Verwaltung entsperrt. Die
 * Abmeldung schreibt nur unverschlüsselte Spalten (Status, Zeitstempel,
 * Zustellstatus). Geprüft wird gegen echtes Postgres mit weggeworfenem
 * Schlüssel: weder der Eintrag noch die verknüpfte Organisation noch das
 * Audit-Log dürfen dabei entschlüsselt oder mit der IP der Person beschrieben
 * werden.
 */

jest.setTimeout(120_000);

const PREFIX = `unsub-locked-${randomUUID().slice(0, 8)}`;
const SOURCE = { ip: '203.0.113.77', userAgent: 'Mailclient/1.0' };
const config = {
  get: (name: string, d?: string) => (name === 'CONTROL_MAIL_BASE_URL' ? 'https://verwaltung.example' : d),
} as unknown as ConfigService;
const mail = { sendConsentConfirmation: async () => undefined } as unknown as MailService;
const audit = new AuditService(prisma);
const service = new ConsentService(prisma, audit, mail, config);

afterAll(async () => {
  await unlockTestVault(prisma);
  await cleanUpConsents(PREFIX);
  await cleanUp(PREFIX);
  await disconnect();
});

it('meldet bei gesperrtem Tresor ab, ohne etwas zu entschlüsseln oder die IP ins Protokoll zu schreiben', async () => {
  const company = await createCompany(PREFIX, { contactEmail: `${PREFIX}-k@example.com` });
  const email = `${PREFIX}-abmelden@example.com`;
  const link: string[] = [];
  (mail as unknown as { sendConsentConfirmation: (e: string, l: string) => Promise<void> }).sendConsentConfirmation =
    async (_e, l) => void link.push(l);
  await service.subscribe({ email, formText: 'Text', origin: 'test', companyId: company.id }, SOURCE);
  await new Promise((r) => setTimeout(r, 150));
  await service.confirm(link[0]!.split('/').pop()!, SOURCE);
  const token = (await prisma.consent.findUniqueOrThrow({ where: { emailIdx: consentEmailIndex(email) } })).unsubscribeToken!;

  // Tresor sperren: der Schlüssel ist weg, jeder Zugriff auf verschlüsselte Felder wirft.
  keyring.clear();
  await expect(prisma.company.findUniqueOrThrow({ where: { id: company.id } })).rejects.toThrow(/gesperrt/);
  const result = await service.unsubscribe(token, SOURCE);
  expect(result.consentId).toBeTruthy();
  // Zweiter Klick (Mailclient-Vorschau): derselbe Erfolg.
  await service.unsubscribe(token, SOURCE);

  await unlockTestVault(prisma);
  const row = await prisma.consent.findUniqueOrThrow({ where: { id: result.consentId } });
  expect(row.status).toBe('unsubscribed');
  expect(row.unsubscribedAt).not.toBeNull();
  expect((await prisma.company.findUniqueOrThrow({ where: { id: company.id } })).newsletterConsentStatus).toBe('unsubscribed');

  const entries = await prisma.auditLog.findMany({
    where: { action: AUDIT_ACTION.consentUnsubscribed, objectId: result.consentId },
  });
  expect(entries.length).toBeGreaterThanOrEqual(1);
  for (const entry of entries) {
    expect(entry.ip).toBeNull();
    expect(entry.userAgent).toBeNull();
  }
});
