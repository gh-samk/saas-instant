import { describe, expect, it } from 'vitest';
import {
  MIN_LENGTH_PASSWORD,
  newPasswordValid,
  passwordIsAllowed,
  passwordStrength,
} from './password-strength';

describe('passwortIstZulaessig', () => {
  it('lehnt alles unterhalb der Mindestlänge ab', () => {
    expect(passwordIsAllowed('')).toBe(false);
    expect(passwordIsAllowed('a'.repeat(MIN_LENGTH_PASSWORD - 1))).toBe(
      false,
    );
  });

  it('nimmt genau die Mindestlänge an, ohne Zeichenmischung zu verlangen', () => {
    expect(passwordIsAllowed('a'.repeat(MIN_LENGTH_PASSWORD))).toBe(true);
  });
});

describe('passwortStaerke', () => {
  it('bewertet ein leeres Feld gar nicht', () => {
    expect(passwordStrength('')).toBe(0);
  });

  it('bewertet zu kurze Passwörter immer als schwach', () => {
    expect(passwordStrength('Kurz!1')).toBe(1);
    expect(passwordStrength('a'.repeat(MIN_LENGTH_PASSWORD - 1))).toBe(1);
  });

  it('steigt mit Länge und Zeichenvielfalt', () => {
    expect(passwordStrength('aaaaaaaaaaaa')).toBe(1);
    expect(passwordStrength('aaaaaaaaaaaaaaaa')).toBe(2);
    expect(passwordStrength('Sommerregen1')).toBe(2);
    expect(passwordStrength('Sommerregen1!Wald')).toBe(3);
  });

  it('bleibt bei 3 stehen, auch bei sehr langen Passwörtern', () => {
    expect(passwordStrength(`${'Sommerregen'.repeat(5)}1!`)).toBe(3);
  });
});

describe('neuesPasswortGueltig', () => {
  const longEnough = 'Sommerregen1!';

  it('verlangt beide Felder, gleiche Eingabe und die Mindestlänge', () => {
    expect(newPasswordValid(longEnough, longEnough)).toBe(true);
  });

  it('lehnt eine abweichende Wiederholung ab', () => {
    expect(newPasswordValid(longEnough, `${longEnough}x`)).toBe(false);
  });

  it('lehnt eine leere Wiederholung ab', () => {
    expect(newPasswordValid(longEnough, '')).toBe(false);
  });

  it('lehnt zwei gleiche, aber zu kurze Eingaben ab', () => {
    expect(newPasswordValid('short', 'short')).toBe(false);
  });
});
