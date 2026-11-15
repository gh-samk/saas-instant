import { ISSUER_PRESETS } from './document/issuer.config';

/**
 * ===========================================================================
 * DIE GLÄUBIGER-IDENTIFIKATIONSNUMMER WIRD NACHGERECHNET, NICHT GEGLAUBT
 * ===========================================================================
 *
 * Sie steht auf jeder Vorabankündigung, die eine Kundin ihrer Bank vorlegt.
 * Ein Zahlendreher darin fällt niemandem im Haus auf — er fällt der Kundin
 * auf, wenn sie den Einzug nicht zuordnen kann, oder der Bank, wenn die
 * Einreichung zurückkommt.
 *
 * DASS SO ETWAS PASSIERT, IST BELEGT: In `seiten.ts` stand die Fläche einmal
 * als `#f7f7f5` statt `#f6f7f5` — aus dem Gedächtnis nachgebaut, ein Zeichen
 * daneben, und niemandem aufgefallen, bis ein Test die Datei gelesen hat. Bei
 * einer Farbe ist das ein Schönheitsfehler. Bei einer Gläubigerkennung ist es
 * ein Beleg, der nicht stimmt.
 *
 * Das Verfahren ist dasselbe wie bei der IBAN (ISO 7064, MOD 97-10) — mit
 * einer Besonderheit: Die dreistellige GESCHÄFTSBEREICHSKENNUNG an den
 * Stellen 5 bis 7 (üblicherweise `ZZZ`) bleibt bei der Rechnung AUSSEN VOR.
 * Sie ist frei wählbar und darf die Prüfziffern nicht verändern; wer sie
 * mitrechnet, bekommt für dieselbe gültige Kennung je nach Bereich ein
 * anderes Ergebnis.
 */

/**
 * Prüft eine Gläubiger-ID nach ISO 7064 MOD 97-10.
 *
 * Bewusst hier im Test und nicht in der Anwendung: Geprüft wird EIN fester
 * Wert aus der Konfiguration, nicht eine Eingabe. Eine Prüffunktion im
 * Produktivcode wäre totes Gewicht — sie liefe bei jedem Start über dieselbe
 * Konstante.
 */
function checkDigitMatches(identifier: string): boolean {
  const raw = identifier.replace(/\s+/g, '').toUpperCase();
  if (!/^[A-Z]{2}\d{2}[A-Z0-9]{3}[A-Z0-9]+$/.test(raw)) return false;

  // Geschäftsbereichskennung (Stellen 5–7) heraus, dann die ersten vier
  // Zeichen ans Ende — wie bei der IBAN.
  const withoutArea = raw.slice(0, 4) + raw.slice(7);
  const switched = withoutArea.slice(4) + withoutArea.slice(0, 4);
  const digits = [...switched]
    .map((z) => (/[A-Z]/.test(z) ? String(z.charCodeAt(0) - 55) : z))
    .join('');

  // Stückweise rechnen: Die Zahl hat mehr Stellen, als `Number` genau
  // darstellt. `BigInt` ginge auch; so bleibt es bei Zahlen, die jeder
  // nachrechnen kann.
  let rest = 0;
  for (const digit of digits) rest = (rest * 10 + Number(digit)) % 97;
  return rest === 1;
}

describe('Die hinterlegte Gläubiger-ID', () => {
  const ID = ISSUER_PRESETS.creditorId;

  it('ist überhaupt hinterlegt', () => {
    // Ohne sie scheitert jeder Beleg, der einen Lastschrifteinzug ankündigt.
    expect(ID).not.toBe('');
  });

  it('hat die deutsche Form: DE, zwei Prüfziffern, Bereich, elf Stellen', () => {
    expect(ID).toMatch(/^DE\d{2}[A-Z0-9]{3}\d{11}$/);
    expect(ID).toHaveLength(18);
  });

  it('HÄLT DIE PRÜFZIFFERN NACH ISO 7064 MOD 97-10 EIN', () => {
    expect(checkDigitMatches(ID)).toBe(true);
  });
});

describe('Die Prüfung selbst', () => {
  // Die Gegenprobe zum Prüfer: Ein Prüfer, der alles durchwinkt, wäre
  // schlimmer als keiner — er sähe aus wie Sicherheit.
  it('weist einen Zahlendreher ab', () => {
    expect(checkDigitMatches('DE98ZZZ09999999909')).toBe(false);
  });

  it('weist falsche Prüfziffern ab', () => {
    expect(checkDigitMatches('DE75ZZZ00002941326')).toBe(false);
  });

  it('IGNORIERT DIE GESCHÄFTSBEREICHSKENNUNG, wie es das Verfahren verlangt', () => {
    // Sie ist frei wählbar und darf die Prüfziffern nicht verändern. Wer sie
    // mitrechnet, bekommt für dieselbe gültige Kennung je nach Bereich ein
    // anderes Ergebnis — der häufigste Fehler bei dieser Prüfung.
    for (const area of ['ZZZ', 'A1B', '000']) {
      expect(checkDigitMatches(`DE74${area}00002941326`)).toBe(true);
    }
  });

  it('weist unbrauchbare Eingaben ab, statt sie durchzulassen', () => {
    for (const garbage of ['', 'DE74', 'XX74ZZZ00002941326', 'DE7AZZZ00002941326']) {
      expect(checkDigitMatches(garbage)).toBe(false);
    }
  });
});
