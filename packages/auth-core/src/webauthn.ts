import {
  generateAuthenticationOptions,
  generateRegistrationOptions,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
} from '@simplewebauthn/server';
import type {
  AuthenticationResponseJSON,
  AuthenticatorTransportFuture,
  PublicKeyCredentialCreationOptionsJSON,
  PublicKeyCredentialRequestOptionsJSON,
  RegistrationResponseJSON,
} from '@simplewebauthn/server';

export type {
  AuthenticationResponseJSON,
  PublicKeyCredentialCreationOptionsJSON,
  PublicKeyCredentialRequestOptionsJSON,
  RegistrationResponseJSON,
};

/** Gespeicherte Anmeldedaten in der Form, die WebAuthn zum Prüfen braucht. */
export interface StoredPasskey {
  id: string;
  credentialId: string;
  /** Öffentlicher Schlüssel, base64-kodiert. */
  publicKey: string;
  counter: number;
  /** Kommagetrennt, wie `transportsToText` es schreibt. */
  transports: string | null;
}

/** Ergebnis einer geprüften Registrierung. */
export interface VerifiedPasskeyRegistration {
  credentialId: string;
  publicKeyBase64: string;
  counter: number;
  transports: string | null;
}

/** Die Relying-Party-Angaben; ein falscher Wert hebt die Domain-Bindung auf. */
export interface RelyingParty {
  rpId: string;
  /** Erwarteter Origin, z. B. `https://verwaltung.example.com`. */
  origin: string;
}

/** Kommagetrennte Transporte → Liste (oder undefined, wenn leer). */
export function transportsFromText(
  text: string | null,
): AuthenticatorTransportFuture[] | undefined {
  if (!text) return undefined;
  const parts = text
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
  return parts.length > 0
    ? (parts as AuthenticatorTransportFuture[])
    : undefined;
}

/** Transporte der Registrierungsantwort → Text zum Speichern (oder null). */
export function transportsToText(
  transports: readonly string[] | undefined,
): string | null {
  return transports?.join(',') ?? null;
}

/** Erzeugt die Optionen für `navigator.credentials.create()`. */
export async function createRegistrationOptions(params: {
  rpName: string;
  rpId: string;
  user: { id: string; email: string; name: string };
  existing: readonly StoredPasskey[];
}): Promise<PublicKeyCredentialCreationOptionsJSON> {
  return generateRegistrationOptions({
    rpName: params.rpName,
    rpID: params.rpId,
    userName: params.user.email,
    userDisplayName: params.user.name,
    userID: new TextEncoder().encode(params.user.id),
    attestationType: 'none',
    excludeCredentials: params.existing.map((passkey) => ({
      id: passkey.credentialId,
      transports: transportsFromText(passkey.transports),
    })),
    authenticatorSelection: {
      // 'required', nicht 'preferred': die Anmeldung gibt bewusst KEINE
      // `allowCredentials` mit (sonst verriete deren Länge die Existenz eines
      // Kontos). Ein nicht auffindbarer Passkey wäre damit unbenutzbar — er
      // muss also auffindbar auf dem Gerät liegen.
      residentKey: 'required',
      // 'required', weil @simplewebauthn v13 serverseitig
      // `requireUserVerification: true` voreingestellt hat.
      userVerification: 'required',
    },
  });
}

/**
 * Prüft die Antwort des Browsers auf eine Registrierung. Liefert null, wenn
 * die Prüfung scheitert — der Aufrufer entscheidet über Fehlermeldung und
 * Audit-Eintrag.
 */
export async function checkRegistrationResponse(
  response: RegistrationResponseJSON,
  expectedChallenge: string,
  relyingParty: RelyingParty,
): Promise<VerifiedPasskeyRegistration | null> {
  let result;
  try {
    result = await verifyRegistrationResponse({
      response,
      expectedChallenge,
      expectedOrigin: relyingParty.origin,
      expectedRPID: relyingParty.rpId,
    });
  } catch {
    return null;
  }
  if (!result.verified) return null;

  const { credential } = result.registrationInfo;
  return {
    credentialId: credential.id,
    publicKeyBase64: Buffer.from(credential.publicKey).toString('base64'),
    counter: credential.counter,
    transports: transportsToText(response.response.transports),
  };
}

/**
 * Erzeugt die Optionen für `navigator.credentials.get()`. Ohne bekannte
 * Passkeys bleibt `allowCredentials` leer — der Browser fragt dann selbst,
 * welcher auffindbare Passkey verwendet werden soll.
 */
export async function createLoginOptions(
  rpId: string,
  passkeys: readonly StoredPasskey[],
): Promise<PublicKeyCredentialRequestOptionsJSON> {
  return generateAuthenticationOptions({
    rpID: rpId,
    // Muss zur serverseitigen Erwartung passen, siehe createRegistrationOptions.
    userVerification: 'required',
    allowCredentials: passkeys.map((passkey) => ({
      id: passkey.credentialId,
      transports: transportsFromText(passkey.transports),
    })),
  });
}

/**
 * Prüft eine Anmeldeantwort gegen einen gespeicherten Passkey. Liefert den
 * neuen Zähler oder null, wenn die Prüfung scheitert. Das Fortschreiben des
 * Zählers gehört dem Aufrufer.
 */
export async function checkLoginResponse(
  response: AuthenticationResponseJSON,
  expectedChallenge: string,
  passkey: StoredPasskey,
  relyingParty: RelyingParty,
): Promise<{ newCounter: number } | null> {
  let result;
  try {
    result = await verifyAuthenticationResponse({
      response,
      expectedChallenge,
      expectedOrigin: relyingParty.origin,
      expectedRPID: relyingParty.rpId,
      credential: {
        id: passkey.credentialId,
        publicKey: new Uint8Array(Buffer.from(passkey.publicKey, 'base64')),
        counter: passkey.counter,
        transports: transportsFromText(passkey.transports),
      },
    });
  } catch {
    return null;
  }
  if (!result.verified) return null;
  return { newCounter: result.authenticationInfo.newCounter };
}
