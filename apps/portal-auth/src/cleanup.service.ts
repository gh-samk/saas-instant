import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { PrismaService } from './prisma.service';

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

/** Räumt abgelaufene Codes, Anfragen, Herausforderungen, Links, Sitzungen und Schlüssel weg. */
@Injectable()
export class CleanupService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(CleanupService.name);
  private timer: NodeJS.Timeout | null = null;

  constructor(private readonly prisma: PrismaService) {}

  onModuleInit(): void {
    void this.run();
    this.timer = setInterval(() => void this.run(), HOUR_MS);
    this.timer.unref();
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
  }

  async run(now: Date = new Date()): Promise<void> {
    const week = new Date(now.getTime() - 7 * DAY_MS);
    try {
      await this.prisma.authCode.deleteMany({ where: { expiresAt: { lt: new Date(now.getTime() - HOUR_MS) } } });
      await this.prisma.authRequest.deleteMany({ where: { expiresAt: { lt: now } } });
      await this.prisma.webauthnChallenge.deleteMany({ where: { expiresAt: { lt: now } } });
      await this.prisma.setupToken.deleteMany({ where: { expiresAt: { lt: week } } });
      await this.prisma.portalSession.deleteMany({ where: { OR: [{ expiresAt: { lt: week } }, { revokedAt: { lt: week } }] } });
      await this.prisma.signingKey.deleteMany({ where: { expiresAt: { lt: now } } });
    } catch (error) {
      this.logger.error(`Aufräumen fehlgeschlagen: ${String(error)}`);
    }
  }
}
