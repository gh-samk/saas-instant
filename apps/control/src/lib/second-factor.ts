import { useCallback, useMemo, useState } from 'react';
import { useAuth } from '../context/AuthContext';
import {
  ApiError,
  ERROR_CODE,
  errorText,
  blockSecondsFrom,
} from './api-client';
import { asMinutesSeconds } from './countdown';
import type { SecondFactorEvidence } from './api';
import { t, useT } from '../i18n';

/**
 * Das Muster „erst ohne Nachweis rufen, bei Bedarf nachfragen" — an EINER
 * Stelle.
 *
 * ===========================================================================
 * WARUM DER FEHLERCODE ZÄHLT UND NICHT DER STATUS
 * ===========================================================================
 *
 * Ein `401` oder `403` auf einer Route hinter dem `ZweitfaktorGuard` kann drei
 * verschiedene Dinge heißen, und die Oberfläche muss sie auseinanderhalten:
 *
 *   401 · `anmeldung_fehlgeschlagen`  Nachweis nötig ODER Nachweis falsch
 *   401 · `HTTP_401`                  Sitzung tot (`SitzungGuard`)
 *   403 · `HTTP_403`                  CSRF-Token fehlt oder passt nicht
 *
 * Am Status allein ist das nicht zu unterscheiden. Würde die Oberfläche auf
 * jedes `403` den Nachweis-Dialog aufklappen, liefe der CSRF-Fall in eine
 * Schleife: Die Person tippt ihr Passwort, der Aufruf scheitert wieder am
 * fehlenden Token, und die Meldung lautet weiterhin „Passwort ist falsch" —
 * die einzige Auskunft, die hier nicht stimmt. Deshalb entscheidet der Code.
 *
 * GEMESSEN am 2026-08-31 gegen `RechnungAbschlussController` mit den echten
 * Guards und dem echten Exception-Filter, Sitzung eine Stunde alt:
 *
 *   mit CSRF-Header  → 401 `{"code":"anmeldung_fehlgeschlagen", …}`
 *   ohne CSRF-Header → 403 `{"code":"HTTP_403","nachricht":"CSRF-Token fehlt …"}`
 *
 * Der Prüfbericht nennt für diese Routen `403`. Das war die Messung OHNE
 * CSRF-Header (curl); im Browser schickt `apiFetch` ihn bei jedem POST mit,
 * und dort kommt `401` an. Beide Status werden trotzdem angenommen — der
 * Code ist die tragende Bedingung, der Status nur die Absicherung dagegen,
 * dass eine spätere Fassung des Guards `403` wählt.
 */

/** Verlangt der Server für diesen Aufruf (noch) einen zweiten Faktor? */
export function evidenceRequired(error: unknown): boolean {
  if (!(error instanceof ApiError)) return false;
  if (error.error.code !== ERROR_CODE.loginFailed) return false;
  return error.status === 401 || error.status === 403;
}

/**
 * Ist die SITZUNG weg — nicht der Nachweis?
 *
 * Der `SitzungGuard` wirft eine nackte `UnauthorizedException`; der Filter
 * macht daraus den Rahmencode `HTTP_401`. Ein fachlicher Fehler steht nie
 * dahinter, deshalb ist der Rahmencode hier das Erkennungsmerkmal.
 */
export function sessionDead(error: unknown): boolean {
  return (
    error instanceof ApiError &&
    error.status === 401 &&
    error.error.code === 'HTTP_401'
  );
}

/** Hat der Nachweis das Konto in die Fehlversuchssperre laufen lassen? */
function accountBlocked(error: unknown): boolean {
  return (
    error instanceof ApiError &&
    error.error.code === ERROR_CODE.accountBlocked
  );
}

/**
 * Die Sperrmeldung gehört IN den Dialog, nicht dahinter.
 *
 * Sonst tippt jemand sein Passwort in ein Feld, dessen Aufruf gar nicht mehr
 * ankommen kann, und die Begründung steht verdeckt auf der Seite darunter.
 */
function blockMessage(error: unknown): string {
  const basis = errorText(
    error,
    t('common.secondFactor.basis'),
  );
  const seconds = blockSecondsFrom(error);
  return seconds === null
    ? basis
    : t('common.secondFactor.text', { basis, value: asMinutesSeconds(seconds) });
}

export interface EvidenceState {
  /** Steht der Nachweis-Dialog offen? */
  open: boolean;
  /** Meldung IM Dialog: falscher Nachweis oder Kontosperre. */
  error: string | undefined;
  /**
   * Im `catch` aufrufen. `true` heißt: behandelt — der Aufrufer zeigt nichts
   * weiter an, der Dialog übernimmt.
   */
  handle: (error: unknown, evidence?: SecondFactorEvidence) => boolean;
  /** Nach Erfolg und beim Abbrechen. */
  close: () => void;
}

/**
 * Kapselt den Nachweis-Dialog für eine Handlung hinter dem `ZweitfaktorGuard`.
 *
 * Ablauf an jeder Aufrufstelle:
 *
 * ```ts
 * async function handle(nachweis?: ZweitfaktorNachweis) {
 *   try {
 *     await ruf(id, nachweis);
 *     nachweislage.schliesse();
 *   } catch (f) {
 *     if (nachweislage.behandle(f, nachweis)) return;
 *     setFehler(fehlertext(f, '…'));
 *   }
 * }
 * ```
 *
 * Wer gerade erst angemeldet ist (Sitzung unter zehn Minuten), sieht den
 * Dialog nie — der Server lässt den Nachweis dann weg.
 *
 * Ist die SITZUNG tot, wird sie nachgeladen: `AuthProvider` setzt den Stand auf
 * `null`, und der geschützte Bereich führt zur Anmeldung. Der Dialog bleibt
 * dabei zu; ihn zu öffnen hieße, nach einem Passwort für eine Sitzung zu
 * fragen, die es nicht mehr gibt.
 */
export function useSecondFactorEvidence(): EvidenceState {
  const t = useT();
  const { reload } = useAuth();
  const [open, setOpen] = useState(false);
  const [error, setError] = useState<string | undefined>(undefined);

  const close = useCallback(() => {
    setOpen(false);
    setError(undefined);
  }, []);

  const handle = useCallback(
    (f: unknown, evidence?: SecondFactorEvidence): boolean => {
      if (sessionDead(f)) {
        setOpen(false);
        setError(undefined);
        void reload().catch(() => undefined);
        return false;
      }
      if (evidence !== undefined && accountBlocked(f)) {
        setError(blockMessage(f));
        return true;
      }
      if (!evidenceRequired(f)) {
        // DER DIALOG MUSS HIER ZU.
        //
        // Der Fehler hat mit dem Nachweis nichts zu tun — der Nachweis war
        // richtig, der Aufruf ist aus einem anderen Grund gescheitert (etwa
        // 422 `rechnung_unvollstaendig`). Der Aufrufer zeigt gleich seine
        // eigene Meldung an, und zwar im Dialog DARUNTER. Bliebe der
        // Nachweis-Dialog offen, läge er vollständig darüber: Zu sehen wäre
        // nur ein leeres Passwortfeld, und die Antwort des Servers stünde
        // unsichtbar dahinter. Gemeldet als [K2] am 2026-08-31 — derselbe
        // Dialogstapel, in dem schon zweimal etwas verdeckt lag.
        //
        // Rückgabe bleibt `false`: Der Aufrufer ist zuständig, nicht wir.
        setOpen(false);
        setError(undefined);
        return false;
      }
      if (evidence !== undefined) {
        setError(
          evidence.totpCode !== undefined
            ? t('common.secondFactor.text2')
            : t('common.secondFactor.text3'),
        );
      } else {
        setError(undefined);
        setOpen(true);
      }
      return true;
    },
    [reload],
  );

  // Gemerkt, nicht bei jedem Durchlauf neu: Wer die Lage in die
  // Abhängigkeitsliste eines Effekts schreibt, bekäme sonst eine Schleife.
  return useMemo(
    () => ({ open, error, handle, close }),
    [open, error, handle, close],
  );
}
