import {
  thanksPage,
  maskIban,
  checkPage,
  stepPage,
  invalidPage,
} from './form-pages';
import { legalLinks } from '../consent/pages';

const Base = {
  token: 'abc123',
  companyName: 'Solawi Rheintal eG',
  inputs: {},
};

/**
 * ===========================================================================
 * DIE ZUSAGEN DER EINWILLIGUNGSSEITEN GELTEN HIER GENAUSO
 * ===========================================================================
 *
 * Kopf und Fuss sind derselbe Baustein — aber ein gemeinsamer Baustein
 * beweist nichts ueber den zweiten Aufrufer, solange niemand ihn misst. Diese
 * Datei misst ihn.
 */
describe('Die Huelle des Aufnahmeformulars', () => {
  const pages = [
    ['Schritt', stepPage({ ...Base, step: 1 })],
    ['Pruefansicht', checkPage({ ...Base, step: 6 })],
    ['Dank', thanksPage('Solawi Rheintal eG')],
    ['Ungueltig', invalidPage()],
  ] as const;

  it.each(pages)('%s: laedt kein Skript und keine Fremdressource', (_n, html) => {
    expect(html).not.toMatch(/<script/i);
    expect(html).not.toMatch(/<img/i);
    expect(html).not.toMatch(/<link/i);
    for (const hit of html.matchAll(/url\(\s*['"]?([^'")]+)/g)) {
      expect(hit[1]!.startsWith('/')).toBe(true);
      expect(hit[1]!.startsWith('//')).toBe(false);
    }
  });

  it.each(pages)('%s: gehoert in keinen Index', (_n, html) => {
    expect(html).toContain('noindex, nofollow');
  });

  it.each(pages)('%s: traegt Wortmarke und Rechtsverweise', (_n, html) => {
    // Der Markenname kommt aus dem Manifest (einwilligung/seiten.ts) und ist
    // hier kein Prüfgegenstand; geprüft wird, dass die Wortmarke da ist.
    expect(html).toMatch(/class="[^"]*marke[^"]*"/);
    expect(html).not.toContain('undefined');
    const urls = [...html.matchAll(/<a\s[^>]*href="([^"]*)"/g)].map((t) => t[1]);
    expect(urls.sort()).toEqual(legalLinks().map((l) => l.url).sort());
  });
});

describe('Ein Eingabeschritt', () => {
  it('nennt die Schrittzahl und den Organisationsnamen', () => {
    const html = stepPage({ ...Base, step: 1 });
    expect(html).toContain('Schritt 1 von 6');
    expect(html).toContain('Solawi Rheintal eG');
  });

  /**
   * Wer einen fremden Token abfaengt, soll nichts LESEN koennen, was er nicht
   * schon weiss. Der Name stand ohnehin in der Anfrage; alles andere fragt
   * das Formular ab, statt es zu zeigen.
   */
  it('zeigt ausser dem Namen keinen gespeicherten Wert', () => {
    const html = stepPage({ ...Base, step: 1 });
    // Ohne Eingaben stehen alle Felder leer da.
    expect(html).toMatch(/value=""/);
    expect(html).not.toContain('value="Solawi Rheintal eG"');
  });

  it('traegt frueher Eingegebenes als verstecktes Feld weiter', () => {
    const html = stepPage({
      ...Base,
      step: 3,
      inputs: { name: 'Solawi Rheintal eG', postalCode: '79576' },
    });
    expect(html).toContain('<input type="hidden" name="name" value="Solawi Rheintal eG">');
    expect(html).toContain('<input type="hidden" name="postalCode" value="79576">');
  });

  it('zeigt die Werte des AKTUELLEN Schritts sichtbar, nicht versteckt', () => {
    const html = stepPage({
      ...Base,
      step: 1,
      inputs: { name: 'Solawi Rheintal eG' },
    });
    expect(html).not.toContain('<input type="hidden" name="name"');
    expect(html).toContain('id="f-name" name="name" value="Solawi Rheintal eG"');
  });

  it('behaelt die Eingaben, wenn ein Feld fehlt', () => {
    const html = stepPage({
      ...Base,
      step: 1,
      inputs: { name: 'Solawi Rheintal eG', city: '' },
      error: [{ field: 'city', message: 'Bitte den Ort angeben.' }],
    });
    expect(html).toContain('Bitte den Ort angeben.');
    expect(html).toContain('Solawi Rheintal eG');
    expect(html).toContain('aria-describedby="f-city-error"');
  });

  it('hat im ersten Schritt keinen Zurueck-Knopf', () => {
    expect(stepPage({ ...Base, step: 1 })).not.toContain('value="back"');
    expect(stepPage({ ...Base, step: 2 })).toContain('value="back"');
  });
});

describe('Die IBAN', () => {
  it('wird maskiert, aber bleibt erkennbar', () => {
    expect(maskIban('DE02120300000000202051')).toBe('DE02 •••• •••• 51');
    expect(maskIban('DE02 1203 0000 0000 2020 51')).toBe('DE02 •••• •••• 51');
    expect(maskIban('kurz')).toBe('••••');
  });

  /**
   * Sie reist als versteckter Wert mit — ohne Zwischenspeicher geht es nicht
   * anders. Sie soll aber nicht in einem Fenster STEHEN, das jemand offen
   * liegen laesst.
   */
  it('steht in der Pruefansicht nur maskiert', () => {
    const html = checkPage({
      ...Base,
      step: 6,
      inputs: { paymentMethod: 'direct_debit', iban: 'DE02120300000000202051' },
    });
    expect(html).toContain('DE02 •••• •••• 51');
    // Der volle Wert steht nur im versteckten Feld, nicht im sichtbaren Text.
    const visible = html.replace(/<input[^>]*>/g, '');
    expect(visible).not.toContain('DE02120300000000202051');
  });

  it('wird im Eingabefeld NICHT vorbelegt und nicht vom Browser gemerkt', () => {
    const html = stepPage({
      ...Base,
      step: 5,
      inputs: { iban: 'DE02120300000000202051' },
    });
    expect(html).toContain('id="f-iban" name="iban" value="" autocomplete="off"');
  });
});

describe('Die Pruefansicht', () => {
  it('zeigt zu jedem Abschnitt einen Aendern-Knopf', () => {
    const html = checkPage({
      ...Base,
      step: 6,
      inputs: { name: 'Solawi', paymentMethod: 'bank_transfer' },
    });
    for (const number of [1, 2, 3, 4]) {
      expect(html).toContain(`value="step-${number}"`);
    }
  });

  it('laesst den SEPA-Abschnitt weg, wenn nicht per Lastschrift gezahlt wird', () => {
    const without = checkPage({
      ...Base,
      step: 6,
      inputs: { paymentMethod: 'bank_transfer' },
    });
    expect(without).not.toContain('value="step-5"');
    expect(without).not.toContain('SEPA-Lastschriftmandat');

    const withValue = checkPage({
      ...Base,
      step: 6,
      inputs: { paymentMethod: 'direct_debit' },
    });
    expect(withValue).toContain('value="step-5"');
  });

  it('sagt bei einem leeren Abschnitt, dass nichts angegeben wurde', () => {
    // Sonst stuende dort nur eine Ueberschrift und ein Knopf — das sieht aus
    // wie ein Fehler, obwohl ein freiwilliger Abschnitt leer bleiben darf.
    const html = checkPage({
      ...Base,
      step: 6,
      inputs: { name: 'Solawi', paymentMethod: 'bank_transfer' },
    });
    expect(html).toContain('Nichts angegeben');
  });

  it('uebersetzt Auswahlwerte in den Text, den die Kundin gelesen hat', () => {
    const html = checkPage({
      ...Base,
      step: 6,
      inputs: { paymentInterval: 'yearly', paymentMethod: 'bank_transfer' },
    });
    expect(html).toContain('Jährlich — günstigster Preis');
  });
});

/**
 * ===========================================================================
 * DIE SECHS BEFUNDE VOM 07.09.2026
 * ===========================================================================
 *
 * Alle am ausgerollten Stand gefunden, alle behoben. Jeder bekommt einen
 * Test, der ihn beim naechsten Mal vor dem Ausrollen fasst statt danach.
 */
describe('Die gemeldeten Maengel bleiben behoben', () => {
  const Creditor = { name: 'Example Company GmbH & Co KG', id: 'DE98ZZZ09999999999' };

  it('zeigt eine Kette aus Kreisen und Strichen, nicht nur eine Zahl', () => {
    const html = stepPage({ ...Base, step: 1 });
    const circles = [...html.matchAll(/class="sl-dot[^"]*"/g)];
    const dashes = [...html.matchAll(/class="sl-line[^"]*"/g)];
    expect(circles).toHaveLength(6);
    // Zwischen sechs Kreisen liegen fuenf Striche, nicht sechs.
    expect(dashes).toHaveLength(5);
  });

  it('hebt genau EINEN Kreis als den aktuellen hervor', () => {
    const html = stepPage({ ...Base, step: 3 });
    expect([...html.matchAll(/sl-dot now/g)]).toHaveLength(1);
    // Zwei davor sind done.
    expect([...html.matchAll(/sl-dot done/g)]).toHaveLength(2);
  });

  it('zeigt SECHS Kreise, solange die Zahlungsart offen ist', () => {
    // Ein Zaehler, der waehrend des Ausfuellens WAECHST, sieht aus wie ein
    // Fehler. Deshalb gilt vor der Wahl der laengere Weg.
    const html = stepPage({ ...Base, step: 1, inputs: {} });
    expect(html).toContain('Schritt 1 von 6');
  });

  it('zeigt FUENF Kreise, sobald Ueberweisung gewaehlt ist', () => {
    const html = stepPage({
      ...Base,
      step: 4,
      inputs: { paymentMethod: 'bank_transfer' },
    });
    expect(html).toContain('Schritt 4 von 5');
    expect([...html.matchAll(/class="sl-dot[^"]*"/g)]).toHaveLength(5);
  });

  it('nennt die Pruefansicht ohne Mandat den FUENFTEN Schritt', () => {
    const html = checkPage({
      ...Base,
      step: 6,
      inputs: { paymentMethod: 'bank_transfer' },
    });
    expect(html).toContain('Schritt 5 von 5');
  });

  it('setzt box-sizing, damit die Felder rechts nicht herausragen', () => {
    const html = stepPage({ ...Base, step: 1 });
    expect(html).toContain('box-sizing:border-box');
  });

  it('beschriftet das Mandats-Haekchen — es stand nackt da', () => {
    const html = stepPage({
      ...Base,
      step: 5,
      inputs: { paymentMethod: 'direct_debit' },
      creditor: Creditor,
    });
    const checkbox = /<input type="checkbox"[^>]*name="mandate"[^>]*>\s*<span>([^<]+)<\/span>/.exec(html);
    expect(checkbox).not.toBeNull();
    expect(checkbox![1]!.trim().length).toBeGreaterThan(30);
  });

  it('zeigt den Mandatswortlaut samt Glaeubiger-Kennung', () => {
    const html = stepPage({
      ...Base,
      step: 5,
      inputs: { paymentMethod: 'direct_debit', name: 'Solawi Rheintal eG' },
      creditor: Creditor,
    });
    expect(html).toContain('DE98ZZZ09999999999');
    expect(html).toContain('Gläubiger-Identifikationsnummer');
    expect(html).toContain('acht Wochen');
    // Die Referenz gibt es vor dem Absenden noch nicht — sie wird angekuendigt,
    // nicht erfunden.
    expect(html).toContain('wird beim Absenden vergeben');
  });

  it('stellt den Wortlaut VOR das Haekchen, nicht dahinter', () => {
    const html = stepPage({
      ...Base,
      step: 5,
      inputs: { paymentMethod: 'direct_debit' },
      creditor: Creditor,
    });
    expect(html.indexOf('sl-mandatee')).toBeLessThan(html.indexOf('name="mandate"'));
  });

  it('verkuerzt den Weg NICHT, solange die Wahl abgewiesen wird', () => {
    // Sonst lehnte dieselbe Seite die Ueberweisung ab und folgte ihr zugleich:
    // „Schritt 4 von 5" ueber einer Meldung, dass es so nicht geht.
    const html = stepPage({
      ...Base,
      step: 4,
      inputs: { paymentInterval: 'monthly', paymentMethod: 'bank_transfer' },
    });
    expect(html).toContain('Schritt 4 von 6');
  });

  it('schickt „Absenden" auf die eigene Route mit dem engen Limit', () => {
    const html = checkPage({
      ...Base,
      step: 6,
      inputs: { paymentMethod: 'bank_transfer' },
    });
    expect(html).toMatch(/formaction="[^"]*\/submit"/);
  });
});
