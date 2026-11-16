import { Injectable } from '@nestjs/common';
import type { Account, PortalSession } from '.prisma/portal-auth-client';
import { generateToken, hashToken } from '@saas-instant/auth-core';
import { PrismaService } from '../prisma.service';

/** Absolute Lebensdauer einer Portal-Sitzung. */
export const SESSION_ABSOLUTE_MS = 12 * 60 * 60 * 1000;
/** Ohne Aktivität endet die Sitzung nach dieser Zeit. */
export const SESSION_IDLE_MS = 2 * 60 * 60 * 1000;
/** `lastSeenAt` höchstens so oft schreiben. */
const TOUCH_INTERVAL_MS = 60 * 1000;

export interface SessionView {
  session: PortalSession;
  account: Account;
}

export interface CreatedSession extends SessionView {
  /** Cookie-Wert im Klartext (nur hier verfügbar). */
  token: string;
}

@Injectable()
export class SessionsService {
  constructor(private readonly prisma: PrismaService) {}

  async create(account: Account, amr: string[], now: Date = new Date()): Promise<CreatedSession> {
    const token = generateToken();
    const session = await this.prisma.portalSession.create({
      data: {
        accountId: account.id,
        tokenHash: hashToken(token),
        authTime: now,
        amr,
                createdAt: now,
        lastSeenAt: now,
        expiresAt: new Date(now.getTime() + SESSION_ABSOLUTE_MS),
      },
    });
    return { token, session, account };
  }

  /** Gültige Sitzung zum Cookie-Wert oder null (abgelaufen, widerrufen, Konto gesperrt). */
  async resolve(token: string, now: Date = new Date()): Promise<SessionView | null> {
    const session = await this.prisma.portalSession.findUnique({
      where: { tokenHash: hashToken(token) },
      include: { account: true },
    });
    if (!session) return null;
    const { account, ...plain } = session;
    if (plain.revokedAt || plain.expiresAt <= now) return null;
    if (now.getTime() - plain.lastSeenAt.getTime() > SESSION_IDLE_MS) return null;
    if (account.disabledAt) return null;
    if (now.getTime() - plain.lastSeenAt.getTime() > TOUCH_INTERVAL_MS) {
      await this.prisma.portalSession.update({ where: { id: plain.id }, data: { lastSeenAt: now } });
    }
    return { session: plain, account };
  }

  /**
   * Faktor erneut nachgewiesen (Anmeldung im Step-up): selbe Sitzung (sid),
   * frische auth_time und amr, neuer Cookie-Wert gegen Session-Fixation.
   */
  async refreshFactor(sessionId: string, amr: string[], now: Date = new Date()): Promise<{ token: string; session: PortalSession }> {
    const token = generateToken();
    const session = await this.prisma.portalSession.update({
      where: { id: sessionId },
      data: { tokenHash: hashToken(token), authTime: now, amr, lastSeenAt: now },
    });
    return { token, session };
  }

  async revoke(sessionId: string, now: Date = new Date()): Promise<void> {
    await this.prisma.portalSession.updateMany({
      where: { id: sessionId, revokedAt: null },
      data: { revokedAt: now },
    });
  }

  async revokeAllOf(accountId: string, exceptId?: string, now: Date = new Date()): Promise<number> {
    const result = await this.prisma.portalSession.updateMany({
      where: { accountId, revokedAt: null, ...(exceptId ? { id: { not: exceptId } } : {}) },
      data: { revokedAt: now },
    });
    return result.count;
  }
}
