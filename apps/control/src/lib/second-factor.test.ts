import { describe, expect, it } from 'vitest';
import { ApiError } from './api-client';
import { evidenceRequired, sessionDead } from './second-factor';

/**
 * Die Unterscheidung, an der alles hängt.
 *
 * Auf einer Route hinter dem `ZweitfaktorGuard` bedeuten `401` und `403` drei
 * verschiedene Dinge, und nur der Fehlercode hält sie auseinander. Würde die
 * Oberfläche am Status entscheiden, klappte bei einem abgelaufenen CSRF-Token
 * der Passwortdialog auf — und die Person tippte ihr Passwort in einen Aufruf,
 * der aus einem ganz anderen Grund scheitert.
 *
 * Die Statuswerte hier sind gemessen (2026-08-31, `RechnungAbschlussController`
 * mit den echten Guards und dem echten Exception-Filter), nicht angenommen.
 */

function error(code: string, status: number, detail?: unknown): ApiError {
  return new ApiError({ code, message: 'egal', detail }, status);
}

describe('nachweisVerlangt', () => {
  it('erkennt den fehlenden Nachweis am Code, nicht am Status', () => {
    expect(evidenceRequired(error('login_failed', 401))).toBe(true);
  });

  it('nimmt denselben Code auch mit 403 an', () => {
    // Absicherung: Der Prüfbericht nannte 403. Gemessen kommt im Browser 401 —
    // aber falls der Guard später 403 wählt, bricht die Oberfläche nicht.
    expect(evidenceRequired(error('login_failed', 403))).toBe(true);
  });

  it('hält ein CSRF-403 NICHT für einen fehlenden Nachweis', () => {
    // Sonst liefe der Fall in eine Schleife: Passwort eintippen, wieder 403,
    // Meldung „Passwort ist falsch" — die einzige Auskunft, die nicht stimmt.
    expect(evidenceRequired(error('HTTP_403', 403))).toBe(false);
  });

  it('hält eine tote Sitzung NICHT für einen fehlenden Nachweis', () => {
    expect(evidenceRequired(error('HTTP_401', 401))).toBe(false);
  });

  it('lässt eine Kontosperre (429) durch den Aufrufer behandeln', () => {
    expect(evidenceRequired(error('account_locked', 429))).toBe(false);
  });

  it('ignoriert alles, was gar kein ApiError ist', () => {
    expect(evidenceRequired(new Error('Netzwerk weg'))).toBe(false);
    expect(evidenceRequired(null)).toBe(false);
  });
});

describe('sitzungTot', () => {
  it('erkennt den Rahmencode des SitzungGuard', () => {
    expect(sessionDead(error('HTTP_401', 401))).toBe(true);
  });

  it('verwechselt den fehlenden Nachweis nicht mit einer toten Sitzung', () => {
    expect(sessionDead(error('login_failed', 401))).toBe(false);
  });

  it('gilt nicht für 403', () => {
    expect(sessionDead(error('HTTP_403', 403))).toBe(false);
  });
});

describe('Step-up im Modus portal', () => {
  it('hält step_up_required (401) für einen fehlenden Nachweis', () => {
    expect(evidenceRequired(error('step_up_required', 401))).toBe(true);
  });

  it('hält forbidden_role (403) NICHT für einen fehlenden Nachweis', () => {
    // Die Rolle reicht nicht: ein Nachweis ändert daran nichts.
    expect(evidenceRequired(error('forbidden_role', 403))).toBe(false);
  });
});
