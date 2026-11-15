import { t } from '../i18n';
/**
 * Schmale WebAuthn-Brücke zwischen Browser-API und JSON-Vertrag des Backends.
 *
 * Bewusst ohne `@simplewebauthn/browser`: die Umwandlung zwischen base64url und
 * ArrayBuffer sind rund vierzig Zeilen, und eine zusätzliche Abhängigkeit für
 * diesen Umfang wäre nicht gerechtfertigt. Der Server nutzt weiterhin
 * `@simplewebauthn/server`; das Drahtformat ist auf beiden Seiten dasselbe
 * JSON (base64url-kodierte Binärfelder).
 */

/** Anmeldeoptionen, wie sie das Backend als JSON liefert. */
export interface LoginOptionsJson {
  challenge: string;
  timeout?: number;
  rpId?: string;
  userVerification?: UserVerificationRequirement;
  allowCredentials?: { id: string; type: 'public-key'; transports?: string[] }[];
}

/** Registrieroptionen, wie sie das Backend als JSON liefert. */
export interface RegisterOptionsJson {
  challenge: string;
  rp: { id?: string; name: string };
  user: { id: string; name: string; displayName: string };
  pubKeyCredParams: { alg: number; type: 'public-key' }[];
  timeout?: number;
  attestation?: AttestationConveyancePreference;
  excludeCredentials?: { id: string; type: 'public-key'; transports?: string[] }[];
  authenticatorSelection?: {
    authenticatorAttachment?: AuthenticatorAttachment;
    residentKey?: ResidentKeyRequirement;
    requireResidentKey?: boolean;
    userVerification?: UserVerificationRequirement;
  };
}

/** Die JSON-Antwort, die das Backend erwartet (`antwort`-Feld der DTOs). */
export type WebauthnResponse = Record<string, unknown>;

/** Unterstützt dieser Browser Passkeys? */
export function passkeysPossible(): boolean {
  return (
    typeof window !== 'undefined' &&
    typeof window.PublicKeyCredential !== 'undefined'
  );
}

/**
 * Fehler beim Passkey-Vorgang. Getrennt von `ApiError`, weil er nicht vom
 * Server kommt, sondern vom Browser (Abbruch, kein passender Passkey, …).
 */
export class PasskeyError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'PasskeyError';
  }
}

function fromBase64Url(value: string): ArrayBuffer {
  const base64 = value.replace(/-/g, '+').replace(/_/g, '/');
  const padded = base64.padEnd(
    base64.length + ((4 - (base64.length % 4)) % 4),
    '=',
  );
  const raw = atob(padded);
  const bytes = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i += 1) bytes[i] = raw.charCodeAt(i);
  return bytes.buffer;
}

function toBase64Url(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  let raw = '';
  for (const byte of bytes) raw += String.fromCharCode(byte);
  return btoa(raw).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function asDescriptors(
  list: { id: string; type: 'public-key'; transports?: string[] }[] | undefined,
): PublicKeyCredentialDescriptor[] | undefined {
  return list?.map((entry) => ({
    id: fromBase64Url(entry.id),
    type: entry.type,
    transports: entry.transports as AuthenticatorTransport[] | undefined,
  }));
}

/**
 * Führt eine Passkey-Anmeldung durch und gibt die Antwort im JSON-Format
 * zurück. Wirft `PasskeyFehler`, wenn der Vorgang abgebrochen wurde.
 */
export async function passkeyLogin(
  options: LoginOptionsJson,
): Promise<WebauthnResponse> {
  let credentials: Credential | null;
  try {
    credentials = await navigator.credentials.get({
      publicKey: {
        challenge: fromBase64Url(options.challenge),
        timeout: options.timeout,
        rpId: options.rpId,
        userVerification: options.userVerification,
        allowCredentials: asDescriptors(options.allowCredentials),
      },
    });
  } catch (error) {
    throw new PasskeyError(t('common.webauthn.text'), {
      cause: error,
    });
  }

  if (
    !(credentials instanceof PublicKeyCredential) ||
    !(credentials.response instanceof AuthenticatorAssertionResponse)
  ) {
    throw new PasskeyError(t('common.webauthn.text2'));
  }

  const response = credentials.response;
  return {
    id: credentials.id,
    rawId: toBase64Url(credentials.rawId),
    type: credentials.type,
    clientExtensionResults: credentials.getClientExtensionResults(),
    authenticatorAttachment: credentials.authenticatorAttachment ?? undefined,
    response: {
      clientDataJSON: toBase64Url(response.clientDataJSON),
      authenticatorData: toBase64Url(response.authenticatorData),
      signature: toBase64Url(response.signature),
      userHandle: response.userHandle ? toBase64Url(response.userHandle) : undefined,
    },
  };
}

/**
 * Legt einen neuen Passkey an und gibt die Registrierantwort im JSON-Format
 * zurück. Wirft `PasskeyFehler`, wenn der Vorgang abgebrochen wurde.
 */
export async function passkeyEnrollment(
  options: RegisterOptionsJson,
): Promise<WebauthnResponse> {
  let credentials: Credential | null;
  try {
    credentials = await navigator.credentials.create({
      publicKey: {
        challenge: fromBase64Url(options.challenge),
        rp: options.rp,
        user: {
          id: fromBase64Url(options.user.id),
          name: options.user.name,
          displayName: options.user.displayName,
        },
        pubKeyCredParams: options.pubKeyCredParams,
        timeout: options.timeout,
        attestation: options.attestation,
        excludeCredentials: asDescriptors(options.excludeCredentials),
        authenticatorSelection: options.authenticatorSelection,
      },
    });
  } catch (error) {
    throw new PasskeyError(t('common.webauthn.text'), {
      cause: error,
    });
  }

  if (
    !(credentials instanceof PublicKeyCredential) ||
    !(credentials.response instanceof AuthenticatorAttestationResponse)
  ) {
    throw new PasskeyError(t('common.webauthn.text2'));
  }

  const response = credentials.response;
  return {
    id: credentials.id,
    rawId: toBase64Url(credentials.rawId),
    type: credentials.type,
    clientExtensionResults: credentials.getClientExtensionResults(),
    authenticatorAttachment: credentials.authenticatorAttachment ?? undefined,
    response: {
      clientDataJSON: toBase64Url(response.clientDataJSON),
      attestationObject: toBase64Url(response.attestationObject),
      transports: response.getTransports?.() ?? [],
    },
  };
}
