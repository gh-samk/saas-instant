import {
  ALLOWED_TAGS,
  escapeContent,
  htmlFromText,
  sanitize,
  textFrom,
} from './sanitizer';

/**
 * Die Fälle hier sind absichtlich unfreundlich. Ein Säuberer, der nur an
 * `<script>alert(1)</script>` geprüft wird, ist an nichts geprüft: Genau diese
 * Form probiert niemand, der es ernst meint.
 */

/**
 * Zeichen, die einen Tagnamen tarnen sollen — als ESCAPE-FOLGEN und nicht
 * wörtlich im Quelltext.
 *
 * Wörtlich eingesetzt machten sie diese Datei für Git zu einer Binärdatei
 * (das Nullzeichen genügt dafür), und im Editor sähe man an der Stelle nichts
 * als eine seltsame Lücke. Ein Test, dessen Eingabe man nicht lesen kann, ist
 * kein guter Test.
 */
const ZERO_WIDTH = '\u200b';
const BIDI = '\u202e';
const CONTROL_CHARACTERS = '\u0000';

describe('Der Säuberer lässt genau fünf Auszeichnungen durch', () => {
  it.each([...ALLOWED_TAGS].filter((tag) => tag !== 'br'))(
    'behält <%s> und schliesst es',
    (tag) => {
      expect(sanitize(`<${tag}>Text</${tag}>`)).toBe(`<${tag}>Text</${tag}>`);
    },
  );

  it('behält <br> als leeres Element', () => {
    expect(sanitize('a<br>b')).toBe('a<br>b');
    expect(sanitize('a<br/>b')).toBe('a<br>b');
    expect(sanitize('a<BR />b')).toBe('a<br>b');
    // `</br>` gibt es nicht und darf keine zweite Zeile erfinden.
    expect(sanitize('a</br>b')).toBe('ab');
  });

  it('lässt verschachtelte erlaubte Auszeichnungen zu', () => {
    expect(sanitize('<p>Ein <strong>sehr <em>wichtiger</em></strong> Satz.</p>')).toBe(
      '<p>Ein <strong>sehr <em>wichtiger</em></strong> Satz.</p>',
    );
  });

  it('vereinheitlicht Grossschreibung und Leerzeichen im Tag', () => {
    expect(sanitize('< P ><STRONG >hallo</ strong ></P>')).toBe(
      '<p><strong>hallo</strong></p>',
    );
  });
});

describe('Der Säuberer entfernt alles andere', () => {
  it('wirft <script> samt Inhalt weg', () => {
    expect(sanitize('<p>vor</p><script>alert(1)</script><p>nach</p>')).toBe(
      '<p>vor</p><p>nach</p>',
    );
    expect(sanitize('<script>alert(1)</script>')).toBe('');
  });

  it('wirft <style> samt Inhalt weg', () => {
    // Nur das Tag zu entfernen liesse die CSS-Regeln als Fliesstext stehen.
    expect(sanitize('<style>p{display:none}</style>Text')).toBe('Text');
  });

  it('behält bei anderen Tags den TEXT, nicht das Tag', () => {
    expect(sanitize('<div class="x">Hallo <span>Welt</span></div>')).toBe(
      'Hallo Welt',
    );
    expect(sanitize('<h1>Überschrift</h1>')).toBe('Überschrift');
  });

  it('entfernt jedes Attribut, auch an erlaubten Tags', () => {
    const result = sanitize(
      '<p style="color:red" onclick="alert(1)" id="x">Text</p>',
    );
    expect(result).toBe('<p>Text</p>');
    expect(result).not.toMatch(/style|onclick|id=/i);
  });

  it('entfernt Links vollständig und behält nur ihren Text', () => {
    // Der EINZIGE Verweis in einer Mail ist der, den der Rahmen setzt.
    const result = sanitize('<a href="https://fremd.example">Angebot</a>');
    expect(result).toBe('Angebot');
    expect(result).not.toContain('href');
    expect(result).not.toContain('fremd.example');
  });

  it('lässt kein <img> durch — auch kein Zählpixel', () => {
    const result = sanitize(
      '<img src="https://fremd.example/pixel.gif?id=7" width="1" height="1">',
    );
    expect(result).toBe('');
  });

  it('entfernt Kommentare, Doctype und Verarbeitungsanweisungen', () => {
    expect(sanitize('<!-- <script>alert(1)</script> -->Text')).toBe('Text');
    expect(sanitize('<!DOCTYPE html>Text')).toBe('Text');
    expect(sanitize('<?xml version="1.0"?>Text')).toBe('Text');
  });
});

describe('Der Säuberer hält den Angriffen stand, die es wirklich versuchen', () => {
  it('lässt javascript: nicht als Verweis wiederauferstehen', () => {
    const result = sanitize('<a href="javascript:alert(1)">klick</a>');
    // Der Text bleibt, aber nichts davon ist anklickbar.
    expect(result).toBe('klick');
    expect(result).not.toContain('<a');
  });

  it('fällt nicht auf ein <script> IM ATTRIBUT herein', () => {
    // Wer beim ersten `>` abbricht, hält `alert(1)</script>">Text` für Inhalt.
    const result = sanitize('<p title="<script>alert(1)</script>">Text</p>');
    expect(result).toBe('<p>Text</p>');
    expect(result).not.toContain('alert');
  });

  it('fällt nicht auf ein `>` im Attributwert herein', () => {
    expect(sanitize('<p title="a > b">Text</p>')).toBe('<p>Text</p>');
    expect(sanitize("<div data-x='a > b'>Text</div>")).toBe('Text');
  });

  it('erkennt einen mit Null-Breite getarnten Tagnamen', () => {
    // U+200B mitten in „script". Manche Programme werfen es beim Anzeigen weg.
    const disguised = `<scr${ZERO_WIDTH}ipt>alert(1)</scr${ZERO_WIDTH}ipt>`;
    expect(sanitize(disguised)).toBe('');
  });

  it('erkennt einen mit einem Steuerzeichen getarnten Tagnamen', () => {
    expect(sanitize(`<${CONTROL_CHARACTERS}script>alert(1)</script>`)).toBe('');
    expect(sanitize(`<img${CONTROL_CHARACTERS} src=x onerror=alert(1)>`)).toBe('');
  });

  it('lässt sich von Bidi-Zeichen nicht täuschen', () => {
    expect(sanitize(`<scr${BIDI}ipt>alert(1)</script>`)).toBe('');
  });

  it('lässt einen Tagnamen nicht durch Verschachtelung wieder entstehen', () => {
    // Der klassische Filter-Umgeher: `<scr<script>ipt>` wird bei einmaligem
    // Entfernen wieder zu `<script>`. Hier wird gar nichts ersetzt, sondern
    // zerlegt — das äussere `<scr…` ist ein unbekannter Tag und fällt weg.
    const result = sanitize('<scr<script>ipt>alert(1)</script>');
    expect(result).not.toMatch(/<script/i);
    // Was übrig bleibt, ist reiner Text: Jedes `<` und `>` darin ist escaped,
    // es gibt kein einziges Element mehr. `alert(1)` als sichtbare Zeichen
    // richtet nichts an — ausgeführt wird nur, was in einem Element steht.
    expect(result).not.toMatch(/<(?!\/?(?:p|br|strong|em|u)>)/);
    expect(result).toContain('&gt;');
  });

  it('kommt mit kaputtem HTML klar und gibt Ausgeglichenes zurück', () => {
    expect(sanitize('<strong>ohne Ende')).toBe('<strong>ohne Ende</strong>');
    expect(sanitize('</em>verirrtes Ende')).toBe('verirrtes Ende');
    expect(sanitize('<p><strong>falsch verschachtelt</p></strong>')).toBe(
      '<p><strong>falsch verschachtelt</strong></p>',
    );
    // Ein `<strong` ohne `>` darf nicht in den Rahmen hineinreichen.
    expect(sanitize('Text <strong')).toBe('Text ');
  });

  it('lässt Absätze nicht ineinander liegen', () => {
    expect(sanitize('<p>eins<p>zwei')).toBe('<p>eins</p><p>zwei</p>');
  });

  it('bricht bei irrwitziger Verschachtelung nicht die Ausgeglichenheit', () => {
    const deep = '<em>'.repeat(200) + 'Kern' + '</em>'.repeat(200);
    const result = sanitize(deep);
    const opened = (result.match(/<em>/g) ?? []).length;
    const closed = (result.match(/<\/em>/g) ?? []).length;
    expect(opened).toBe(closed);
    expect(result).toContain('Kern');
  });

  it('escaped ein einzelnes < als Text', () => {
    expect(sanitize('3 < 5 und 7 > 4')).toBe('3 &lt; 5 und 7 &gt; 4');
  });

  it('macht aus einer bestehenden Entität keine doppelte', () => {
    // Der Editor schickt für „&" ein `&amp;`. `&amp;amp;` zeigte wörtlich „&amp;".
    expect(sanitize('Schmitt &amp; Söhne')).toBe('Schmitt &amp; Söhne');
    // Ein einzelnes & ohne Entität wird dagegen sicher gemacht.
    expect(sanitize('Schmitt & Söhne')).toBe('Schmitt &amp; Söhne');
  });

  it('lässt eine kodierte Entität stehen — im Text ist sie harmlos', () => {
    // `&#x3c;script&#x3e;` ergibt beim Anzeigen die Zeichen `<script>`, mehr
    // nicht: eine Entität im Textinhalt wird nie ausgeführt.
    const result = sanitize('&#x3c;script&#x3e;');
    expect(result).toBe('&#x3c;script&#x3e;');
    expect(result).not.toContain('<script>');
  });

  it('liefert für jede Eingabe HTML ohne verbotene Tags', () => {
    const inputs = [
      '<svg onload=alert(1)>',
      '<math><mtext><table><mglyph><style><img src=x onerror=alert(1)>',
      '<iframe src="https://fremd.example"></iframe>',
      '<object data="x"></object>',
      '<base href="https://fremd.example/">',
      '<form action="x"><input name=y></form>',
      '<template><script>alert(1)</script></template>',
      '<!--><script>alert(1)</script>',
      '<p/><<>>',
      '<<script>script>alert(1)<</script>/script>',
    ];
    for (const input of inputs) {
      const result = sanitize(input);
      expect(result).not.toMatch(/<(?!\/?(?:p|br|strong|em|u)>)/);
      expect(result).not.toMatch(/on\w+\s*=/i);
      expect(result).not.toMatch(/\ssrc\s*=/i);
      expect(result).not.toMatch(/\shref\s*=/i);
    }
  });

  it('lässt einen zweiten Durchlauf nichts mehr ändern', () => {
    // Wäre das nicht so, hinge das Ergebnis davon ab, wie oft jemand
    // gespeichert hat.
    const inputs = [
      '<p>Hallo <a href="x">Welt</a></p>',
      '<div><script>alert(1)</script>Rest',
      '3 < 5 &amp; mehr',
      `<scr${ZERO_WIDTH}ipt>x</scr${ZERO_WIDTH}ipt>`,
    ];
    for (const input of inputs) {
      const once = sanitize(input);
      expect(sanitize(once)).toBe(once);
    }
  });
});

describe('escapeContent', () => {
  it('macht die fünf Zeichen unschädlich, die aus ihrem Kontext ausbrechen', () => {
    expect(escapeContent('<b>&"\'')).toBe('&lt;b&gt;&amp;&quot;&#39;');
  });

  /**
   * DAS IST DER GRUND, WARUM DIE BEIDEN ANFÜHRUNGSZEICHEN MITMÜSSEN.
   * `rahmen.ts` setzt das Ergebnis auch in `<a href="…">`. Ohne Escaping
   * beendete ein `"` das Attribut und könnte eigene anhängen.
   */
  it('lässt ein Anführungszeichen nicht aus einem Attribut ausbrechen', () => {
    const attribut = `<a href="${escapeContent('https://x/" onmouseover="böse')}">`;
    expect(attribut).not.toContain('onmouseover="');
    expect(attribut).toContain('&quot;');
  });

  /**
   * UND ES ÄNDERT NICHTS SICHTBARES. `&quot;` und `&#39;` werden im Textinhalt
   * als `"` und `'` gerendert, und der abgeleitete Textteil bekommt sie über
   * `textAus()` unverändert zurück. Ohne diese Zusage sähe die Erweiterung nach
   * einem Nebenwirkungsrisiko aus.
   */
  it('bringt Anführungszeichen im Textteil unverändert zurück', () => {
    const original = 'Sie sagte "ja", und es ist Annas Wort — it\'s so.';
    const html = sanitize(`<p>${original}</p>`);
    expect(html).toContain('&quot;');
    expect(html).toContain('&#39;');
    expect(textFrom(html)).toBe(original);
  });
});

describe('Der Textteil stimmt mit dem HTML-Teil überein', () => {
  it('macht aus Absätzen Leerzeilen und aus <br> einen Umbruch', () => {
    const html = sanitize('<p>Erster Absatz.</p><p>Zeile eins<br>Zeile zwei</p>');
    expect(textFrom(html)).toBe('Erster Absatz.\n\nZeile eins\nZeile zwei');
  });

  it('lässt Auszeichnungen ersatzlos weg statt Sternchen zu erfinden', () => {
    const html = sanitize('<p>Ein <strong>fettes</strong> Wort.</p>');
    expect(textFrom(html)).toBe('Ein fettes Wort.');
    expect(textFrom(html)).not.toContain('*');
  });

  it('gibt die Entitäten wieder als Zeichen aus', () => {
    expect(textFrom(sanitize('Schmitt &amp; Söhne'))).toBe('Schmitt & Söhne');
    expect(textFrom(sanitize('3 < 5'))).toBe('3 < 5');
    expect(textFrom('&#39;Zitat&#39;')).toBe("'Zitat'");
  });

  it('enthält jedes Wort des HTML-Teils in derselben Reihenfolge', () => {
    const raw =
      '<p>Liebe <strong>Gruppe</strong>,</p>' +
      '<p>am <em>Dienstag</em> gibt es eine <u>neue</u> Fassung.<br>' +
      'Sie bringt zwei Dinge mit.</p>';
    const html = sanitize(raw);
    const words = (value: string): string[] =>
      value.split(/\s+/).filter((part) => part !== '');
    // Absatz- und Umbruchtags trennen Wörter, Auszeichnungen nicht: `<strong>`
    // steht MITTEN in einem Wort, wenn jemand nur die Silbe fettet.
    const fromHtml = html
      .replace(/<\s*br\s*>|<\s*\/\s*p\s*>/gi, ' ')
      .replace(/<[^>]*>/g, '')
      .replace(/&amp;/g, '&');
    expect(words(textFrom(html))).toEqual(words(fromHtml));
  });

  it('lässt keine Restspuren von Auszeichnungen im Text', () => {
    const html = sanitize('<p>a</p><p>b<br>c</p><strong>d</strong>');
    expect(textFrom(html)).not.toMatch(/[<>]/);
  });

  it('drängt Leerzeilen zusammen und schneidet Ränder ab', () => {
    expect(textFrom('<p>a</p><p></p><p></p><p>b</p>')).toBe('a\n\nb');
  });
});

describe('htmlAusText — für alle Mails, deren Wortlaut im Quelltext steht', () => {
  it('macht aus Leerzeilen Absätze und aus Umbrüchen <br>', () => {
    expect(htmlFromText('Hallo,\n\nZeile eins\nZeile zwei')).toBe(
      '<p>Hallo,</p><p>Zeile eins<br>Zeile zwei</p>',
    );
  });

  it('escaped den Text — er kann eine Adresse oder einen Namen enthalten', () => {
    expect(htmlFromText('Anna <anna@example.com> & Co')).toBe(
      '<p>Anna &lt;anna@example.com&gt; &amp; Co</p>',
    );
  });

  it('kommt durch den Säuberer unverändert hindurch', () => {
    const html = htmlFromText('Hallo,\n\nein <b>Test</b> & mehr\nzweite Zeile');
    expect(sanitize(html)).toBe(html);
  });

  it('liefert für leeren Text ein leeres Fragment', () => {
    expect(htmlFromText('')).toBe('');
    expect(htmlFromText('\n\n  \n')).toBe('');
  });

  it('ergibt über textAus wieder den Ausgangstext', () => {
    const text = 'Hallo,\n\nZeile eins\nZeile zwei\n\nViele Grüße';
    expect(textFrom(htmlFromText(text))).toBe(text);
  });
});
