import type { ConfigService } from '@nestjs/config';
import type { MailService } from '../mail/mail.service';
import type { PrismaService } from '../prisma/prisma.service';
import { VaultLockedNoticeService } from './vault-locked-notice.service';
import type { VaultService, VaultState } from './vault.service';

function build(state: VaultState, admins: { email: string }[], failFor: string[] = []) {
  const sent: { email: string; link: string }[] = [];
  const where: unknown[] = [];
  const mail = {
    sendVaultLockedNote: async (email: string, link: string) => {
      if (failFor.includes(email)) throw new Error('Relay nicht erreichbar');
      sent.push({ email, link });
    },
  } as unknown as MailService;
  const prisma = {
    user: {
      findMany: async (args: unknown) => {
        where.push(args);
        return admins;
      },
    },
  } as unknown as PrismaService;
  const vault = { state: async () => state } as unknown as VaultService;
  const config = {
    get: (key: string) => (key === 'CONTROL_APP_URL' ? 'https://verwaltung.example.test/' : undefined),
  } as unknown as ConfigService;
  return { service: new VaultLockedNoticeService(vault, prisma, mail, config), sent, where };
}

describe('VaultLockedNoticeService', () => {
  it('schreibt bei gesperrtem Tresor jede Admin-Adresse an, mit dem Link zur Entsperrseite', async () => {
    const { service, sent } = build('locked', [{ email: 'a@example.test' }, { email: 'b@example.test' }]);
    expect(await service.notify()).toBe(2);
    expect(sent).toEqual([
      { email: 'a@example.test', link: 'https://verwaltung.example.test/' },
      { email: 'b@example.test', link: 'https://verwaltung.example.test/' },
    ]);
  });

  it('nimmt nur aktive Admins ohne Notzugangskonten (Filter an der Abfrage)', async () => {
    const { service, where } = build('locked', [{ email: 'a@example.test' }]);
    await service.notify();
    expect(where[0]).toMatchObject({
      where: { accessRole: 'admin', emergency: false, deactivatedAt: null },
      select: { email: true },
    });
  });

  it.each<VaultState>(['unlocked', 'uninitialized'])('bei Zustand %s wird nichts verschickt', async (state) => {
    const { service, sent, where } = build(state, [{ email: 'a@example.test' }]);
    expect(await service.notify()).toBe(0);
    expect(sent).toEqual([]);
    expect(where).toEqual([]);
  });

  it('ein Fehler bei einer Adresse hält die übrigen nicht auf', async () => {
    const { service, sent } = build(
      'locked',
      [{ email: 'a@example.test' }, { email: 'b@example.test' }],
      ['a@example.test'],
    );
    expect(await service.notify()).toBe(1);
    expect(sent.map((s) => s.email)).toEqual(['b@example.test']);
  });
});
