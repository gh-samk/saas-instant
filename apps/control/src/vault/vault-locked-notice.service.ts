import { Injectable, Logger, OnApplicationBootstrap } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { baseUrl } from '../common/base-url';
import { MailService } from '../mail/mail.service';
import { PrismaService } from '../prisma/prisma.service';
import { VaultService } from './vault.service';

/**
 * Meldet den Admins, dass die Verwaltung nach einem Neustart GESPERRT ist.
 *
 * Ohne diese Mail merkt es niemand, bis ein Kunde nachfragt: der Tresor ist nach
 * jedem Start zu, und die Webseite nimmt bis dahin keine Anfragen an (423). Der
 * Mailversand selbst braucht keinen Schlüssel — Adresse und Text stammen aus
 * `User` (bewusst unverschlüsselt) und dem Manifest, nicht aus Kundendaten.
 *
 * Kein Versand bei nicht eingerichtetem Tresor (es gibt noch nichts zu
 * entsperren) und nie für Notzugangskonten. Scheitert der Versand, bleibt es
 * beim Log: der Zustand `locked` zeigt auch `/api/health`.
 */
@Injectable()
export class VaultLockedNoticeService implements OnApplicationBootstrap {
  private readonly logger = new Logger(VaultLockedNoticeService.name);

  constructor(
    private readonly vault: VaultService,
    private readonly prisma: PrismaService,
    private readonly mail: MailService,
    private readonly config: ConfigService,
  ) {}

  onApplicationBootstrap(): void {
    // Nicht auf den Start warten: ein langsamer Postausgang darf ihn nicht bremsen.
    void this.notify().catch((error: unknown) =>
      this.logger.warn(`Sperrhinweis nicht verschickt: ${String(error)}`),
    );
  }

  /** Verschickt den Hinweis; gibt die Zahl der angeschriebenen Admins zurück. */
  async notify(): Promise<number> {
    if ((await this.vault.state()) !== 'locked') return 0;
    const admins = await this.prisma.user.findMany({
      where: { accessRole: 'admin', emergency: false, deactivatedAt: null },
      select: { email: true },
    });
    const link = `${baseUrl(this.config)}/`;
    let sent = 0;
    for (const { email } of admins) {
      try {
        await this.mail.sendVaultLockedNote(email, link);
        sent += 1;
      } catch {
        // `MailService` hat den Grund schon protokolliert.
      }
    }
    this.logger.warn(
      `Tresor gesperrt: ${sent} von ${admins.length} Admins benachrichtigt. ` +
        'Zum Entsperren anmelden (Zustand auch unter /api/health: "locked").',
    );
    return sent;
  }
}
