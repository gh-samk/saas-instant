import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { APP_NAME_DEFAULT, APP_URL_DEFAULT } from '../common/app-defaults';
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
import { PrismaService } from '../prisma/prisma.service';

/** Gespeicherte Anmeldedaten in der Form, die WebAuthn zum Prüfen braucht. */
export interface StoredPasskey {
  id: string;
  credentialId: string;
  publicKey: string;
  counter: number;
  transports: string | null;
}

/** Ergebnis einer geprüften Registrierung. */
export interface VerifiedPasskeyRegistration {
  credentialId: string;
  publicKeyBase64: string;
  counter: number;
  transports: string | null;
}

function transportsFromText(text: string | null): AuthenticatorTransportFuture[] | undefined {
  if (!text) return undefined;
  const parts = text
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
  return parts.length > 0 ? (parts as AuthenticatorTransportFuture[]) : undefined;
}

/**
 * Passkeys (WebAuthn) als Hauptweg der Anmeldung.
 *
 * `rpID` und `origin` kommen aus der Umgebung: Produktion
 * `verwaltung.example.com`, Entwicklung `localhost`. Beides sind
 * Pflichtangaben — ein falscher Wert würde die Bindung an die Domain
 * aufheben, deshalb gibt es keinen stillen Standardwert für die Produktion.
 */
@Injectable()
export class PasskeyService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
  ) {}

  private rpId(): string {
    return this.config.get<string>('CONTROL_RP_ID', 'localhost');
  }

  private rpName(): string {
    return this.config.get<string>('CONTROL_RP_NAME', APP_NAME_DEFAULT);
  }

  private origin(): string {
    return this.config.get<string>('CONTROL_APP_URL', APP_URL_DEFAULT);
  }

  /** Passkeys eines Benutzers, ohne Reihenfolgezusage. */
  async passkeysOf(userId: string): Promise<StoredPasskey[]> {
    return this.prisma.passkeyCredential.findMany({
      where: { userId },
      select: {
        id: true,
        credentialId: true,
        publicKey: true,
        counter: true,
        transports: true,
      },
    });
  }

  /** Erzeugt die Optionen für `navigator.credentials.create()`. */
  async registrationOptions(user: {
    id: string;
    email: string;
    name: string;
  }): Promise<PublicKeyCredentialCreationOptionsJSON> {
    const existing = await this.passkeysOf(user.id);
    return generateRegistrationOptions({
      rpName: this.rpName(),
      rpID: this.rpId(),
      userName: user.email,
      userDisplayName: user.name,
      userID: new TextEncoder().encode(user.id),
      attestationType: 'none',
      excludeCredentials: existing.map((passkey) => ({
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
        // `requireUserVerification: true` voreingestellt hat. Mit 'preferred'
        // fordert der Browser keine Nutzerverifikation an und der Server lehnt
        // anschließend ab, was er selbst nicht verlangt hat.
        userVerification: 'required',
      },
    });
  }

  /**
   * Prüft die Antwort des Browsers auf eine Registrierung.
   * Liefert null, wenn die Prüfung scheitert — der Aufrufer entscheidet über
   * Fehlermeldung und Audit-Eintrag.
   */
  async checkRegistration(
    response: RegistrationResponseJSON,
    expectedChallenge: string,
  ): Promise<VerifiedPasskeyRegistration | null> {
    let result;
    try {
      result = await verifyRegistrationResponse({
        response: response,
        expectedChallenge: expectedChallenge,
        expectedOrigin: this.origin(),
        expectedRPID: this.rpId(),
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
      transports: response.response.transports?.join(',') ?? null,
    };
  }

  /**
   * Erzeugt die Optionen für `navigator.credentials.get()`.
   * Ohne bekannte Passkeys bleibt `allowCredentials` leer — der Browser fragt
   * dann selbst, welcher auffindbare Passkey verwendet werden soll.
   */
  async loginOptions(
    passkeys: StoredPasskey[],
  ): Promise<PublicKeyCredentialRequestOptionsJSON> {
    return generateAuthenticationOptions({
      rpID: this.rpId(),
      // Muss zur serverseitigen Erwartung passen, siehe registrierungsOptionen.
      userVerification: 'required',
      allowCredentials: passkeys.map((passkey) => ({
        id: passkey.credentialId,
        transports: transportsFromText(passkey.transports),
      })),
    });
  }

  /**
   * Prüft eine Anmeldeantwort gegen einen gespeicherten Passkey und schreibt
   * den neuen Zähler fort. Liefert false, wenn die Prüfung scheitert.
   */
  async checkLogin(
    response: AuthenticationResponseJSON,
    expectedChallenge: string,
    passkey: StoredPasskey,
  ): Promise<boolean> {
    let result;
    try {
      result = await verifyAuthenticationResponse({
        response: response,
        expectedChallenge: expectedChallenge,
        expectedOrigin: this.origin(),
        expectedRPID: this.rpId(),
        credential: {
          id: passkey.credentialId,
          publicKey: new Uint8Array(Buffer.from(passkey.publicKey, 'base64')),
          counter: passkey.counter,
          transports: transportsFromText(passkey.transports),
        },
      });
    } catch {
      return false;
    }
    if (!result.verified) return false;

    await this.prisma.passkeyCredential.update({
      where: { id: passkey.id },
      data: {
        counter: result.authenticationInfo.newCounter,
        lastUsedAt: new Date(),
      },
    });
    return true;
  }

  /** Findet einen Passkey über die vom Browser gemeldete Credential-ID. */
  async findViaCredentialId(credentialId: string): Promise<
    (StoredPasskey & { userId: string }) | null
  > {
    return this.prisma.passkeyCredential.findUnique({
      where: { credentialId },
      select: {
        id: true,
        userId: true,
        credentialId: true,
        publicKey: true,
        counter: true,
        transports: true,
      },
    });
  }

  /** Speichert einen frisch registrierten Passkey. */
  async store(
    userId: string,
    label: string,
    verified: VerifiedPasskeyRegistration,
  ): Promise<string> {
    const entry = await this.prisma.passkeyCredential.create({
      data: {
        userId,
        credentialId: verified.credentialId,
        publicKey: verified.publicKeyBase64,
        counter: verified.counter,
        transports: verified.transports,
        label,
      },
      select: { id: true },
    });
    return entry.id;
  }
}
