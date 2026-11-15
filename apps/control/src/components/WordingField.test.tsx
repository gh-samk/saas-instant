import { fireEvent, screen, within } from '@testing-library/react';
import { renderWithI18n as render } from '../test-support/render-with-i18n';
import { describe, expect, it, vi } from 'vitest';
import { WordingField, normalize, textFrom } from './WordingField';

/**
 * Das Redaktionsfeld für den Wortlaut.
 *
 * Der Prüfmaßstab ist nicht „sieht ein Editor so aus", sondern: Kommt am
 * Server genau das an, was der Säuberer durchlässt? Alles, was hier
 * durchrutscht, fällt beim Versand still weg — und das merkt niemand, weil
 * die Mail trotzdem ankommt, nur ohne die Hervorhebung.
 */

/** Die fünf Tags, die `saeuberer.ts` durchlässt. */
const ALLOWED = ['p', 'br', 'strong', 'em', 'u'];

describe('normalisiere — übersetzt, was die Browser uneinheitlich erzeugen', () => {
  it('macht aus <b> ein <strong>', () => {
    expect(normalize('<p>Ein <b>Wort</b></p>')).toBe(
      '<p>Ein <strong>Wort</strong></p>',
    );
  });

  it('macht aus <i> ein <em>', () => {
    expect(normalize('<p>Ein <i>Wort</i></p>')).toBe(
      '<p>Ein <em>Wort</em></p>',
    );
  });

  it('MACHT AUS <div> EIN <p> — sonst verschwände der Absatzumbruch', () => {
    // Der Säuberer verwirft <div> und behält den Text. Aus zwei Absätzen
    // würde im Postfach einer, und zwar lautlos.
    expect(normalize('<div>Erster</div><div>Zweiter</div>')).toBe(
      '<p>Erster</p><p>Zweiter</p>',
    );
  });

  it('lässt <br> in Ruhe — die Regel greift den Tag, nicht seinen Anfang', () => {
    expect(normalize('<p>Zeile<br>Zeile</p>')).toBe('<p>Zeile<br>Zeile</p>');
  });

  it('erzeugt keine Tags ausserhalb der erlaubten fünf', () => {
    const result = normalize(
      '<div>Ein <b>fettes</b> und <i>kursives</i> Wort<br><u>unterstrichen</u></div>',
    );
    const tags = [...result.matchAll(/<\/?([a-z]+)/g)].map((t) => t[1]);
    expect([...new Set(tags)].sort()).toEqual(
      [...ALLOWED].filter((tag) => tags.includes(tag)).sort(),
    );
    expect(tags).not.toContain('div');
    expect(tags).not.toContain('b');
    expect(tags).not.toContain('i');
  });
});

describe('textAus — die Fassung für Postfächer ohne HTML', () => {
  function fromHtml(html: string): string {
    const node = document.createElement('div');
    node.innerHTML = html;
    return textFrom(node);
  }

  it('macht aus Absätzen Leerzeilen', () => {
    expect(fromHtml('<p>Erster</p><p>Zweiter</p>')).toBe('Erster\n\nZweiter');
  });

  it('macht aus <br> einen einfachen Umbruch', () => {
    expect(fromHtml('<p>Zeile<br>Zeile</p>')).toBe('Zeile\nZeile');
  });

  it('lässt Auszeichnungen ersatzlos weg statt Sternchen zu erfinden', () => {
    expect(fromHtml('<p>Ein <strong>Wort</strong></p>')).toBe('Ein Wort');
  });

  it('behält Platzhalter unverändert', () => {
    expect(fromHtml('<p>Hallo {{organisation}},</p>')).toBe(
      'Hallo {{organisation}},',
    );
  });

  it('drängt Leerzeilen zusammen und schneidet Ränder ab', () => {
    expect(fromHtml('<p></p><p>Mitte</p><p></p>')).toBe('Mitte');
  });
});

describe('WortlautFeld — die Werkzeugleiste', () => {
  function build(html = '') {
    const onChange = vi.fn();
    render(
      <WordingField
        id="wortlaut"
        label="Inhalt"
        html={html}
        onChange={onChange}
      />,
    );
    return { onChange };
  }

  it('bietet genau Fett, Kursiv und Unterstrichen an — nicht mehr', () => {
    // Ein Knopf für Überschriften, Farben oder Listen wäre ein Versprechen,
    // das der Säuberer beim Versand wieder einkassiert.
    build();
    const bar = screen.getByRole('toolbar', { name: /Auszeichnungen/ });
    expect(
      within(bar)
        .getAllByRole('button')
        .map((button) => button.textContent),
    ).toEqual(['Fett', 'Kursiv', 'Unterstrichen']);
  });

  it('meldet beim Tippen HTML UND die abgeleitete Textfassung', () => {
    const { onChange } = build();
    const field = screen.getByLabelText('Inhalt');
    field.innerHTML = '<div>Ein <b>Wort</b></div>';
    fireEvent.input(field);

    expect(onChange).toHaveBeenCalledWith({
      html: '<p>Ein <strong>Wort</strong></p>',
      text: 'Ein Wort',
    });
  });

  it('nimmt dem Feld beim Klick auf die Leiste NICHT den Fokus', () => {
    // Ohne das verlöre der Klick die Auswahl, auf die sich der Befehl
    // beziehen soll — der Knopf täte dann sichtbar nichts.
    build('<p>Text</p>');
    const button = screen.getByTitle(/^Fett/);
    const event = fireEvent.mouseDown(button);
    expect(event).toBe(false); // preventDefault wurde gerufen
  });

  it('schreibt den Wortlaut nicht bei jedem Durchlauf neu', () => {
    // Ein gesteuertes contentEditable, das sein innerHTML jedes Mal neu
    // setzt, wirft den Cursor an den Anfang. Deshalb wird nur geschrieben,
    // wenn sich der Wert wirklich unterscheidet.
    build('<p>Bestand</p>');
    const field = screen.getByLabelText('Inhalt');
    const before = field.firstChild;
    fireEvent.input(field);
    expect(field.firstChild).toBe(before);
  });
});
