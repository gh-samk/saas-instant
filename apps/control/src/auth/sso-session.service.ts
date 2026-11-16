import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

/**
 * Die Portal-Sitzungen der Verwaltung (Tabelle `SsoSession`).
 *
 * Das Sitzungs-JWT verweist nur auf eine Zeile; hier liegt, was sich serverseitig
 * ändern muss: das Ende der Sitzung (Abmeldung, Front-Channel-Logout) und der
 * Step-up-Nachweis.
 */
@Injectable()
export class SsoSessionService {
  constructor(private readonly prisma: PrismaService) {}

  /** Legt eine Sitzung zur Portal-Sitzung `sid` an und gibt ihre Kennung zurück. */
  async create(userId: string, sid: string): Promise<string> {
    const row = await this.prisma.ssoSession.create({
      data: { userId, ssoSid: sid },
      select: { id: true },
    });
    return row.id;
  }

  /** Beendet genau diese Sitzung (idempotent). */
  async end(id: string, now: Date = new Date()): Promise<void> {
    await this.prisma.ssoSession.updateMany({
      where: { id, endedAt: null },
      data: { endedAt: now },
    });
  }

  /** Beendet ALLE Sitzungen der Portal-Sitzung `sid`; gibt die Anzahl zurück. */
  async endBySid(sid: string, now: Date = new Date()): Promise<number> {
    const result = await this.prisma.ssoSession.updateMany({
      where: { ssoSid: sid, endedAt: null },
      data: { endedAt: now },
    });
    return result.count;
  }

  /** Trägt einen gelungenen Step-up ein. `false`, wenn die Sitzung nicht mehr läuft. */
  async markStepUp(
    id: string,
    at: Date,
    sid?: string,
  ): Promise<boolean> {
    const result = await this.prisma.ssoSession.updateMany({
      where: { id, endedAt: null },
      data: { stepUpAt: at, ...(sid ? { ssoSid: sid } : {}) },
    });
    return result.count === 1;
  }

  /** Eine laufende Sitzung samt Konto, oder `null`. */
  async findRunning(id: string) {
    return this.prisma.ssoSession.findFirst({
      where: { id, endedAt: null },
      select: {
        id: true,
        ssoSid: true,
        user: {
          select: { id: true, ssoSubject: true, ssoIssuer: true, username: true },
        },
      },
    });
  }
}
