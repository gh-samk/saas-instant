import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { AccessService } from '../../auth/access.service';
import { sourceFrom } from '../inquiry-source';
import { EVIDENCE_ALWAYS } from '../decorators/evidence-always.decorator';
import { WITHOUT_SECOND_FACTOR } from '../decorators/without-second-factor.decorator';
import { StepUpRequiredError } from '../errors/business-error';
import { stepUpFresh } from '../../sso/step-up';
import type { LoggedInRequest } from './session.guard';

/**
 * Verlangt vor heiklen Aktionen den Nachweis eines zweiten Faktors —
 * DEKLARATIV statt an jeder Aufrufstelle erinnert.
 *
 * Die Regel selbst steht unverändert in `ZugangService.pruefeZweitenFaktor`:
 * aktuelles Passwort ODER TOTP-Code, mit Ausnahme für eine Sitzung, deren
 * Nachweis jünger als zehn Minuten ist. Neu ist nur, WER sie auslöst.
 *
 * Läuft NACH dem SitzungGuard (Reihenfolge in `@UseGuards`) und setzt deshalb
 * `req.benutzer` und `req.sitzungNachweisAm` voraus.
 *
 * Der Nachweis wird aus dem ROHEN Body gelesen: Guards laufen vor der
 * ValidationPipe. Deshalb wird hier nichts geglaubt, was nicht nachweislich
 * eine Zeichenkette ist — geprüft wird ohnehin gegen Hash bzw. TOTP.
 */
@Injectable()
export class SecondFactorGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly access: AccessService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const exception = this.reflector.get<string | undefined>(
      WITHOUT_SECOND_FACTOR,
      context.getHandler(),
    );
    if (exception) return true;

    const req = context.switchToHttp().getRequest<LoggedInRequest>();
    if (!req.user) {
      // Kann nur passieren, wenn der SitzungGuard fehlt oder nach diesem hier
      // steht. Dann ist die Route falsch verdrahtet — und zwar so, dass sie
      // ungeschützt wäre. Lieber laut abbrechen.
      throw new Error(
        'ZweitfaktorGuard ohne vorangehenden SitzungGuard — Route falsch verdrahtet.',
      );
    }

    // Angemeldet über das Portal: Der Nachweis ist ein frischer SSO-Durchlauf
    // (Step-up). Die lokalen Faktoren (Passwort, TOTP) gibt es für dieses Konto
    // als Nachweis nicht; ohne Step-up antwortet der Server mit
    // `step_up_required`, die Oberfläche öffnet den Durchlauf und wiederholt.
    if (req.ssoSession) {
      if (stepUpFresh(req.ssoSession.stepUpAt)) return true;
      throw new StepUpRequiredError();
    }

    // `@NachweisImmer` an der Route: kein Frischefenster. Dem Dienst wird dann
    // KEIN Nachweiszeitpunkt übergeben, und er verlangt den Nachweis in jedem
    // Fall — genau der Zweig, den auch ein Token ohne Zeitpunkt nimmt.
    const always = this.reflector.get<string | undefined>(
      EVIDENCE_ALWAYS,
      context.getHandler(),
    );
    await this.access.checkSecondFactor(
      req.user.id,
      evidenceFromBody(req.body),
      sourceFrom(req),
      always ? null : (req.sessionEvidenceAt ?? null),
    );
    return true;
  }
}

/** Liest die beiden Nachweisfelder aus einem ungeprüften Body. */
function evidenceFromBody(body: unknown): {
  currentPassword?: string;
  totpCode?: string;
} {
  if (typeof body !== 'object' || body === null) return {};
  const fields = body as Record<string, unknown>;
  const evidence: { currentPassword?: string; totpCode?: string } = {};
  if (typeof fields['currentPassword'] === 'string') {
    evidence.currentPassword = fields['currentPassword'];
  }
  if (typeof fields['totpCode'] === 'string') {
    evidence.totpCode = fields['totpCode'];
  }
  return evidence;
}
