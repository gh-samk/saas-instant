import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Request, Response } from 'express';
import { AUDIT_ACTION, AuditService } from '../../audit/audit.service';
import { SessionService } from '../../auth/session.service';
import type { SessionUser } from '../../auth/session.service';
import { sourceFrom } from '../inquiry-source';
import { COOKIE_SESSION, sessionCookieOptions } from '../cookies';

/** Request mit angehängtem, angemeldetem Benutzer. */
export type LoggedInRequest = Request & {
  user?: SessionUser;
  /**
   * Wann sich der Benutzer zuletzt wirklich ausgewiesen hat (`auth_time` aus
   * dem SIGNIERTEN Token). Bewusst nicht Teil von `SitzungsBenutzer`: das ist
   * die Kontodarstellung, die auch in API-Antworten geht — der Zeitpunkt gehört
   * nicht hinein.
   */
  sessionEvidenceAt?: Date | null;
};

/**
 * Schützt Routen: verlangt ein gültiges, signiertes Sitzungs-JWT im
 * httpOnly-Cookie `sitzung` und hängt den Benutzer als `req.benutzer` an.
 *
 * Erneuert die Sitzung zugleich, sobald das Token älter als ein Tag ist — das
 * ist die „selbsterneuernde Sitzung": wer sein Gerät benutzt, bleibt
 * angemeldet, wer es liegen lässt, fliegt nach 30 Tagen raus.
 */
@Injectable()
export class SessionGuard implements CanActivate {
  constructor(
    private readonly session: SessionService,
    private readonly config: ConfigService,
    private readonly audit: AuditService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const req = context.switchToHttp().getRequest<LoggedInRequest>();
    const token = req.cookies?.[COOKIE_SESSION] as string | undefined;
    const { user, issuedAt, evidenceAt, sessionStartedAt } =
      await this.session.resolve(token);
    req.user = user;
    req.sessionEvidenceAt = evidenceAt;

    if (this.session.needsRenewal(issuedAt)) {
      await this.renew(context, user, evidenceAt, sessionStartedAt, req);
    }
    return true;
  }

  /**
   * Stellt ein frisches Token aus und setzt das Cookie neu.
   *
   * ENTSCHEIDEND: `nachweisAm` wird UNVERÄNDERT in das neue Token übernommen.
   * Nur `iat` wandert nach vorn. Vorher trug das erneuerte Cookie ein frisches
   * `iat`, und weil das Frische-Fenster daran hing, machte ein einziges
   * harmloses `GET /auth/ich` eine 25 Stunden alte Sitzung wieder „frisch" —
   * ein erbeutetes Cookie genügte danach für Passkey-Registrierung und
   * Faktorwechsel ohne jeden Nachweis ([K1]).
   */
  private async renew(
    context: ExecutionContext,
    user: SessionUser,
    evidenceAt: Date | null,
    sessionStartedAt: Date,
    req: LoggedInRequest,
  ): Promise<void> {
    const res = context.switchToHttp().getResponse<Response>();
    const newToken = await this.session.createToken(
      user.id,
      evidenceAt,
      sessionStartedAt,
    );
    res.cookie(COOKIE_SESSION, newToken, sessionCookieOptions(this.config));
    await this.audit.log({
      userId: user.id,
      actor: user.username,
      action: AUDIT_ACTION.sessionRenewed,
      objectType: 'User',
      objectId: user.id,
      afterValue: { validDays: 30, evidenceAdopted: evidenceAt !== null },
      ...sourceFrom(req),
    });
  }
}
