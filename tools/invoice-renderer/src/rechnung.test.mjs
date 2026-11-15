// Tests fuer das Rechenwerk und die Erzeuger.
// Aufruf:  node --test src/
//
// Geprueft wird das, was still falsch werden kann: Rundung, Steueraufteilung,
// Maskierung und die Vollstaendigkeitspruefung. Ob das erzeugte XML fachlich
// gueltig ist, beantworten diese Tests NICHT — das tun die Validatoren
// im Rechnungsdienst (Mustangproject, siehe README.md).

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { berechneRechnung, centAlsText, centAlsXml, datumAlsCii, rundeCent } from './rechnung.mjs';
import { erzeugeCii } from './cii-en16931.mjs';
import { erzeugeUbl } from './ubl-xrechnung.mjs';
import { erzeugeHtml } from './layout-html.mjs';
import { beispielrechnung } from '../daten/beispielrechnung.mjs';

test('Betraege werden in ganzen Cent gefuehrt', () => {
  assert.equal(rundeCent(87500 * 0.19), 16625);
  assert.equal(centAlsXml(104125), '1041.25');
  assert.equal(centAlsXml(5), '0.05');
  assert.equal(centAlsXml(-5), '-0.05');
  assert.equal(centAlsText(104125), '1.041,25');
});

test('centAlsXml weist Bruchteile von Cent ab', () => {
  assert.throws(() => centAlsXml(10.5), TypeError);
});

test('datumAlsCii weist alles ab, was nicht JJJJ-MM-TT ist', () => {
  assert.equal(datumAlsCii('2026-08-31'), '20260831');
  assert.throws(() => datumAlsCii('31.08.2026'), TypeError);
  assert.throws(() => datumAlsCii('2026-08-31T00:00:00Z'), TypeError);
});

test('Steuer wird je Satz gebildet, nicht je Posten', () => {
  // Zwei Posten zu 0,05 EUR: je Posten gerundet ergaebe 2 x 0,01 = 0,02.
  // Richtig ist die Rundung auf die Summe: 0,10 x 19 % = 0,019 -> 0,02.
  // Der Fall zeigt, dass ueberhaupt auf der Summe gerechnet wird.
  const rechnung = berechneRechnung({
    ...beispielrechnung,
    posten: [
      { bezeichnung: 'A', menge: 1, einheit: 'C62', einzelpreisCent: 5, steuersatz: 19 },
      { bezeichnung: 'B', menge: 1, einheit: 'C62', einzelpreisCent: 5, steuersatz: 19 },
    ],
  });
  assert.equal(rechnung.steueraufteilung.length, 1);
  assert.equal(rechnung.steueraufteilung[0].grundlageCent, 10);
  assert.equal(rechnung.steueraufteilung[0].steuerCent, 2);
});

test('verschiedene Steuersaetze werden getrennt ausgewiesen', () => {
  const rechnung = berechneRechnung({
    ...beispielrechnung,
    posten: [
      { bezeichnung: 'A', menge: 1, einheit: 'C62', einzelpreisCent: 10000, steuersatz: 19 },
      { bezeichnung: 'B', menge: 1, einheit: 'C62', einzelpreisCent: 10000, steuersatz: 7 },
    ],
  });
  assert.equal(rechnung.steueraufteilung.length, 2);
  assert.equal(rechnung.summeSteuerCent, 1900 + 700);
});

test('die Beispielrechnung ergibt 875,00 netto und 1.041,25 brutto', () => {
  const rechnung = berechneRechnung(beispielrechnung);
  assert.equal(rechnung.summeNettoCent, 87500);
  assert.equal(rechnung.summeSteuerCent, 16625);
  assert.equal(rechnung.zahlbetragCent, 104125);
});

test('fehlende Pflichtangaben brechen die Erzeugung ab', () => {
  const ohneSteuernummer = structuredClone(beispielrechnung);
  delete ohneSteuernummer.aussteller.ustIdNr;
  assert.throws(
    () => berechneRechnung(ohneSteuernummer),
    /aussteller\.ustIdNr/,
    'Eine Rechnung ohne USt-IdNr. darf nicht entstehen.',
  );
});

test('eine Rechnung ohne Posten wird abgewiesen', () => {
  assert.throws(() => berechneRechnung({ ...beispielrechnung, posten: [] }), /posten/);
});

test('negative Menge wird abgewiesen', () => {
  assert.throws(
    () =>
      berechneRechnung({
        ...beispielrechnung,
        posten: [{ bezeichnung: 'A', menge: -1, einheit: 'C62', einzelpreisCent: 100, steuersatz: 19 }],
      }),
    /menge/,
  );
});

test('CII traegt die Angaben nach § 125a HGB', () => {
  const xml = erzeugeCii(berechneRechnung(beispielrechnung));
  assert.match(xml, /<ram:Description>[^<]*HRA 00000[^<]*HRB 00000[^<]*<\/ram:Description>/);
  assert.match(xml, /<ram:SpecifiedLegalOrganization><ram:ID>HRA 00000<\/ram:ID>/);
  assert.match(xml, /<ram:ID schemeID="VA">DE123456789<\/ram:ID>/);
});

test('UBL traegt dieselben Angaben in CompanyLegalForm', () => {
  const xml = erzeugeUbl(berechneRechnung(beispielrechnung));
  assert.match(xml, /<cbc:CompanyLegalForm>[^<]*HRB 00000[^<]*<\/cbc:CompanyLegalForm>/);
  assert.match(xml, /<cbc:CompanyID>HRA 00000<\/cbc:CompanyID>/);
  // Die Kennung entscheidet ueber das Regelwerk des KoSIT-Validators.
  assert.match(xml, /urn:xeinkauf\.de:kosit:xrechnung_3\.0</);
});

test('kaufmaennisches Und wird in allen drei Ausgaben maskiert', () => {
  const rechnung = berechneRechnung(beispielrechnung);
  // "Example Company GmbH & Co KG" enthaelt ein &. Bliebe es stehen, waere das
  // XML nicht wohlgeformt und das HTML fehlerhaft.
  for (const [name, xml] of [
    ['CII', erzeugeCii(rechnung)],
    ['UBL', erzeugeUbl(rechnung)],
    ['HTML', erzeugeHtml(rechnung)],
  ]) {
    assert.ok(xml.includes('GmbH &amp; Co KG'), `${name}: & nicht maskiert`);
    assert.ok(!/&(?!amp;|lt;|gt;|quot;|#)/.test(xml), `${name}: unmaskiertes & gefunden`);
  }
});

const PNG_PUNKT =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';

function html(aenderung = (e) => e, optionen) {
  const eingabe = structuredClone(beispielrechnung);
  aenderung(eingabe);
  return erzeugeHtml(berechneRechnung(eingabe), optionen);
}

test('Fusszeile und Kopf drucken genau die Zeilen aus issuer.blocks', () => {
  const ausgabe = html((e) => {
    e.aussteller.blocks = {
      companyLines: ['Firma Eins', 'Weg 1', '11111 Ort'],
      contactLines: ['Tel. 123'],
      bankLines: ['Bank X', 'IBAN DE00 1111'],
      legalLines: ['Amtsgericht Y, HRB 5', 'USt-IdNr. DE999'],
    };
  });
  for (const zeile of ['Firma Eins', 'Weg 1', '11111 Ort', 'Tel. 123', 'Bank X', 'IBAN DE00 1111', 'Amtsgericht Y, HRB 5', 'USt-IdNr. DE999']) {
    assert.ok(ausgabe.includes(zeile), `Zeile fehlt: ${zeile}`);
  }
  assert.match(ausgabe, /<div class="bank">Bank X<br>IBAN DE00 1111<\/div>/);
  assert.match(ausgabe, /<div class="legal">Amtsgericht Y, HRB 5<br>USt-IdNr\. DE999<\/div>/);
  // Der Renderer erfindet keine Angaben aus anderen Feldern (Beispiel: HRA, Komplementaerin).
  assert.ok(!ausgabe.includes('HRA 00000'));
  assert.ok(!ausgabe.includes('Example Management'));
  assert.ok(!ausgabe.includes('Persönlich haftende'));
});

test('keine Doppelung der Firmenangaben: Name, Anschrift und Bank je genau einmal', () => {
  for (const logo of [null, PNG_PUNKT]) {
    const ausgabe = html((e) => {
      e.aussteller.logoDataUri = logo;
    });
    const nenne = (text) => ausgabe.split(text).length - 1;
    assert.equal(nenne('Example Street 1'), 1);
    assert.equal(nenne('12345 Example City'), 1);
    assert.equal(nenne('Example Company GmbH &amp; Co KG'), 1, `Firmenname (Logo: ${Boolean(logo)})`);
    assert.equal(nenne('IBAN DE02 1203 0000 0000 2020 51'), 1);
    assert.equal(nenne('USt-IdNr. DE123456789'), 1);
  }
});

test('mit Logo: Bild (max. 9 mm hoch), Firmenname fett rechts; ohne Logo: Name als Wortmarke', () => {
  const mit = html((e) => {
    e.aussteller.logoDataUri = PNG_PUNKT;
  });
  assert.ok(mit.includes(`<img class="logo" src="${PNG_PUNKT}"`));
  assert.match(mit, /\.logo \{[^}]*max-height: 9mm/);
  assert.ok(mit.includes('<b>Example Company GmbH &amp; Co KG</b>'));
  assert.ok(!mit.includes('class="wortmarke"'));

  const ohne = html();
  assert.ok(!ohne.includes('<img'));
  assert.ok(ohne.includes('<div class="wortmarke">Example Company GmbH &amp; Co KG</div>'));
});

test('ungueltige Logo-Adressen werden nicht gedruckt (keine externen Ressourcen)', () => {
  for (const schlecht of ['https://example.com/logo.png', 'javascript:alert(1)', 'data:text/html;base64,AAAA', 'data:image/png;base64,AA"onerror="x']) {
    const ausgabe = html((e) => {
      e.aussteller.logoDataUri = schlecht;
    });
    assert.ok(!ausgabe.includes('<img'), schlecht);
  }
});

test('Akzentfarbe: nur gueltiges #RRGGBB, sonst Vorgabe #0369A1; nur fuer Titel und Wortmarke', () => {
  assert.match(html((e) => { e.aussteller.accentColor = '#7c2d12'; }), /--acc: #7c2d12;/);
  for (const schlecht of [null, 'red', '#fff', 'url(x)', '#12345g']) {
    assert.match(html((e) => { e.aussteller.accentColor = schlecht; }), /--acc: #0369A1;/, String(schlecht));
  }
  const ausgabe = html();
  assert.equal(ausgabe.split('var(--acc)').length - 1, 2, 'Akzent nur fuer h1 und .wortmarke');
});

test('Rechnungsdaten sind Nutzereingaben und werden lueckenlos maskiert', () => {
  const boese = '<script>alert(1)</script>"\'&';
  const ausgabe = html((e) => {
    e.empfaenger.name = boese;
    e.empfaenger.anschrift.strasse = boese;
    e.posten[0].bezeichnung = boese;
    e.nummer = boese;
    e.buyerReference = boese;
    e.zahlungsbedingung = boese;
    e.aussteller.blocks.companyLines = [boese];
    e.aussteller.blocks.contactLines = [boese];
    e.aussteller.blocks.bankLines = [boese];
    e.aussteller.blocks.legalLines = [boese];
  });
  assert.ok(!ausgabe.includes('<script'));
  assert.ok(!ausgabe.includes('alert(1)</script>'));
  assert.ok(ausgabe.includes('&lt;script&gt;alert(1)&lt;/script&gt;&quot;&#39;&amp;'));
});

test('Entwurf B: sechs Spalten, Raender 20 mm, Inter, Gewicht 600, Grau #6b7480', () => {
  const ausgabe = html();
  assert.match(ausgabe, /grid-template-columns: repeat\(6, minmax\(0, 1fr\)\);\s*column-gap: 4mm/);
  assert.match(ausgabe, /--m: 20mm/);
  assert.match(ausgabe, /--mut: #6b7480/);
  assert.match(ausgabe, /font-family: "Inter Variable"/);
  assert.match(ausgabe, /b \{ font-weight: 600; \}/);
  assert.match(ausgabe, /line-height: var\(--u\)/);
  assert.match(ausgabe, /--u: 4\.5mm/);
});

test('im ganzen HTML gibt es nur EINE Schriftgroesse: 9 pt', () => {
  for (const ausgabe of [html(), html((e) => { e.aussteller.logoDataUri = PNG_PUNKT; }), html((e) => { e.posten.push({ bezeichnung: 'B', menge: 1, einheit: 'MON', einzelpreisCent: 100, steuersatz: 7 }); })]) {
    const werte = new Set([...ausgabe.matchAll(/font-size\s*:\s*([^;}"]+)/g)].map((m) => m[1].trim()));
    assert.ok(werte.size >= 1);
    // `inherit` (h1) erbt den Wert vom body; ausser 9pt darf nichts vorkommen.
    assert.deepEqual([...werte].filter((w) => w !== 'inherit'), ['9pt']);
    assert.ok(!/<(small|h2|h3|big)\b/.test(ausgabe));
    assert.ok(!/style="[^"]*font-size/.test(ausgabe));
  }
});

test('Positionstabelle: Spalten, Einheiten, keine Unterzeile; USt-Spalte nur bei mehreren Saetzen', () => {
  const einfach = html((e) => {
    e.posten = [
      { bezeichnung: 'Abo', beschreibung: 'Unterzeile darf nicht erscheinen', menge: 1, einheit: 'MON', einzelpreisCent: 4900, steuersatz: 19 },
      { bezeichnung: 'Setup', menge: 1, einheit: 'C62', einzelpreisCent: 12000, steuersatz: 19 },
      { bezeichnung: 'Lizenz', menge: 1, einheit: 'ANN', einzelpreisCent: 100, steuersatz: 19 },
      { bezeichnung: 'Halb', menge: 1, einheit: 'X', einheitText: 'Halbjahr', einzelpreisCent: 100, steuersatz: 19 },
    ];
  });
  for (const kopf of ['Pos.', 'Leistung', 'Menge', 'Einheit', 'Einzelpreis', 'Netto']) assert.ok(einfach.includes(`>${kopf}<`), kopf);
  for (const einheit of ['Monat', 'einmalig', 'Jahr', 'Halbjahr']) assert.ok(einfach.includes(`<td>${einheit}</td>`), einheit);
  assert.ok(!einfach.includes('Unterzeile'));
  assert.ok(!einfach.includes('>USt<'));
  assert.ok(einfach.includes('zzgl. 19 % USt<'));

  const gemischt = html((e) => {
    e.posten = [
      { bezeichnung: 'A', menge: 1, einheit: 'MON', einzelpreisCent: 10000, steuersatz: 19 },
      { bezeichnung: 'B', menge: 1, einheit: 'MON', einzelpreisCent: 10000, steuersatz: 7 },
    ];
  });
  assert.ok(gemischt.includes('>USt<'));
  assert.ok(gemischt.includes('<td class="r">7 %</td>'));
  assert.ok(gemischt.includes('zzgl. 7 % USt auf 100,00 €'));
});

test('Kopfzeile der Tabelle und Fusszeile wiederholen sich je Seite', () => {
  const ausgabe = html();
  assert.match(ausgabe, /table\.posten thead \{ display: table-header-group; \}/);
  assert.match(ausgabe, /table\.posten tfoot \{ display: table-footer-group; \}/);
  assert.match(ausgabe, /\.ft \{ position: fixed;/);
  assert.match(ausgabe, /tr\.block \{ break-inside: avoid; \}/);
});

test('Details: Leitweg-ID nur wenn gesetzt; Zeitraum im Jahr gekuerzt', () => {
  const ohne = html();
  assert.ok(!ohne.includes('Leitweg-ID'));
  const mit = html((e) => {
    e.buyerReference = '04011000-1234512345-06';
    e.leistungszeitraum = { von: '2026-11-01', bis: '2026-11-30' };
  });
  assert.ok(mit.includes('Leitweg-ID</span><span>04011000-1234512345-06'));
  assert.ok(mit.includes('01.11. – 30.11.2026'));
  for (const wort of ['Nummer', 'Datum', 'Zeitraum', 'Fällig am']) assert.ok(mit.includes(`>${wort}<`), wort);
});

test('ZUGFeRD-Hinweis nur beim Profil EN16931, nicht bei XRechnung', () => {
  const hinweis = 'Diese Rechnung enthält eine maschinenlesbare Fassung nach ZUGFeRD (EN 16931).';
  assert.ok(html(undefined, { profil: 'EN16931' }).includes(hinweis));
  assert.ok(html().includes(hinweis));
  assert.ok(!html(undefined, { profil: 'XRECHNUNG' }).includes(hinweis));
  assert.ok(!html(undefined, { profil: 'XRECHNUNG' }).includes('ZUGFeRD'));
});

test('eine Fusszeile mit vielen Zeilen waechst nach oben und der Inhalt endet davor', () => {
  const kurz = html();
  const lang = html((e) => {
    e.aussteller.blocks.legalLines = Array.from({ length: 10 }, (_, i) => `Zeile ${i + 1}`);
  });
  const oben = (h) => Number(/\.ft \{[^}]*top: ([\d.]+)mm/.exec(h)[1]);
  const reserve = (h) => Number(/class="raum" colspan="\d+" style="height:([\d.]+)mm"><\/td><\/tr><\/tfoot>/.exec(h)[1]);
  assert.equal(oben(kurz), 247.5);
  assert.ok(oben(lang) < oben(kurz));
  assert.ok(reserve(lang) > reserve(kurz));
});

test('HTML enthaelt keine externen Ressourcen', () => {
  const html = erzeugeHtml(berechneRechnung(beispielrechnung));
  assert.ok(!/https?:\/\//.test(html), 'Eine externe Adresse im Layout wuerde beim Rendern fehlen.');
});
