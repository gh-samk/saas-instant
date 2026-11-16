import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { createRemoteJWKSet } from 'jose';
import type { JWTVerifyGetKey } from 'jose';
import { AUDIT_ACTION, AuditService } from '../audit/audit.service';
import { SessionService } from '../auth/session.service';
import { SsoSessionService } from '../auth/sso-session.service';
import { APP_URL_DEFAULT } from '../common/app-defaults';
import type { InquirySource } from '../common/inquiry-source';
import { PrismaService } from '../prisma/prisma.service';
import { IdTokenError, hasSecondFactor, verifyIdToken } from './id-token';
import type { VerifiedIdToken } from './id-token';
import { SsoInvalidError, SsoNoAccessError } from './sso.errors';
import { envFrom, portalLogoutUrl, readSsoSettings } from './sso-settings';
import type { SsoSettings } from './sso-settings';
import { assertAllowedReturnPath } from './return-path';

/** Ein SSO-Durchlauf ist höchstens zehn Minuten unterwegs. */
const FLOW_MAX_MS = 10 * 60 * 1000;
/** Zeitlimit für den Token-Abruf beim Portal. */
const TOKEN_TIMEOUT_MS = 10_000;

/** Inhalt des signierten Cookies eines laufenden Durchlaufs. */
interface FlowCookie {
  typ: 'sso-flow';
  state: string;
  nonce: string;
  verifier: string;
  ret: string;
  /** Step-up statt Anmeldung. */
  su: boolean;
  /** Bei Step-up: die SSO-Sitzung, die den Nachweis bekommt. */
  ssn?: string;
}

/** Ergebnis von `start`. */
export interface SsoStart {
  authorizeUrl: string;
  /** Wert für das Cookie `sso_flow`. */
  cookieValue: string;
}

/** Ergebnis des Callbacks. */
export type SsoCallbackResult =
  | { kind: 'login'; sessionToken: string; returnPath: string }
  | { kind: 'step-up'; returnPath: string };

/** Die Angaben, mit denen ein Fehlschlag protokolliert wird. */
function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function randomUrlSafe(bytes: number): string {
  return randomBytes(bytes).toString('base64url');
}

function sameText(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}

/**
 * Der OIDC-Client der Verwaltung (Authorization Code + PKCE, Modus `portal`).
 *
 * Gespräche mit dem Portal gibt es genau zwei, beide über `PORTAL_INTERNAL_URL`:
 * den Token-Abruf und das JWKS. Alles andere (Anmeldeseite, Abmeldung) ist eine
 * Weiterleitung des Browsers.
 */
@Injectable()
export class SsoService {
  private readonly logger = new Logger(SsoService.name);
  private readonly settings: SsoSettings;
  private jwks: JWTVerifyGetKey | null = null;
  /** Für Tests ersetzbar: die Quelle der Signaturschlüssel. */
  private keySource: JWTVerifyGetKey | null = null;

  constructor(
    private readonly config: ConfigService,
    private readonly prisma: PrismaService,
    private readonly jwt: JwtService,
    private readonly audit: AuditService,
    private readonly session: SessionService,
    private readonly ssoSessions: SsoSessionService,
  ) {
    this.settings = readSsoSettings(envFrom(config));
  }

  get mode(): SsoSettings['mode'] {
    return this.settings.mode;
  }

  /** Für Tests: eigene Schlüsselquelle statt Abruf über das Netz. */
  useKeySourceForTests(source: JWTVerifyGetKey | null): void {
    this.keySource = source;
  }

  private appUrl(): string {
    return this.config
      .get<string>('CONTROL_APP_URL', APP_URL_DEFAULT)
      .replace(/\/+$/, '');
  }

  /** Der Ursprung (`https://host`) des Portals, für `frame-ancestors`. */
  issuerOrigin(): string {
    return new URL(this.settings.issuer).origin;
  }

  /** Die beim Portal registrierte Rücksprungadresse dieser Verwaltung. */
  redirectUri(): string {
    return `${this.appUrl()}/api/auth/sso/callback`;
  }

  private keys(): JWTVerifyGetKey {
    if (this.keySource) return this.keySource;
    if (!this.jwks) {
      this.jwks = createRemoteJWKSet(
        new URL(`${this.settings.internalUrl}/.well-known/jwks.json`),
        {
          timeoutDuration: TOKEN_TIMEOUT_MS,
          // Wechselt das Portal den Schlüssel (neue `kid`), holt jose das JWKS
          // neu — höchstens alle 30 Sekunden, damit ein Token mit erfundener
          // `kid` keinen Abrufsturm auslöst.
          cooldownDuration: this.settings.jwksCooldownMs,
          cacheMaxAge: 10 * 60 * 1000,
        },
      );
    }
    return this.jwks;
  }

  // -------------------------------------------------------------------------
  // Start
  // -------------------------------------------------------------------------

  /**
   * Beginnt einen Durchlauf: erzeugt state, nonce und PKCE-Verifier, merkt sich
   * den state (Einmaligkeit) und liefert die Adresse des Portals.
   */
  async start(options: {
    returnPath: string | undefined;
    stepUp: boolean;
    /** Bei Step-up: die laufende SSO-Sitzung. */
    ssoSessionId?: string;
  }): Promise<SsoStart> {
    const returnPath = assertAllowedReturnPath(options.returnPath);
    const state = randomUrlSafe(32);
    const nonce = randomUrlSafe(32);
    const verifier = randomUrlSafe(48);
    const challenge = createHash('sha256').update(verifier).digest('base64url');

    // Abgelaufene Durchläufe wegräumen; die Tabelle bleibt klein.
    await this.prisma.ssoAttempt.deleteMany({
      where: { startedAt: { lt: new Date(Date.now() - 60 * 60 * 1000) } },
    });
    await this.prisma.ssoAttempt.create({ data: { stateHash: sha256(state) } });

    const flow: FlowCookie = {
      typ: 'sso-flow',
      state,
      nonce,
      verifier,
      ret: returnPath,
      su: options.stepUp,
      ...(options.ssoSessionId ? { ssn: options.ssoSessionId } : {}),
    };
    const cookieValue = await this.jwt.signAsync(flow as unknown as object, {
      secret: this.config.get<string>('JWT_SECRET'),
      expiresIn: Math.floor(FLOW_MAX_MS / 1000),
    });

    const url = new URL(`${this.settings.issuer}/oauth/authorize`);
    const query = url.searchParams;
    query.set('response_type', 'code');
    query.set('client_id', this.settings.clientId);
    query.set('redirect_uri', this.redirectUri());
    query.set('scope', 'openid');
    query.set('state', state);
    query.set('nonce', nonce);
    query.set('code_challenge', challenge);
    query.set('code_challenge_method', 'S256');
    if (options.stepUp) query.set('max_age', '0');
    return { authorizeUrl: url.toString(), cookieValue };
  }

  // -------------------------------------------------------------------------
  // Callback
  // -------------------------------------------------------------------------

  /**
   * Schließt einen Durchlauf ab. Wirft `SsoInvalidError` (401) bei jedem
   * Prüffehler und `SsoNoAccessError` (403), wenn das Konto hier keine Rolle hat.
   * Der Grund eines Fehlers steht im Audit-Log, nie in der Antwort.
   */
  async callback(
    query: Record<string, unknown>,
    cookieValue: string | undefined,
    source: InquirySource,
  ): Promise<SsoCallbackResult> {
    const flow = await this.readFlow(cookieValue, source);

    try {
      return await this.finish(flow, query, source);
    } catch (error) {
      if (error instanceof SsoNoAccessError) throw error;
      const reason =
        error instanceof SsoInvalidError || error instanceof IdTokenError
          ? error.message
          : 'Unerwarteter Fehler beim Abschluss.';
      if (!(error instanceof SsoInvalidError || error instanceof IdTokenError)) {
        this.logger.error(
          `SSO-Callback: ${(error as Error).message}`,
          (error as Error).stack,
        );
      }
      await this.audit.log({
        userId: null,
        actor: 'sso',
        action: flow.su
          ? AUDIT_ACTION.ssoStepUpError
          : AUDIT_ACTION.ssoLoginError,
        objectType: 'User',
        objectId: null,
        afterValue: { reason },
        ip: source.ip,
        userAgent: source.userAgent,
      });
      const failure = new SsoInvalidError(reason);
      if (flow.su) failure.stepUpReturn = flow.ret;
      throw failure;
    }
  }

  /** Liest und prüft das Cookie des Durchlaufs. */
  private async readFlow(
    cookieValue: string | undefined,
    source: InquirySource,
  ): Promise<FlowCookie> {
    const fail = async (reason: string): Promise<never> => {
      await this.audit.log({
        userId: null,
        actor: 'sso',
        action: AUDIT_ACTION.ssoLoginError,
        objectType: 'User',
        objectId: null,
        afterValue: { reason },
        ip: source.ip,
        userAgent: source.userAgent,
      });
      throw new SsoInvalidError(reason);
    };
    if (!cookieValue) return fail('Cookie des Durchlaufs fehlt.');
    let flow: FlowCookie;
    try {
      flow = await this.jwt.verifyAsync<FlowCookie>(cookieValue, {
        secret: this.config.get<string>('JWT_SECRET'),
      });
    } catch {
      return fail('Cookie des Durchlaufs ungültig oder abgelaufen.');
    }
    if (
      flow.typ !== 'sso-flow' ||
      typeof flow.state !== 'string' ||
      typeof flow.nonce !== 'string' ||
      typeof flow.verifier !== 'string' ||
      typeof flow.ret !== 'string'
    ) {
      return fail('Cookie des Durchlaufs unvollständig.');
    }
    return flow;
  }

  private async finish(
    flow: FlowCookie,
    query: Record<string, unknown>,
    source: InquirySource,
  ): Promise<SsoCallbackResult> {
    const state = typeof query['state'] === 'string' ? query['state'] : '';
    if (state === '' || !sameText(state, flow.state)) {
      throw new SsoInvalidError('state passt nicht zum Cookie.');
    }

    // EINMALIG: Der Durchlauf wird atomar verbraucht, bevor irgendetwas
    // anderes passiert. Ein zweiter Callback mit demselben Cookie und
    // derselben Adresse findet keine offene Zeile mehr.
    const consumed = await this.prisma.ssoAttempt.updateMany({
      where: {
        stateHash: sha256(flow.state),
        consumedAt: null,
        startedAt: { gt: new Date(Date.now() - FLOW_MAX_MS) },
      },
      data: { consumedAt: new Date() },
    });
    if (consumed.count !== 1) {
      throw new SsoInvalidError('state unbekannt, abgelaufen oder schon benutzt.');
    }
    const attempt = await this.prisma.ssoAttempt.findUnique({
      where: { stateHash: sha256(flow.state) },
      select: { startedAt: true },
    });
    if (!attempt) throw new SsoInvalidError('Durchlauf nicht auffindbar.');

    const errorParam = query['error'];
    if (typeof errorParam === 'string' && errorParam !== '') {
      throw new SsoInvalidError(
        `Das Portal meldet einen Fehler (${errorParam.slice(0, 40).replace(/[^\w.-]/g, '?')}).`,
      );
    }
    const code = query['code'];
    if (typeof code !== 'string' || code === '' || code.length > 2048) {
      throw new SsoInvalidError('Kein Code im Callback.');
    }

    const idToken = await this.exchange(code, flow.verifier);
    const verified = await verifyIdToken(idToken, this.keys(), {
      issuer: this.settings.issuer,
      clientId: this.settings.clientId,
      nonce: flow.nonce,
    });

    if (flow.su) {
      return this.completeStepUp(flow, verified, attempt.startedAt, source);
    }
    return this.completeLogin(flow, verified, source);
  }

  /** Tauscht den Code gegen das ID-Token (client_secret_post, PKCE). */
  private async exchange(code: string, verifier: string): Promise<string> {
    const body = new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      redirect_uri: this.redirectUri(),
      code_verifier: verifier,
      client_id: this.settings.clientId,
      client_secret: this.settings.clientSecret,
    });
    let response: Response;
    try {
      response = await fetch(`${this.settings.internalUrl}/oauth/token`, {
        method: 'POST',
        headers: {
          'content-type': 'application/x-www-form-urlencoded',
          accept: 'application/json',
        },
        body,
        signal: AbortSignal.timeout(TOKEN_TIMEOUT_MS),
        redirect: 'error',
      });
    } catch {
      throw new SsoInvalidError('Token-Abruf beim Portal nicht möglich.');
    }
    if (!response.ok) {
      throw new SsoInvalidError(`Token-Abruf abgelehnt (HTTP ${response.status}).`);
    }
    let payload: unknown;
    try {
      payload = await response.json();
    } catch {
      throw new SsoInvalidError('Token-Antwort ist kein JSON.');
    }
    const token =
      payload !== null && typeof payload === 'object'
        ? (payload as Record<string, unknown>)['id_token']
        : undefined;
    if (typeof token !== 'string' || token === '') {
      throw new SsoInvalidError('Token-Antwort ohne id_token.');
    }
    return token;
  }

  // -------------------------------------------------------------------------
  // Anmeldung
  // -------------------------------------------------------------------------

  private async completeLogin(
    flow: FlowCookie,
    token: VerifiedIdToken,
    source: InquirySource,
  ): Promise<SsoCallbackResult> {
    // Ohne Rolle gibt es KEIN Konto und keinen Zugang: geprüft, bevor
    // irgendetwas angelegt oder verknüpft wird.
    const role = token.role;
    if (role === null) {
      await this.audit.log({
        userId: null,
        actor: 'sso',
        action: AUDIT_ACTION.ssoLoginError,
        objectType: 'User',
        objectId: null,
        afterValue: {
          reason: 'Keine Rolle für diese Verwaltung.',
          sid: token.sid,
        },
        ip: source.ip,
        userAgent: source.userAgent,
      });
      throw new SsoNoAccessError();
    }
    const user = await this.resolveAccount(token, role);
    if (user.deactivatedAt !== null) {
      await this.audit.log({
        userId: user.id,
        actor: user.username,
        action: AUDIT_ACTION.ssoLoginError,
        objectType: 'User',
        objectId: user.id,
        afterValue: { reason: 'Zugang entzogen.' },
        ip: source.ip,
        userAgent: source.userAgent,
      });
      throw new SsoNoAccessError();
    }

    // Rolle und Stammdaten bei JEDER Anmeldung aus dem Token übernehmen. Ein
    // Notzugangskonto behält seine Rolle: sie ist der Rückweg für den Fall, dass
    // das Portal ausfällt oder falsch konfiguriert ist, und darf nicht von dem
    // abhängen, was das Portal für dieselbe Adresse behauptet.
    await this.prisma.user.update({
      where: { id: user.id },
      data: {
        ...(user.emergency ? {} : { accessRole: role }),
        name: token.name,
        lastLoginAt: new Date(),
        failedAttempts: 0,
        lockedUntil: null,
      },
    });

    const ssoSessionId = await this.ssoSessions.create(user.id, token.sid);
    const sessionToken = await this.session.createToken(
      user.id,
      new Date(token.authTime * 1000),
      undefined,
      ssoSessionId,
    );
    await this.audit.log({
      userId: user.id,
      actor: user.username,
      action: AUDIT_ACTION.ssoLoginSuccess,
      objectType: 'User',
      objectId: user.id,
      afterValue: { role, amr: token.amr, sid: token.sid },
      ip: source.ip,
      userAgent: source.userAgent,
    });
    return { kind: 'login', sessionToken, returnPath: flow.ret };
  }

  /**
   * Findet das Konto zum Token — oder legt es an.
   *
   * 1. Treffer über `ssoSubject` (Normalfall).
   * 2. Kein Treffer: gibt es ein lokales Konto mit derselben Adresse und ohne
   *    Portal-Verknüpfung, wird es verknüpft (Altbestand zieht um).
   * 3. Sonst entsteht ein neues Konto; der erste SSO-Login legt es an.
   */
  private async resolveAccount(
    token: VerifiedIdToken,
    role: 'admin' | 'staff',
  ) {
    const select = {
      id: true,
      username: true,
      ssoIssuer: true,
      deactivatedAt: true,
      emergency: true,
    } as const;
    const bySubject = await this.prisma.user.findUnique({
      where: { ssoSubject: token.subject },
      select,
    });
    if (bySubject) {
      if (bySubject.ssoIssuer !== token.issuer) {
        throw new SsoInvalidError('Aussteller passt nicht zum verknüpften Konto.');
      }
      return bySubject;
    }

    // NOTZUGANGSKONTEN WERDEN NIE PER ADRESSE VERKNÜPFT. Das Konto ist der
    // Rückweg bei Portalausfall und hat bewusst keinen Portal-Bezug. Würde es
    // verknüpft, könnte jede Person, die im Portal ein Konto mit dieser Adresse
    // hat, es übernehmen, und bei jeder Anmeldung würde seine Rolle aus dem
    // Portal überschrieben (auch herabgesetzt). Gewählt ist "nie verknüpfen"
    // statt "Rolle nie herabsetzen": letzteres ließe die Übernahme bestehen.
    const emergencyAccount = await this.prisma.user.findFirst({
      where: { email: token.email, emergency: true },
      select: { id: true },
    });
    if (emergencyAccount) {
      throw new SsoInvalidError(
        'Adresse gehört einem Notzugangskonto, das nicht über das Portal angemeldet wird.',
      );
    }

    const local = await this.prisma.user.findFirst({
      where: { email: token.email, ssoSubject: null, emergency: false },
      select,
    });
    if (local) {
      return this.prisma.user.update({
        where: { id: local.id },
        data: { ssoSubject: token.subject, ssoIssuer: token.issuer },
        select,
      });
    }

    const taken = await this.prisma.user.findFirst({
      where: { OR: [{ email: token.email }, { username: token.email }] },
      select: { id: true },
    });
    if (taken) {
      // Die Adresse gehört schon einem Konto, das an ein ANDERES Portal-Konto
      // gebunden ist. Nicht überschreiben, nicht doppelt anlegen.
      throw new SsoInvalidError('Adresse gehört einem anderen verknüpften Konto.');
    }
    const created = await this.prisma.user.create({
      data: {
        name: token.name,
        email: token.email,
        username: token.email,
        role: 'administrator',
        accessRole: role,
        ssoSubject: token.subject,
        ssoIssuer: token.issuer,
      },
      select,
    });
    await this.audit.log({
      userId: created.id,
      actor: 'sso',
      action: AUDIT_ACTION.userRegistered,
      objectType: 'User',
      objectId: created.id,
      afterValue: { reason: 'sso-first-login' },
      ip: null,
      userAgent: null,
    });
    return created;
  }

  // -------------------------------------------------------------------------
  // Step-up
  // -------------------------------------------------------------------------

  private async completeStepUp(
    flow: FlowCookie,
    token: VerifiedIdToken,
    startedAt: Date,
    source: InquirySource,
  ): Promise<SsoCallbackResult> {
    if (!flow.ssn) throw new SsoInvalidError('Step-up ohne laufende Sitzung.');
    const running = await this.ssoSessions.findRunning(flow.ssn);
    if (!running) throw new SsoInvalidError('Step-up: Sitzung beendet.');
    if (
      running.user.ssoSubject !== token.subject ||
      running.user.ssoIssuer !== token.issuer
    ) {
      throw new SsoInvalidError('Step-up: Token gehört zu einem anderen Konto.');
    }
    // Nur ein Nachweis NACH dem Start dieses Step-ups zählt — ein älterer
    // Durchlauf, der durch eine bestehende Portal-Sitzung „durchgerutscht"
    // wäre, beweist nichts.
    if (token.authTime < Math.floor(startedAt.getTime() / 1000)) {
      throw new SsoInvalidError('Step-up: auth_time liegt vor dem Start.');
    }
    if (!hasSecondFactor(token.amr)) {
      throw new SsoInvalidError('Step-up: kein zweiter Faktor im amr.');
    }
    const marked = await this.ssoSessions.markStepUp(
      running.id,
      new Date(),
      token.sid,
    );
    if (!marked) throw new SsoInvalidError('Step-up: Sitzung beendet.');

    await this.audit.log({
      userId: running.user.id,
      actor: running.user.username,
      action: AUDIT_ACTION.ssoStepUpSuccess,
      objectType: 'User',
      objectId: running.user.id,
      afterValue: { amr: token.amr, sid: token.sid },
      ip: source.ip,
      userAgent: source.userAgent,
    });
    return { kind: 'step-up', returnPath: flow.ret };
  }

  // -------------------------------------------------------------------------
  // Abmelden
  // -------------------------------------------------------------------------

  /** Die Adresse, zu der der Browser nach dem Beenden der Sitzung geschickt wird. */
  portalLogoutUrl(): string {
    return portalLogoutUrl(this.settings);
  }

  /**
   * Front-Channel-Logout: das Portal meldet, dass seine Sitzung `sid` zu Ende
   * ist. Alle Sitzungen der Verwaltung mit dieser `sid` enden.
   *
   * Antwortet NIE mit einem Fehler, wenn nichts zu beenden war: sonst ließe sich
   * damit abfragen, ob eine `sid` bekannt ist.
   */
  async frontChannelLogout(
    issuer: unknown,
    sid: unknown,
    source: InquirySource,
  ): Promise<{ ended: number }> {
    if (
      typeof issuer !== 'string' ||
      issuer.replace(/\/+$/, '') !== this.settings.issuer ||
      typeof sid !== 'string' ||
      sid === '' ||
      sid.length > 200
    ) {
      return { ended: 0 };
    }
    const ended = await this.ssoSessions.endBySid(sid);
    if (ended > 0) {
      await this.audit.log({
        userId: null,
        actor: 'sso',
        action: AUDIT_ACTION.ssoFrontChannelLogout,
        objectType: 'SsoSession',
        objectId: null,
        afterValue: { endedSessions: ended },
        ip: source.ip,
        userAgent: source.userAgent,
      });
    }
    return { ended };
  }
}
