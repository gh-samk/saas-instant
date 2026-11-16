import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { APP_NAME_DEFAULT, APP_URL_DEFAULT } from '../common/app-defaults';
import {
  checkLoginResponse,
  checkRegistrationResponse,
  createLoginOptions,
  createRegistrationOptions,
} from '@saas-instant/auth-core';
import type {
  AuthenticationResponseJSON,
  PublicKeyCredentialCreationOptionsJSON,
  PublicKeyCredentialRequestOptionsJSON,
  RegistrationResponseJSON,
  StoredPasskey,
  VerifiedPasskeyRegistration,
} from '@saas-instant/auth-core';
import { PrismaService } from '../prisma/prisma.service';

// Die framework-freien Typen wohnen in `@saas-instant/auth-core`.
export type { StoredPasskey, VerifiedPasskeyRegistration };

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
    return createRegistrationOptions({
      rpName: this.rpName(),
      rpId: this.rpId(),
      user,
      existing,
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
    return checkRegistrationResponse(response, expectedChallenge, {
      rpId: this.rpId(),
      origin: this.origin(),
    });
  }

  /**
   * Erzeugt die Optionen für `navigator.credentials.get()`.
   * Ohne bekannte Passkeys bleibt `allowCredentials` leer — der Browser fragt
   * dann selbst, welcher auffindbare Passkey verwendet werden soll.
   */
  async loginOptions(
    passkeys: StoredPasskey[],
  ): Promise<PublicKeyCredentialRequestOptionsJSON> {
    return createLoginOptions(this.rpId(), passkeys);
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
    const result = await checkLoginResponse(
      response,
      expectedChallenge,
      passkey,
      { rpId: this.rpId(), origin: this.origin() },
    );
    if (!result) return false;

    await this.prisma.passkeyCredential.update({
      where: { id: passkey.id },
      data: {
        counter: result.newCounter,
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
