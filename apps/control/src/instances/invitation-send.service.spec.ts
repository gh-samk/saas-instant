import { CONTRACT_PRESET } from '../coolify/coolify.config';
import {
  SETUP_SNAPSHOT,
  InvitationSendService,
} from './invitation-send.service';

const TOKEN = 'setup-geheimnis-4711';
const INSTANCE = {
  id: 'i1',
  subdomain: 'musterverein',
  status: 'active',
  setupTokenEncrypted: 'iv.tag.chiffre',
  setupCompletedAt: null as Date | null,
  metrics: [] as unknown[],
};
const COMPANY = {
  name: 'Musterverein e. V.',
  contactEmail: 'anna@example.com',
  instance: INSTANCE as typeof INSTANCE | null,
};
const ACTOR = { name: 'sam', userId: null };
const SOURCE = { ip: '203.0.113.7', userAgent: 'jest' };

function build(company: unknown, mailFails = false) {
  const mailDelivery = { create: jest.fn().mockResolvedValue({}) };
  const prisma = {
    company: { findUnique: jest.fn().mockResolvedValue(company) },
    mailDelivery,
  };
  const audit = { log: jest.fn().mockResolvedValue(undefined) };
  const crypto = { decrypt: jest.fn(() => TOKEN) };
  const coolifyConfig = {
    contract: () => ({ ...CONTRACT_PRESET, baseDomain: 'example.com' }),
  };
  const mail = {
    sendSetupLink: mailFails
      ? jest.fn().mockRejectedValue(new Error('SMTP weg'))
      : jest.fn().mockResolvedValue(undefined),
  };
  const service = new InvitationSendService(
    prisma as never,
    audit as never,
    crypto as never,
    coolifyConfig as never,
    mail as never,
  );
  return { service, mail, mailDelivery, audit };
}

describe('Einrichtungslink per Mail', () => {
  it('schickt den Link mit Geheimnis an die HINTERLEGTE Adresse', async () => {
    const { service, mail } = build(COMPANY);

    const result = await service.send('o1', ACTOR, SOURCE);

    expect(result).toEqual({ sent: true, email: 'anna@example.com' });
    expect(mail.sendSetupLink).toHaveBeenCalledWith(
      'anna@example.com',
      'Musterverein e. V.',
      `https://musterverein.example.com/api/setup/start?token=${TOKEN}`,
      'https://musterverein.example.com',
    );
  });

  it('legt das Geheimnis weder in die Versandzeile noch ins Audit-Log', async () => {
    const { service, mailDelivery, audit } = build(COMPANY);

    await service.send('o1', ACTOR, SOURCE);

    expect(mailDelivery.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        companyId: 'o1',
        recipientAddress: 'anna@example.com',
        channel: 'transactional',
        contentSnapshot: SETUP_SNAPSHOT,
      }),
    });
    expect(JSON.stringify(mailDelivery.create.mock.calls)).not.toContain(TOKEN);
    const entry = audit.log.mock.calls[0][0];
    expect(entry.afterValue).toEqual({ subdomain: 'musterverein' });
    expect(JSON.stringify(audit.log.mock.calls)).not.toContain(TOKEN);
    expect(JSON.stringify(audit.log.mock.calls)).not.toContain('anna@');
  });

  it('meldet eine fehlende Adresse, statt zu werfen', async () => {
    const { service, mail } = build({ ...COMPANY, contactEmail: '  ' });

    expect(await service.send('o1', ACTOR, SOURCE)).toEqual({
      sent: false,
      email: '',
      reason: 'no_address',
    });
    expect(mail.sendSetupLink).not.toHaveBeenCalled();
  });

  it('schickt nichts, wenn die Instanz schon eingerichtet ist', async () => {
    // Sonst ginge ein Link hinaus, den die Instanz mit 410 beantwortet.
    const { service, mail } = build({
      ...COMPANY,
      instance: { ...INSTANCE, setupCompletedAt: new Date('2026-09-12') },
    });

    expect((await service.send('o1', ACTOR, SOURCE)).reason).toBe('no_link');
    expect(mail.sendSetupLink).not.toHaveBeenCalled();
  });

  it('schickt nichts ohne Instanz', async () => {
    const { service, mail } = build({ ...COMPANY, instance: null });
    expect((await service.send('o1', ACTOR, SOURCE)).reason).toBe('no_link');
    expect(mail.sendSetupLink).not.toHaveBeenCalled();
  });

  it('vermerkt nichts als gesendet, was nicht hinausging', async () => {
    const { service, mailDelivery, audit } = build(COMPANY, true);

    expect(await service.send('o1', ACTOR, SOURCE)).toEqual({
      sent: false,
      email: 'anna@example.com',
      reason: 'send_failed',
    });
    expect(mailDelivery.create).not.toHaveBeenCalled();
    expect(audit.log).not.toHaveBeenCalled();
  });

  it('antwortet für eine unbekannte Organisation mit 404', async () => {
    const { service } = build(null);
    await expect(service.send('gibts-nicht', ACTOR, SOURCE)).rejects.toMatchObject({
      errorCode: 'company_not_found',
    });
  });
});
