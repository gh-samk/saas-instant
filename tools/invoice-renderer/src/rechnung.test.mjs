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
    assert.ok(!/&(?!amp;|lt;|gt;|#)/.test(xml), `${name}: unmaskiertes & gefunden`);
  }
});

test('ohne Komplementaerin druckt das Layout keinen Block dazu', () => {
  const eingabe = structuredClone(beispielrechnung);
  delete eingabe.aussteller.komplementaerin;
  const html = erzeugeHtml(berechneRechnung(eingabe));
  assert.ok(!html.includes('Persönlich haftende Gesellschafterin'));
  assert.ok(!html.includes('Geschäftsführer:'));
  assert.ok(erzeugeHtml(berechneRechnung(beispielrechnung)).includes('Persönlich haftende Gesellschafterin'));
});

test('HTML enthaelt keine externen Ressourcen', () => {
  const html = erzeugeHtml(berechneRechnung(beispielrechnung));
  assert.ok(!/https?:\/\//.test(html), 'Eine externe Adresse im Layout wuerde beim Rendern fehlen.');
});
