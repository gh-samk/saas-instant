import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { LOGIN_MAX_AGE_MS } from '../common/cookies';
import { LoginFailedError } from '../common/errors/business-error';

/** Art des angefangenen Vorgangs. */
export type FlowType =
  | 'passkey-login'
  | 'passkey-registration'
  | 'second-factor';

export interface LoginFlow {
  type: FlowType;
  /** Betroffener Benutzer, sofern beim Start schon bekannt. */
  userId: string | null;
  /** WebAuthn-Challenge (base64url). Nur bei den Passkey-Vorgängen gesetzt. */
  challenge?: string;
  /**
   * Stand von `Benutzer.anmeldevorgangGeneration` bei der Ausstellung.
   *
   * Macht den Vorgang EINMALIG ([H1]): jede abgeschlossene Anmeldung zählt die
   * Generation hoch, ein zweites Mal lässt sich derselbe Token damit nicht
   * einlösen. Vorher schloss ein abgefangener Vorgangstoken beliebig oft
   * hintereinander eine Anmeldung ab.
   *
   * Fehlt das Feld (Token aus einer früheren Fassung), gilt der Vorgang als
   * ungültig — im Zweifel neu anmelden, nicht durchwinken.
   */
  gen?: number;
}

/**
 * Hält den Zwischenstand eines mehrstufigen Anmeldevorgangs in einem
 * kurzlebigen, signierten Cookie (10 Minuten) statt in einer Tabelle.
 *
 * Die WebAuthn-Challenge liegt damit ausschließlich beim Client und in der
 * Signaturprüfung — sie taucht in keiner Tabelle und in keinem Log auf.
 */
@Injectable()
export class LoginFlowService {
  constructor(
    private readonly jwt: JwtService,
    private readonly config: ConfigService,
  ) {}

  private secret(): string {
    const value = this.config.get<string>('JWT_SECRET');
    if (!value) {
      throw new Error('JWT_SECRET ist nicht gesetzt.');
    }
    return value;
  }

  async create(flow: LoginFlow): Promise<string> {
    // Dieselbe Frist wie das zugehörige Cookie: läuft eines ab, ist auch das
    // andere wertlos — kein Zustand, der scheinbar noch gültig aussieht.
    return this.jwt.signAsync(flow, {
      secret: this.secret(),
      expiresIn: `${LOGIN_MAX_AGE_MS / 1000}s`,
    });
  }

  /**
   * Liest einen Vorgang und prüft die erwartete Art. Jeder Fehler (fehlend,
   * abgelaufen, falsche Art) endet in derselben neutralen Meldung.
   */
  async read(token: string | undefined, expectedType: FlowType): Promise<LoginFlow> {
    if (!token) {
      throw new LoginFailedError(
        'Der Anmeldevorgang ist abgelaufen. Bitte erneut beginnen.',
      );
    }
    try {
      const flow = await this.jwt.verifyAsync<LoginFlow>(token, {
        secret: this.secret(),
      });
      if (flow.type !== expectedType) {
        throw new Error('Falsche Vorgangsart.');
      }
      return flow;
    } catch {
      throw new LoginFailedError(
        'Der Anmeldevorgang ist abgelaufen. Bitte erneut beginnen.',
      );
    }
  }
}
