import { Inject, Injectable } from '@nestjs/common';
import type { OidcClient, PortalSession, Account } from '.prisma/portal-auth-client';
import { generateToken, hashToken, verifyAgainstDummy, verifyPasswordOrFalse } from '@saas-instant/auth-core';
import { AccountsService } from '../accounts/accounts.service';
import { AuditService } from '../audit/audit.service';
import { CONFIG, PortalConfig } from '../config';
import { KeysService, ID_TOKEN_TTL_SECONDS } from '../keys/keys.service';
import { PrismaService } from '../prisma.service';
import { SessionsService, SessionView } from '../sessions/sessions.service';
import { isValidChallenge, verifyPkce } from './pkce';

/** Ein Code gilt 60 Sekunden und genau einmal. */
export const AUTH_CODE_TTL_MS = 60 * 1000;
/** Wartende Authorize-Anfrage (Anmeldung dazwischen). */
export const AUTH_REQUEST_TTL_MS = 10 * 60 * 1000;

export interface AuthorizeParams {
  clientId: string;
  redirectUri: string;
  state: string;
  nonce: string;
  codeChallenge: string;
  scope: string;
  maxAge: number | null;
  prompt: string[];
}

/** Ergebnis von authorize/continue: Weiterleitung oder direkte Fehlerseite (kein Redirect möglich). */
export type AuthorizeOutcome =
  | { kind: 'redirect'; url: string }
  | { kind: 'error'; status: number; error: string; description: string };

export class OAuthError extends Error {
  constructor(
    readonly status: number,
    readonly error: string,
    readonly description: string,
  ) {
    super(description);
  }
}

const str = (value: unknown, max = 2048): string | null =>
  typeof value === 'string' && value.length > 0 && value.length <= max ? value : null;

export interface LogoutOutcome {
  target: string;
  /** Vollständige Front-Channel-Adressen (mit iss und sid) für die unsichtbaren iframes. */
  frontchannel: string[];
}

@Injectable()
export class OidcService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly keys: KeysService,
    private readonly sessions: SessionsService,
    private readonly accounts: AccountsService,
    private readonly audit: AuditService,
    @Inject(CONFIG) private readonly config: PortalConfig,
  ) {}

  discovery() {
    const iss = this.config.issuer;
    return {
      issuer: iss,
      authorization_endpoint: `${iss}/oauth/authorize`,
      token_endpoint: `${iss}/oauth/token`,
      jwks_uri: `${iss}/.well-known/jwks.json`,
      end_session_endpoint: `${iss}/oauth/logout`,
      response_types_supported: ['code'],
      response_modes_supported: ['query'],
      grant_types_supported: ['authorization_code'],
      subject_types_supported: ['public'],
      id_token_signing_alg_values_supported: ['EdDSA'],
      scopes_supported: ['openid'],
      token_endpoint_auth_methods_supported: ['client_secret_post'],
      code_challenge_methods_supported: ['S256'],
      claims_supported: ['iss', 'aud', 'sub', 'exp', 'iat', 'nonce', 'auth_time', 'amr', 'sid', 'email', 'name', 'roles'],
      frontchannel_logout_supported: true,
      frontchannel_logout_session_supported: true,
      authorization_response_iss_parameter_supported: true,
    };
  }

  // -------- /oauth/authorize ----------------------------------------------------

  private redirectWith(redirectUri: string, params: Record<string, string | undefined>): string {
    const url = new URL(redirectUri);
    for (const [key, value] of Object.entries(params)) if (value !== undefined) url.searchParams.set(key, value);
    return url.toString();
  }

  private errorRedirect(p: { redirectUri: string; state?: string }, error: string, description: string): AuthorizeOutcome {
    return {
      kind: 'redirect',
      url: this.redirectWith(p.redirectUri, { error, error_description: description, state: p.state, iss: this.config.issuer }),
    };
  }

  async authorize(query: Record<string, unknown>, sessionToken: string | undefined): Promise<AuthorizeOutcome> {
    const clientId = str(query.client_id, 128);
    const redirectUri = str(query.redirect_uri);
    const client = clientId ? await this.prisma.oidcClient.findUnique({ where: { id: clientId } }) : null;
    // Ohne gesicherte Rückkehradresse darf NICHT weitergeleitet werden (Open Redirect).
    if (!client || !redirectUri || !client.redirectUris.includes(redirectUri)) {
      await this.audit.log({ action: 'authorize.rejected', clientId, detail: { reason: 'client_or_redirect_uri' } });
      return { kind: 'error', status: 400, error: 'invalid_request', description: 'client_id oder redirect_uri sind unbekannt.' };
    }
    const state = str(query.state, 512) ?? undefined;
    const fail = (error: string, description: string) => this.errorRedirect({ redirectUri, state }, error, description);

    if (query.response_type !== 'code') return fail('unsupported_response_type', 'Nur response_type=code ist erlaubt.');
    if (!state) return fail('invalid_request', 'state fehlt.');
    const scope = str(query.scope, 512) ?? '';
    if (!scope.split(' ').includes('openid')) return fail('invalid_scope', 'scope muss openid enthalten.');
    const challenge = str(query.code_challenge, 128);
    if (!challenge || !isValidChallenge(challenge) || query.code_challenge_method !== 'S256') {
      return fail('invalid_request', 'PKCE mit code_challenge_method=S256 ist Pflicht.');
    }
    const nonce = str(query.nonce, 512);
    if (!nonce) return fail('invalid_request', 'nonce fehlt.');
    let maxAge: number | null = null;
    if (query.max_age !== undefined) {
      const raw = str(query.max_age, 12);
      if (!raw || !/^\d+$/.test(raw)) return fail('invalid_request', 'max_age muss eine ganze Zahl >= 0 sein.');
      maxAge = Number(raw);
    }
    const prompt = (str(query.prompt, 64) ?? '').split(' ').filter(Boolean);
    const params: AuthorizeParams = { clientId: client.id, redirectUri, state, nonce, codeChallenge: challenge, scope, maxAge, prompt };

    const view = sessionToken ? await this.sessions.resolve(sessionToken) : null;
    const stale = !!view && this.mustReauthenticate(params, view.session);
    if (prompt.includes('none') && (!view || stale)) {
      return fail(view ? 'interaction_required' : 'login_required', 'Anmeldung nötig.');
    }
    if (view && !stale) return this.issueCode(client, params, view);

    // Anmeldung nötig: Anfrage merken, Anmeldeseite des Portals zeigen. Mit
    // bestehender Sitzung ist das ein Step-up für GENAU dieses Konto.
    const now = new Date();
    const request = await this.prisma.authRequest.create({
      data: {
        params: params as unknown as object,
        expectedAccountId: view ? view.account.id : null,
        freshAfter: view ? now : null,
        expiresAt: new Date(now.getTime() + AUTH_REQUEST_TTL_MS),
      },
    });
    const login = new URL(`${this.config.issuer}/auth/login`);
    login.searchParams.set('req', request.id);
    if (view) login.searchParams.set('stepup', '1');
    return { kind: 'redirect', url: login.toString() };
  }

  /** prompt=login oder ein überschrittenes max_age (0 = immer) verlangt einen frischen Faktor. */
  private mustReauthenticate(params: AuthorizeParams, session: PortalSession, now: Date = new Date()): boolean {
    if (params.prompt.includes('login')) return true;
    if (params.maxAge === null) return false;
    if (params.maxAge === 0) return true;
    return now.getTime() - session.authTime.getTime() > params.maxAge * 1000;
  }

  /** Rückkehr von der Anmeldeseite: die gemerkte Anfrage fortsetzen. */
  async continueRequest(reqId: string | null, sessionToken: string | undefined): Promise<AuthorizeOutcome> {
    const bad = (description: string): AuthorizeOutcome => ({ kind: 'error', status: 400, error: 'invalid_request', description });
    if (!reqId) return bad('Die Anmeldeanfrage fehlt.');
    const request = await this.prisma.authRequest.findUnique({ where: { id: reqId } }).catch(() => null);
    if (!request || request.consumedAt || request.expiresAt <= new Date()) {
      return bad('Die Anmeldeanfrage ist abgelaufen. Bitte in der Verwaltung neu starten.');
    }
    const params = request.params as unknown as AuthorizeParams;
    const view = sessionToken ? await this.sessions.resolve(sessionToken) : null;
    const login = new URL(`${this.config.issuer}/auth/login`);
    login.searchParams.set('req', request.id);
    if (!view) return { kind: 'redirect', url: login.toString() };
    // Step-up: erst zählen, wenn der Faktor NACH dem Beginn der Anfrage nachgewiesen wurde.
    const tooOld = !!request.freshAfter && view.session.authTime < request.freshAfter;
    const wrongAccount = !!request.expectedAccountId && view.account.id !== request.expectedAccountId;
    if (tooOld || wrongAccount) {
      login.searchParams.set('stepup', '1');
      return { kind: 'redirect', url: login.toString() };
    }
    const client = await this.prisma.oidcClient.findUnique({ where: { id: params.clientId } });
    if (!client || !client.redirectUris.includes(params.redirectUri)) return bad('Die Verwaltung ist nicht mehr registriert.');
    const consumed = await this.prisma.authRequest.updateMany({ where: { id: request.id, consumedAt: null }, data: { consumedAt: new Date() } });
    if (consumed.count !== 1) return bad('Die Anmeldeanfrage wurde schon verwendet.');
    return this.issueCode(client, params, view);
  }

  private async issueCode(client: OidcClient, params: AuthorizeParams, view: SessionView): Promise<AuthorizeOutcome> {
    const code = generateToken();
    await this.prisma.authCode.create({
      data: {
        codeHash: hashToken(code),
        clientId: client.id,
        redirectUri: params.redirectUri,
        codeChallenge: params.codeChallenge,
        nonce: params.nonce,
        sessionId: view.session.id,
        accountId: view.account.id,
        authTime: view.session.authTime,
        amr: view.session.amr,
        expiresAt: new Date(Date.now() + AUTH_CODE_TTL_MS),
      },
    });
    await this.prisma.sessionClient.upsert({
      where: { sessionId_clientId: { sessionId: view.session.id, clientId: client.id } },
      create: { sessionId: view.session.id, clientId: client.id },
      update: {},
    });
    await this.audit.log({ action: 'authorize.code_issued', accountId: view.account.id, clientId: client.id });
    return { kind: 'redirect', url: this.redirectWith(params.redirectUri, { code, state: params.state, iss: this.config.issuer }) };
  }

  // -------- /oauth/token ----------------------------------------------------------

  async token(body: Record<string, unknown>): Promise<{ id_token: string; token_type: 'Bearer'; expires_in: number }> {
    if (body.grant_type !== 'authorization_code') {
      throw new OAuthError(400, 'unsupported_grant_type', 'Nur authorization_code wird unterstützt.');
    }
    const clientId = str(body.client_id, 128);
    const secret = str(body.client_secret, 512);
    const client = clientId ? await this.prisma.oidcClient.findUnique({ where: { id: clientId } }) : null;
    if (!client || !secret) {
      await verifyAgainstDummy(secret ?? '');
      await this.audit.log({ action: 'token.rejected', clientId, detail: { reason: 'client' } });
      throw new OAuthError(401, 'invalid_client', 'Clientauthentifizierung fehlgeschlagen.');
    }
    if (!(await verifyPasswordOrFalse(client.secretHash, secret))) {
      await this.audit.log({ action: 'token.rejected', clientId: client.id, detail: { reason: 'secret' } });
      throw new OAuthError(401, 'invalid_client', 'Clientauthentifizierung fehlgeschlagen.');
    }
    const code = str(body.code, 512);
    const redirectUri = str(body.redirect_uri);
    const verifier = str(body.code_verifier, 200);
    if (!code || !redirectUri || !verifier) throw new OAuthError(400, 'invalid_request', 'code, redirect_uri und code_verifier sind Pflicht.');

    // EINLÖSEN ZUERST: atomar und einmalig. Wer den Code kennt, bekommt keinen
    // zweiten Versuch mit anderem Verifier oder anderer Adresse.
    const now = new Date();
    const claimed = await this.prisma.authCode.updateMany({
      where: { codeHash: hashToken(code), consumedAt: null, expiresAt: { gt: now } },
      data: { consumedAt: now },
    });
    const invalidGrant = async (reason: string) => {
      await this.audit.log({ action: 'token.rejected', clientId: client.id, detail: { reason } });
      return new OAuthError(400, 'invalid_grant', 'Der Code ist ungültig, abgelaufen oder schon verwendet.');
    };
    if (claimed.count !== 1) throw await invalidGrant('code_unavailable');
    const row = await this.prisma.authCode.findUniqueOrThrow({ where: { codeHash: hashToken(code) } });
    if (row.clientId !== client.id) throw await invalidGrant('client_mismatch');
    if (row.redirectUri !== redirectUri) throw await invalidGrant('redirect_uri_mismatch');
    if (!verifyPkce(verifier, row.codeChallenge)) throw await invalidGrant('pkce');

    const session = await this.prisma.portalSession.findUnique({ where: { id: row.sessionId }, include: { account: true } });
    if (!session || session.revokedAt || session.account.disabledAt) throw await invalidGrant('session_ended');

    const idToken = await this.keys.signIdToken(await this.claimsFor(row, session.account, client), this.config.issuer, client.id, now);
    await this.audit.log({ action: 'token.issued', accountId: session.account.id, clientId: client.id });
    return { id_token: idToken, token_type: 'Bearer', expires_in: ID_TOKEN_TTL_SECONDS };
  }

  /** `roles` enthält nur die Rolle in DIESER Verwaltung; keine Auskunft über andere. */
  private async claimsFor(
    row: { nonce: string; authTime: Date; amr: string[]; sessionId: string },
    account: Account,
    client: OidcClient,
  ): Promise<Record<string, unknown>> {
    const all = await this.accounts.rolesOf(account.id);
    return {
      sub: account.id,
      nonce: row.nonce,
      auth_time: Math.floor(row.authTime.getTime() / 1000),
      amr: row.amr,
      sid: row.sessionId,
      email: account.email,
      name: account.name,
      roles: all[client.id] ? { [client.id]: all[client.id] } : {},
    };
  }

  // -------- /oauth/logout -----------------------------------------------------------

  async logout(query: Record<string, unknown>, sessionToken: string | undefined): Promise<LogoutOutcome> {
    const clientId = str(query.client_id, 128);
    const requested = str(query.post_logout_redirect_uri);
    const client = clientId ? await this.prisma.oidcClient.findUnique({ where: { id: clientId } }) : null;
    let target = `${this.config.issuer}/auth/login`;
    if (client && requested && client.postLogoutRedirectUris.includes(requested)) {
      const url = new URL(requested);
      const state = str(query.state, 512);
      if (state) url.searchParams.set('state', state);
      target = url.toString();
    }

    const frontchannel: string[] = [];
    const found = sessionToken
      ? await this.prisma.portalSession.findUnique({ where: { tokenHash: hashToken(sessionToken) }, include: { clients: { include: { client: true } } } })
      : null;
    if (found) {
      for (const link of found.clients) {
        const uri = link.client.frontchannelLogoutUri;
        if (!uri) continue;
        const url = new URL(uri);
        url.searchParams.set('iss', this.config.issuer);
        url.searchParams.set('sid', found.id);
        frontchannel.push(url.toString());
      }
      await this.sessions.revoke(found.id);
      await this.audit.log({ action: 'logout', accountId: found.accountId, clientId, detail: { frontchannel: frontchannel.length } });
    }
    return { target, frontchannel };
  }
}
