import { jwtVerify } from 'jose';
import type { JWTPayload, JWTVerifyGetKey } from 'jose';

/** Rolle dieses Kontos in dieser Verwaltung, wie das Portal sie vergibt. */
export type PortalRole = 'admin' | 'staff';

/** Die geprüften Angaben eines ID-Tokens, so wie die Verwaltung sie braucht. */
export interface VerifiedIdToken {
  issuer: string;
  /** Stabile Konto-ID des Portals. */
  subject: string;
  email: string;
  name: string;
  /** Sekunden seit Epoche: wann sich die Person zuletzt wirklich ausgewiesen hat. */
  authTime: number;
  /** Verfahren der Anmeldung: `pwd`, `otp`, `hwk` (Passkey). */
  amr: string[];
  /** Portal-Sitzungs-ID — Schlüssel für den Front-Channel-Logout. */
  sid: string;
  /** Rolle in DIESER Verwaltung; `null` = das Konto hat hier keine Rolle. */
  role: PortalRole | null;
}

/** Warum ein Token abgewiesen wurde. Geht ins Audit-Log, nie zum Client. */
export class IdTokenError extends Error {
  constructor(
    readonly reason: string,
    cause?: unknown,
  ) {
    super(reason, cause === undefined ? undefined : { cause });
    this.name = 'IdTokenError';
  }
}

export interface IdTokenExpectation {
  issuer: string;
  clientId: string;
  nonce: string;
  /** Für Tests: der Zeitpunkt „jetzt". */
  now?: Date;
}

/** Toleranz für `iat` in der Zukunft (Uhrenabweichung zwischen Portal und Verwaltung). */
export const IAT_TOLERANCE_SECONDS = 60;

/** Zweiter Faktor im `amr`: Code aus der Authenticator-App oder Passkey. */
const SECOND_FACTORS = new Set(['otp', 'hwk']);

/** Enthält `amr` einen zweiten Faktor? Ein Passkey (`hwk`) zählt für sich allein. */
export function hasSecondFactor(amr: readonly string[]): boolean {
  return amr.some((value) => SECOND_FACTORS.has(value));
}

function text(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new IdTokenError(`Angabe "${field}" fehlt oder ist leer.`);
  }
  return value;
}

/**
 * Prüft ein ID-Token vollständig.
 *
 * Signatur (nur EdDSA, Schlüssel über JWKS), `iss`, `aud`, `exp`, `iat` (mit
 * 60 s Toleranz in die Zukunft), `nonce`, nicht leeres `amr` sowie die
 * Pflichtangaben `sub`, `sid`, `auth_time`. Die Rolle wird aus
 * `roles[client_id]` gelesen; fehlt sie, ist `role` null — das ist KEIN
 * Prüffehler, sondern „kein Zugriff auf diese Verwaltung".
 *
 * Wirft `IdTokenError`; der Grund ist für das Audit-Log gedacht und darf nie
 * an den Client gehen.
 */
export async function verifyIdToken(
  token: string,
  key: JWTVerifyGetKey,
  expectation: IdTokenExpectation,
): Promise<VerifiedIdToken> {
  const now = expectation.now ?? new Date();
  let payload: JWTPayload;
  try {
    ({ payload } = await jwtVerify(token, key, {
      algorithms: ['EdDSA'],
      issuer: expectation.issuer,
      audience: expectation.clientId,
      currentDate: now,
      // `exp` ohne Nachsicht: das Token lebt ohnehin nur fünf Minuten.
      clockTolerance: 0,
      requiredClaims: ['exp', 'iat', 'sub', 'nonce'],
    }));
  } catch (error) {
    const code =
      error !== null && typeof error === 'object' && 'code' in error
        ? String((error as { code: unknown }).code)
        : 'unbekannt';
    const claim =
      error !== null && typeof error === 'object' && 'claim' in error
        ? String((error as { claim: unknown }).claim)
        : '';
    throw new IdTokenError(
      `Token abgewiesen (${code}${claim === '' ? '' : `, Claim ${claim}`}).`,
      error,
    );
  }

  const nowSeconds = Math.floor(now.getTime() / 1000);
  if (
    typeof payload.iat !== 'number' ||
    payload.iat > nowSeconds + IAT_TOLERANCE_SECONDS
  ) {
    throw new IdTokenError('Ausstellungszeitpunkt (iat) liegt in der Zukunft.');
  }
  if (payload['nonce'] !== expectation.nonce) {
    throw new IdTokenError('nonce passt nicht zum Durchlauf.');
  }

  const amrRaw = payload['amr'];
  if (
    !Array.isArray(amrRaw) ||
    amrRaw.length === 0 ||
    !amrRaw.every((entry) => typeof entry === 'string' && entry !== '')
  ) {
    throw new IdTokenError('amr fehlt oder ist leer.');
  }
  const authTime = payload['auth_time'];
  if (typeof authTime !== 'number' || !Number.isFinite(authTime)) {
    throw new IdTokenError('auth_time fehlt.');
  }

  const rolesRaw = payload['roles'];
  let role: PortalRole | null = null;
  if (rolesRaw !== null && typeof rolesRaw === 'object' && !Array.isArray(rolesRaw)) {
    const entry = (rolesRaw as Record<string, unknown>)[expectation.clientId];
    if (entry === 'admin' || entry === 'staff') role = entry;
  }

  return {
    issuer: expectation.issuer,
    subject: text(payload.sub, 'sub'),
    email: text(payload['email'], 'email').trim().toLowerCase(),
    name: text(payload['name'], 'name').trim(),
    authTime,
    amr: amrRaw as string[],
    sid: text(payload['sid'], 'sid'),
    role,
  };
}
