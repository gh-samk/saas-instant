import { LayoutButtonTargetError, marketingBody } from './layout';

/**
 * DIE VIER STRUKTURFELDER DER WERBEMAIL.
 *
 * Sie stehen ausserhalb des Redaktionsfelds, weil sie dort nicht ausdrückbar
 * sind: Der Säuberer lässt kein `<a>` durch (und soll es nicht), und eine
 * Überschrift ist eine Rolle im Rahmen, keine Formatierung im Text.
 *
 * DER KNOPF IST DIE EINZIGE STELLE, an der die Redaktion eine Adresse in eine
 * Mail dieses Hauses bringen kann. Der grösste Teil dieser Tests gilt ihm.
 */

const REASON = {
  subject: 'Neues in Beispielprodukt',
  html: '<p>Der redigierte Text.</p>',
  text: 'Der redigierte Text.',
};

describe('Was fehlt, wird weggelassen', () => {
  it('rahmt eine Vorlage ohne Strukturfelder wie vorher', () => {
    const body = marketingBody(REASON);
    expect(body.html).toBe('<p>Der redigierte Text.</p>');
    expect(body.text).toBe('Der redigierte Text.');
  });

  it('setzt keine leere Zeile, wenn nur die Vorüberschrift fehlt', () => {
    const body = marketingBody({ ...REASON, heading: 'Vier Termine' });
    expect(body.html).toContain('Vier Termine');
    expect(body.text.startsWith('Vier Termine\n')).toBe(true);
  });

  it('behandelt leere Zeichenketten wie fehlende Angaben', () => {
    const body = marketingBody({
      ...REASON,
      eyebrow: '   ',
      heading: '',
      buttonText: '',
      buttonTarget: '',
    });
    expect(body.html).toBe('<p>Der redigierte Text.</p>');
  });
});

describe('Der Knopf braucht beides', () => {
  it('erscheint mit Text UND Ziel', () => {
    const body = marketingBody({
      ...REASON,
      buttonText: 'Termine ansehen',
      buttonTarget: 'https://example.com/termine',
    });
    expect(body.html).toContain('href="https://example.com/termine"');
    expect(body.html).toContain('Termine ansehen');
    // Im TEXTTEIL steht die Adresse ausgeschrieben — ein Linktext ohne
    // Adresse ist in einer Klartextmail wertlos.
    expect(body.text).toContain('Termine ansehen: https://example.com/termine');
  });

  it('ENTFÄLLT, wenn nur das Ziel dasteht', () => {
    const body = marketingBody({ ...REASON, buttonTarget: 'https://example.com' });
    expect(body.html).not.toContain('<a');
    expect(body.text).not.toContain('https://example.com');
  });

  it('ENTFÄLLT, wenn nur die Beschriftung dasteht', () => {
    const body = marketingBody({ ...REASON, buttonText: 'Hier entlang' });
    expect(body.html).not.toContain('<a');
  });
});

describe('Das Ziel wird streng geprüft', () => {
  it.each([
    ['javascript:alert(1)'],
    ['data:text/html,<script>x</script>'],
    ['/relativ/ohne/schema'],
    ['example.com/ohne-schema'],
    ['ftp://example.com/datei'],
  ])('weist „%s" ab, statt es in die Mail zu setzen', (target) => {
    expect(() =>
      marketingBody({ ...REASON, buttonText: 'Klick', buttonTarget: target }),
    ).toThrow(LayoutButtonTargetError);
  });

  it('lässt http und https durch', () => {
    for (const target of ['http://example.com/x', 'HTTPS://Example.com/x']) {
      expect(() =>
        marketingBody({ ...REASON, buttonText: 'Klick', buttonTarget: target }),
      ).not.toThrow();
    }
  });

  it('PRÜFT NICHT, WAS ES NICHT SETZT: kein Knopf, keine Prüfung', () => {
    // Ein ungültiges Ziel ohne Beschriftung erscheint nirgends. Es dennoch
    // abzuweisen machte eine alte, halb ausgefüllte Zeile unrettbar.
    expect(() =>
      marketingBody({ ...REASON, buttonTarget: 'javascript:alert(1)' }),
    ).not.toThrow();
  });
});

describe('Alles Redigierte wird maskiert', () => {
  it('deutet spitze Klammern in Überschrift und Knopftext nicht als Markup', () => {
    const body = marketingBody({
      ...REASON,
      eyebrow: 'A & B',
      heading: '<script>böse()</script>',
      buttonText: '5 % <b>mehr</b>',
      buttonTarget: 'https://example.com/x',
    });
    expect(body.html).toContain('A &amp; B');
    expect(body.html).toContain('&lt;script&gt;');
    expect(body.html).not.toContain('<script>');
    expect(body.html).toContain('5 % &lt;b&gt;mehr&lt;/b&gt;');
  });

  it('maskiert auch das Ziel im href', () => {
    const body = marketingBody({
      ...REASON,
      buttonText: 'Klick',
      buttonTarget: 'https://example.com/x?a=1&b=2',
    });
    expect(body.html).toContain('a=1&amp;b=2');
  });
});
