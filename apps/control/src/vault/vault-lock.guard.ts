import {
  CanActivate,
  ExecutionContext,
  HttpException,
  HttpStatus,
  Injectable,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { ALLOW_WHILE_LOCKED, ALLOW_WHILE_UNINITIALIZED } from './allow-while-locked.decorator';
import { VaultService } from './vault.service';

/**
 * Bei gesperrtem Tresor antwortet JEDE Route mit 423, außer sie ist am Handler
 * (oder am Controller) mit `@AllowWhileLocked(begründung)` markiert.
 *
 * Standard ist also "gesperrt": eine neue Route ist ohne Zutun geschützt, und
 * die Entscheidung beruht auf der von Nest gefundenen Route, nicht auf einem
 * Vergleich der URL (Groß-/Kleinschreibung, absolute Anfrage-URL, Doppelschrägstrich).
 *
 * Erreichbar bleiben (jeweils begründet am Handler): Health und Version,
 * public-config und das öffentliche Logo, Anmeldung, Sitzung und Abmeldung (auth,
 * sso; Kontopflege unter access bleibt gesperrt), der Tresor selbst (status, unlock, setup), der Sicherungsplan und die
 * Sicherungsmeldung des Agenten, der Stand der Funktionsschalter und die
 * Ein-Klick-Abmeldung aus dem Newsletter.
 *
 * Die öffentlichen Formulare (Anfrage, Newsletter-Eintragung, Aufnahme) bleiben
 * gesperrt: sie schreiben Kundendaten, und die gehören nicht unverschlüsselt in
 * die Datenbank.
 */
@Injectable()
export class VaultLockGuard implements CanActivate {
  constructor(
    private readonly vault: VaultService,
    private readonly reflector: Reflector,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    if (context.getType() !== 'http') return true;
    if (this.vault.isReady()) return true;
    const allowed = this.reflector.getAllAndOverride<string | undefined>(
      ALLOW_WHILE_LOCKED,
      [context.getHandler(), context.getClass()],
    );
    if (typeof allowed === 'string' && allowed.length > 0) return true;
    // Ersteinrichtung des ersten Kontos: nur solange es noch keinen Tresor gibt.
    const uninitialized = this.reflector.getAllAndOverride<string | undefined>(
      ALLOW_WHILE_UNINITIALIZED,
      [context.getHandler(), context.getClass()],
    );
    if (
      typeof uninitialized === 'string' &&
      uninitialized.length > 0 &&
      (await this.vault.state()) === 'uninitialized'
    ) {
      return true;
    }
    throw new HttpException(
      {
        errorCode: 'vault_locked',
        message: 'Die Verwaltung ist gesperrt. Bitte mit der Passphrase entsperren.',
      },
      HttpStatus.LOCKED,
    );
  }
}
