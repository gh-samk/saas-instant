import { randomUUID } from 'crypto';
import { consentEmailIndex, mailRecipientIndex } from '../crypto/field-crypto';
import type { ConfigService } from '@nestjs/config';
import { AuditService } from '../audit/audit.service';
import type { MailService } from '../mail/mail.service';
import {
  ADDRESS_AFTER_DELETION,
  CompanyService,
  BLOCK_ENTRY_NOTE,
} from '../companies/company.service';
import {
  createCompany,
  newPrefix,
  prisma,
  cleanUp,
  cleanUpConsents,
  disconnect,
  sendDouble,
} from '../test-support/company-provisioning';
import { ConsentService } from './consent.service';
import { MarketingApproval } from './consent.gate';

/**
 * ===========================================================================
 * DIE KONTAKTDATENLÖSCHUNG RÄUMT JETZT AUCH MAILVERSAND UND EINWILLIGUNG
 * ===========================================================================
 *
 * In Etappe 2 war das ein offener Punkt: Die Adresse der Ansprechpartnerin
 * stand nach der Löschung weiter in jeder Versandzeile, und der Wortlaut
 * jeder verschickten Mail nannte sie beim Namen. Die zugesagte Löschung war
 * damit unvollständig.
 *
 * DER ZIELKONFLIKT, den diese Suite festhält: „nichts bleibt übrig" steht
 * gegen „der Sperreintrag muss überleben". Aufgelöst wird er nach dem ZWECK —
 * die Begründung im Einzelnen steht in `organisation.service.ts`.
 */

jest.setTimeout(120_000);

const PREFIX = newPrefix('e5-loeschung');
const ADDRESS_PREFIX = `e5-lo-${randomUUID().slice(0, 8)}`;
const SOURCE = { ip: '203.0.113.20', userAgent: 'Jest-Integration' };
const ACTOR = { userId: null, name: 'sam' };
const FORM_TEXT =
  'Ja, ich möchte die Beispielprodukt-Rundmail bekommen und kann jederzeit widersprechen.';

const config = {
  get: (_name: string, defaultValue?: string) => defaultValue,
} as unknown as ConfigService;
const mailMock = {
  sendConsentConfirmation: async () => undefined,
} as unknown as MailService;

const audit = new AuditService(prisma);
const consents = new ConsentService(prisma, audit, mailMock, config);
const companies = new CompanyService(prisma, audit, sendDouble());

/** Organisation mit bestätigter Einwilligung und einer versendeten Mail. */
async function provisioning(label: string) {
  const company = await createCompany(PREFIX, {
    contactName: 'Anna Berg',
    contactEmail: `${ADDRESS_PREFIX}-${label}@example.com`,
  });
  const email = `${ADDRESS_PREFIX}-${label}@example.com`;
  await consents.subscribe(
    {
      email,
      formText: FORM_TEXT,
      origin: 'website',
      companyId: company.id,
    },
    SOURCE,
  );
  const row = await prisma.consent.findUniqueOrThrow({ where: { emailIdx: consentEmailIndex(email) } });
  await consents.confirm(row.confirmationToken!, SOURCE);

  const send = await prisma.mailDelivery.create({
    data: {
      companyId: company.id,
      consentId: row.id,
      recipientAddress: email,
      channel: 'marketing',
      subject: 'Neues aus Beispielprodukt',
      contentSnapshot: `Hallo Anna Berg,\n\nHier steht ihr Name.`,
      deliveryStatus: 'sent',
      sentAt: new Date(),
      lastAttemptAt: new Date(),
    },
    select: { id: true },
  });

  return { company, email, consentId: row.id, deliveryId: send.id };
}

afterAll(async () => {
  await cleanUpConsents(ADDRESS_PREFIX);
  await cleanUp(PREFIX);
  await prisma.mailDelivery.deleteMany({
    where: { recipientIdx: mailRecipientIndex(ADDRESS_AFTER_DELETION) },
  });
  await disconnect();
});

describe('Kontaktdaten löschen räumt den Mailbereich mit', () => {
  it('anonymisiert die Versandzeile, statt sie zu löschen', async () => {
    const caseName = await provisioning('anonym');

    const result = await companies.contactDataDelete(
      caseName.company.id,
      caseName.company.name,
      ACTOR,
      SOURCE,
    );

    expect(result.cleanedUpSendRows).toBe(1);
    const row = await prisma.mailDelivery.findUniqueOrThrow({
      where: { id: caseName.deliveryId },
    });
    // DIE ZEILE BLEIBT: Sie belegt, DASS etwas hinausging — ein Nachweis, der
    // zur Rechnung gehört. Adresse und Wortlaut bezeichnen die Person, die
    // Tatsache des Versands nicht.
    expect(row.recipientAddress).toBe(ADDRESS_AFTER_DELETION);
    expect(row.contentSnapshot).not.toContain('Anna Berg');
    expect(row.deliveryStatus).toBe('sent');
    expect(row.consentId).toBeNull();
  });

  it('löscht eine bestätigte Einwilligung vollständig', async () => {
    const caseName = await provisioning('confirmed');

    const result = await companies.contactDataDelete(
      caseName.company.id,
      caseName.company.name,
      ACTOR,
      SOURCE,
    );

    expect(result.deletedConsents).toBe(1);
    expect(result.remainingBlockEntries).toBe(0);
    expect(
      await prisma.consent.findUnique({ where: { id: caseName.consentId } }),
    ).toBeNull();
  });

  /**
   * DER KERN DES ZIELKONFLIKTS. Ohne den Rest wäre die Person nach dem
   * nächsten Import wieder im Verteiler — der Widerspruch wäre praktisch
   * wirkungslos, und sie bekäme genau die Post, gegen die sie sich gewehrt
   * hat.
   */
  it('lässt einen Sperreintrag stehen — aber nur die Sperre', async () => {
    const caseName = await provisioning('unsubscribed');
    const unsubscribeToken = (
      await prisma.consent.findUniqueOrThrow({
        where: { id: caseName.consentId },
      })
    ).unsubscribeToken!;
    await consents.unsubscribe(unsubscribeToken, SOURCE);

    const result = await companies.contactDataDelete(
      caseName.company.id,
      caseName.company.name,
      ACTOR,
      SOURCE,
    );

    expect(result.remainingBlockEntries).toBe(1);
    expect(result.deletedConsents).toBe(0);

    const row = await prisma.consent.findUniqueOrThrow({
      where: { id: caseName.consentId },
    });
    // Was bleibt: die Adresse (der Schlüssel der Sperre) und der Grund.
    expect(row.email).toBe(caseName.email);
    expect(row.status).toBe('unsubscribed');
    // Was geht: alles, was über die Sperre hinausgeht.
    expect(row.companyId).toBeNull();
    expect(row.ipAtSubscription).toBeNull();
    expect(row.ipAtConfirmation).toBeNull();
    expect(row.confirmationToken).toBeNull();
    expect(row.unsubscribeToken).toBeNull();
    expect(row.origin).toBeNull();
    // Der ANLASS ist ein Freitext über eine Person („telefonisch am 30.08.
    // mit …") und geht mit den Kontaktdaten. Was die Sperre trägt, ist der
    // Status — der bleibt.
    expect(row.blockReason).toBeNull();
    expect(row.formText).toBe(BLOCK_ENTRY_NOTE);
  });

  it('hält die Sperre nach der Löschung aufrecht', async () => {
    const caseName = await provisioning('sperrwirkung');
    const unsubscribeToken = (
      await prisma.consent.findUniqueOrThrow({
        where: { id: caseName.consentId },
      })
    ).unsubscribeToken!;
    await consents.unsubscribe(unsubscribeToken, SOURCE);
    await companies.contactDataDelete(
      caseName.company.id,
      caseName.company.name,
      ACTOR,
      SOURCE,
    );

    const check = await prisma.$transaction((tx) =>
      MarketingApproval.check(tx, caseName.consentId),
    );
    expect(check).toEqual({ granted: false, reason: 'unsubscribed' });
  });

  it('räumt auch die Anzeige an der Organisation', async () => {
    const caseName = await provisioning('anzeige');
    await companies.contactDataDelete(
      caseName.company.id,
      caseName.company.name,
      ACTOR,
      SOURCE,
    );
    const company = await prisma.company.findUniqueOrThrow({
      where: { id: caseName.company.id },
    });
    expect(company.newsletterConsentStatus).toBeNull();
  });

  it('nennt im Audit-Log Zahlen, aber keine Adresse', async () => {
    const caseName = await provisioning('audit');
    await companies.contactDataDelete(
      caseName.company.id,
      caseName.company.name,
      ACTOR,
      SOURCE,
    );
    const entries = await prisma.auditLog.findMany({
      where: { objectId: caseName.company.id },
    });
    expect(JSON.stringify(entries)).not.toContain(caseName.email);
    // MIT DEM WERT, nicht nur mit dem Schlüssel. Vorher hieß das Feld
    // `geraeumteMailversande`, und `saeubereFuerAudit` schwärzte es wegen der
    // Teilzeichenkette „email" — der Schlüssel stand da, die Zahl war weg,
    // und dieser Test merkte es nicht.
    expect(
      entries.some(
        (e) =>
          (e.afterValue as { cleanedUpSendRows?: unknown })
            ?.cleanedUpSendRows === 1,
      ),
    ).toBe(true);
  });
});
