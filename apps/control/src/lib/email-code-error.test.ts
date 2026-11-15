import { describe, expect, it } from 'vitest';
import { ApiError } from './api-client';
import { emailCodeMessageFrom } from './email-code-error';

/** Baut den Fehlerkörper so, wie der Server ihn liefert. */
function error(detail?: { reason: string }, message = 'Anmeldung fehlgeschlagen.') {
  return new ApiError(
    { code: 'login_failed', message, detail },
    401,
  );
}

describe('emailCodeMeldungAus', () => {
  it('lässt bei einem Tippfehler weiterprobieren', () => {
    expect(emailCodeMessageFrom(error({ reason: 'wrong' }))).toEqual({
      text: 'Falscher Code. Bitte erneut versuchen.',
      newCodeRequired: false,
    });
  });

  it('verlangt bei einem verbrannten Code einen neuen', () => {
    expect(emailCodeMessageFrom(error({ reason: 'burned' }))).toEqual({
      text: 'Dieser Code ist nach zu vielen Fehlversuchen ungültig geworden. Fordere einen neuen Code an.',
      newCodeRequired: true,
    });
  });

  it('verlangt bei einem abgelaufenen Code einen neuen', () => {
    expect(emailCodeMessageFrom(error({ reason: 'expired' }))).toEqual({
      text: 'Dieser Code ist abgelaufen. Fordere einen neuen Code an.',
      newCodeRequired: true,
    });
  });

  it('gibt ohne Grund keinen Text vor — das entscheidet der Aufrufer', () => {
    expect(emailCodeMessageFrom(error())).toEqual({
      text: null,
      newCodeRequired: false,
    });
  });

  it('ignoriert einen unbekannten Grund, statt ihn anzuzeigen', () => {
    expect(emailCodeMessageFrom(error({ reason: 'irgendwas' }))).toEqual({
      text: null,
      newCodeRequired: false,
    });
  });

  it('kommt auch mit einem Fehler klar, der keine ApiError ist', () => {
    expect(emailCodeMessageFrom(new Error('Netz weg'))).toEqual({
      text: null,
      newCodeRequired: false,
    });
  });

  it('wertet das Detail eines fremden Fehlercodes nicht aus', () => {
    const foreign = new ApiError(
      { code: 'account_locked', message: 'Gesperrt.', detail: { reason: 'burned' } },
      429,
    );
    expect(emailCodeMessageFrom(foreign).newCodeRequired).toBe(false);
  });
});
