// Das sichtbare Rechnungsdokument als HTML (Rechnungsdesign "B", Briefkopf).
//
// Der Weg nach PDF laeuft ueber Chromium im Container (siehe README.md).
//
// Raster (identisch zu docs/design-proposals/rechnung-entwurf-b.html):
//   * A4, Raender 20 mm, sechs Spalten zu je 25 mm, Steg 4 mm
//   * Spaltenlinien bei 0, 29, 58, 87, 116, 145 mm (ab linkem Rand)
//   * Basislinie 4,5 mm, EINE Schriftgroesse (9 pt) fuer alles
//   * Hierarchie nur ueber Gewicht (600) und Grau (#6b7480)
//
// Der Renderer druckt nur Zeilen, die er bekommt (issuer.blocks); er kennt
// keine Rechtsform und erfindet nichts. Die Rechtsformlogik liegt im Backend.
//
// Fuer PDF/A gilt weiterhin: keine externen Ressourcen (kein Bild per URL,
// keine Webfont-URL). Das Logo kommt als data:-URI, die Schrift liegt im
// Container (Dockerfile: /usr/share/fonts/truetype/inter).

import { centAlsText, datumAlsText } from './rechnung.mjs';

const BASISLINIE_MM = 4.5;
const SEITE_MM = 297;
const RAND_OBEN_MM = 20; // Raum oberhalb der Tabelle auf Folgeseiten
const FUSS_TOP_MM = 247.5; // Fusszeile beginnt hier (bis 6 Zeilen)
const FUSS_ZEILEN_VORGABE = 6;
const FUSS_ABSTAND_MM = 4.5; // Luft zwischen Inhalt und Fusszeile
// Seite 1: Tabellenkopf bei 103,5 mm; davor liegt der obere Raum (thead) von 20 mm.
const KOPF_RAUM_MM = 103.5 - RAND_OBEN_MM;
const AKZENT_VORGABE = '#0369A1';

/** Maskiert Text fuer HTML-Inhalt und Attribute. */
function h(text) {
  return String(text)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

/** Zeilen bereinigen: nur nichtleere Zeichenketten. */
function zeilen(liste) {
  return (Array.isArray(liste) ? liste : [])
    .filter((z) => z !== undefined && z !== null)
    .map((z) => String(z).trim())
    .filter((z) => z !== '');
}

const LOGO_MUSTER = /^data:image\/(?:png|jpeg|gif|webp|svg\+xml);base64,[A-Za-z0-9+/]+=*$/;
const FARBE_MUSTER = /^#[0-9a-fA-F]{6}$/;

/** Anzeigetext der Einheit. Ein ausdrueckliches `einheitText` hat Vorrang. */
function einheitAlsText(posten) {
  if (posten.einheitText) return String(posten.einheitText);
  const tabelle = { MON: 'Monat', ANN: 'Jahr', HAR: 'Halbjahr', C62: 'einmalig' };
  return tabelle[posten.einheit] ?? String(posten.einheit ?? '');
}

/** Menge lesbar: ganze Zahlen ohne Nachkommastellen. */
function mengeAlsText(menge) {
  return Number.isInteger(menge)
    ? String(menge)
    : menge.toLocaleString('de-DE', { minimumFractionDigits: 1, maximumFractionDigits: 3 });
}

/** Satz ohne unnoetige Nachkommastellen: 19 -> "19", 7.5 -> "7,5". */
function satzAlsText(satz) {
  return Number(satz).toLocaleString('de-DE', { maximumFractionDigits: 2 });
}

/** Zeitraum kurz: gleiches Jahr -> "01.11. – 30.11.2026". */
function zeitraumAlsText(von, bis) {
  const a = datumAlsText(von);
  const b = datumAlsText(bis);
  if (von === bis) return b;
  return von.slice(0, 4) === bis.slice(0, 4) ? `${a.slice(0, 6)} – ${b}` : `${a} – ${b}`;
}

function landAlsText(land) {
  const wert = String(land ?? '').trim();
  if (wert === '') return '';
  if (/^[A-Za-z]{2}$/.test(wert)) {
    try {
      return new Intl.DisplayNames(['de'], { type: 'region' }).of(wert.toUpperCase()) ?? wert;
    } catch {
      return wert;
    }
  }
  return wert;
}

/** Grobe Zeilenzahl einer Fusszeilenspalte (Zeilenumbruch bei ca. 46 Zeichen). */
function fussZeilenAnzahl(liste) {
  return liste.reduce((summe, z) => summe + Math.max(1, Math.ceil(z.length / 46)), 0);
}

/**
 * @param {object} r berechnete Rechnung (siehe berechneRechnung)
 * @param {object} [optionen]
 * @param {'EN16931'|'XRECHNUNG'} [optionen.profil] ZUGFeRD-Hinweis nur bei EN16931
 */
export function erzeugeHtml(r, optionen = {}) {
  const profil = optionen.profil ?? 'EN16931';
  const a = r.issuer ?? r.aussteller ?? {};
  const bloecke = a.blocks ?? {};
  const firma = zeilen(bloecke.companyLines);
  const kontakt = zeilen(bloecke.contactLines);
  const bank = zeilen(bloecke.bankLines);
  const recht = zeilen(bloecke.legalLines);
  const e = r.empfaenger;

  const logo = typeof a.logoDataUri === 'string' && LOGO_MUSTER.test(a.logoDataUri) ? a.logoDataUri : null;
  const akzent = typeof a.accentColor === 'string' && FARBE_MUSTER.test(a.accentColor) ? a.accentColor : AKZENT_VORGABE;

  // Kopf links: Logo, sonst der Firmenname (dann nicht noch einmal rechts).
  const markeHtml = logo
    ? `<img class="logo" src="${h(logo)}" alt="">`
    : firma.length > 0
      ? `<div class="wortmarke">${h(firma[0])}</div>`
      : '';
  const firmaRechts = logo ? firma : firma.slice(1);
  const kopfZeilen = [];
  firmaRechts.forEach((z, i) => kopfZeilen.push(logo && i === 0 ? `<b>${h(z)}</b>` : h(z)));
  if (kontakt.length > 0) {
    if (firmaRechts.length > 0) kopfZeilen.push('');
    kontakt.forEach((z) => kopfZeilen.push(h(z)));
  }

  // Details: Leitweg-ID nur, wenn gesetzt.
  const leitweg = r.buyerReference ?? r.leitwegId;
  const details = [
    ['Nummer', h(r.nummer)],
    ['Datum', datumAlsText(r.rechnungsdatum)],
    ['Zeitraum', zeitraumAlsText(r.leistungszeitraum.von, r.leistungszeitraum.bis)],
    ['Fällig am', datumAlsText(r.faelligAm)],
  ];
  if (leitweg && String(leitweg).trim() !== '') details.push(['Leitweg-ID', h(leitweg)]);

  // Empfaengerfenster (DIN 5008 Form B).
  const land = landAlsText(e.anschrift?.land);
  const empfaenger = [
    `<b>${h(e.name)}</b>`,
    e.ansprechpartner ? `z. Hd. ${h(e.ansprechpartner)}` : '',
    e.anschrift?.strasse ? h(e.anschrift.strasse) : '',
    h(`${e.anschrift?.plz ?? ''} ${e.anschrift?.ort ?? ''}`.trim()),
    land ? h(land) : '',
  ].filter((z) => z !== '');

  // Mehrere Steuersaetze: eine USt-Spalte je Position, sonst nicht.
  const mehrereSaetze = new Set(r.posten.map((p) => `${p.steuerkategorie ?? 'S'}|${p.steuersatz}`)).size > 1;
  const spalten = mehrereSaetze ? [8, 75, 4, 12, 17, 22, 10, 22] : [8, 75, 4, 14, 21, 24, 24];
  const colgroup = spalten.map((breite) => `<col style="width:${breite}mm">`).join('');

  const postenZeilen = r.posten
    .map(
      (p) => `
      <tr>
        <td class="pos">${h(p.zeile)}</td>
        <td><b>${h(p.bezeichnung)}</b></td>
        <td></td>
        <td>${h(mengeAlsText(p.menge))}</td>
        <td>${h(einheitAlsText(p))}</td>
        <td class="r">${centAlsText(p.einzelpreisCent)} €</td>${mehrereSaetze ? `\n        <td class="r">${h(satzAlsText(p.steuersatz))} %</td>` : ''}
        <td class="r">${centAlsText(p.nettoCent)} €</td>
      </tr>`,
    )
    .join('');

  const summenZeilen = [
    `<div class="row"><span>Summe netto</span><span>${centAlsText(r.summeNettoCent)} €</span></div>`,
    ...r.steueraufteilung.map(
      (t) =>
        `<div class="row"><span>zzgl. ${h(satzAlsText(t.satz))} % USt${
          mehrereSaetze ? ` auf ${centAlsText(t.grundlageCent)} €` : ''
        }</span><span>${centAlsText(t.steuerCent)} €</span></div>`,
    ),
  ];
  if (r.vorausgezahltCent > 0) {
    summenZeilen.push(
      `<div class="row"><span>abzüglich Anzahlung</span><span>−${centAlsText(r.vorausgezahltCent)} €</span></div>`,
    );
  }
  const befreiung = r.steueraufteilung
    .map((t) => t.befreiungsgrund)
    .filter((g, i, alle) => g && alle.indexOf(g) === i)
    .map((g) => `<p class="grau">${h(g)}</p>`)
    .join('');

  const zahlungstext =
    [r.zahlungsbedingung, r.hinweis]
      .map((t) => String(t ?? '').trim())
      .filter((t) => t !== '')
      .join(' ') ||
    'Zahlbar ohne Abzug bis zum Fälligkeitsdatum auf das unten genannte Konto, Verwendungszweck: Rechnungsnummer.';
  const zugferd =
    profil === 'EN16931'
      ? '<p class="note grau">Diese Rechnung enthält eine maschinenlesbare Fassung nach ZUGFeRD (EN 16931).</p>'
      : '';

  // Fusszeile: ab 6 Zeilen waechst sie nach oben, der Inhalt endet davor.
  const fussZeilen = Math.max(fussZeilenAnzahl(bank), fussZeilenAnzahl(recht), 1);
  const fussTop = FUSS_TOP_MM - Math.max(0, fussZeilen - FUSS_ZEILEN_VORGABE) * BASISLINIE_MM;
  const randUnten = SEITE_MM - fussTop + FUSS_ABSTAND_MM;

  const fussHtml =
    bank.length > 0 || recht.length > 0
      ? `<div class="ft g">
  <div class="bank">${bank.map(h).join('<br>')}</div>
  <div class="legal">${recht.map(h).join('<br>')}</div>
</div>`
      : '';

  return `<!DOCTYPE html>
<html lang="de">
<head>
<meta charset="utf-8">
<title>Rechnung ${h(r.nummer)}</title>
<style>
  @font-face {
    font-family: "Inter Variable";
    src: local("Inter Variable"), url("file:///usr/share/fonts/truetype/inter/InterVariable.ttf") format("truetype");
    font-weight: 100 900;
    font-style: normal;
  }
  @page { size: A4; margin: 0; }
  :root { --ink: #16191d; --mut: #6b7480; --hair: #cfd3d9; --acc: ${akzent}; --m: 20mm; --u: ${BASISLINIE_MM}mm; }
  * { box-sizing: border-box; margin: 0; padding: 0; }
  html { -webkit-print-color-adjust: exact; print-color-adjust: exact; }
  body {
    font-family: "Inter Variable", "DejaVu Sans", sans-serif;
    font-size: 9pt;
    line-height: var(--u);
    color: var(--ink);
    font-feature-settings: "tnum";
  }
  b { font-weight: 600; }
  .grau { color: var(--mut); }
  .g { display: grid; grid-template-columns: repeat(6, minmax(0, 1fr)); column-gap: 4mm; }
  .abs { position: absolute; left: var(--m); right: var(--m); }
  /* Alle Koordinaten von der Papierkante, wie im Entwurf (Seite 1) */
  .marke { position: absolute; left: var(--m); top: 13.5mm; }
  .logo { display: block; max-height: 9mm; max-width: 60mm; width: auto; height: auto; }
  .wortmarke { color: var(--acc); font-weight: 600; }
  .co { top: 13.5mm; color: var(--mut); }
  .co > div { grid-column: 4 / span 3; }
  .co b { color: var(--ink); }
  .window { top: 49.5mm; width: 85mm; height: 40.5mm; right: auto; }
  .meta { top: 49.5mm; }
  .meta > div { grid-column: 4 / span 3; display: grid; grid-template-columns: 29mm 1fr; }
  .meta .l { color: var(--mut); }
  .fold { position: absolute; left: 0; width: 5mm; height: .2mm; background: #8a919b; }
  /* Titel bei 94,5 mm, Tabellenkopf bei 103,5 mm (Seite 1). Die ganze Seite ist
     EINE Tabelle: thead (Raum oben 20 mm + Spaltenkopf) und tfoot (Raum fuer
     die Fusszeile) wiederholen sich je Seite; so gilt der Seitenrand auch auf
     Folgeseiten, ohne dass @page-Raender Inhalt abschneiden. */
  .lead { height: ${KOPF_RAUM_MM}mm; }
  h1 { position: absolute; left: var(--m); top: 94.5mm; font-size: inherit; font-weight: 600; color: var(--acc); }
  table.posten { margin-left: var(--m); width: calc(100% - 2 * var(--m)); border-collapse: collapse; table-layout: fixed; }
  table.posten thead { display: table-header-group; }
  table.posten tfoot { display: table-footer-group; }
  table.posten td.raum { padding: 0; border: 0; }
  table.posten th { text-align: left; font-weight: 400; color: var(--mut); padding: 0 0 2.25mm; border-bottom: .2mm solid var(--ink); }
  table.posten td { vertical-align: top; padding: 2.25mm 0; border-bottom: .2mm solid var(--hair); }
  table.posten tr { break-inside: avoid; }
  table.posten .r, table.posten th.r { text-align: right; }
  td.pos { color: var(--mut); }
  td.pos, th.pos { padding-left: 0; }
  tr.block { break-inside: avoid; }
  table.posten td.block { padding: 0; border: 0; }
  .sum { margin-top: 4.5mm; }
  .sum > div { grid-column: 4 / span 3; }
  .sum .row { display: flex; justify-content: space-between; }
  .sum .tot { border-top: .2mm solid var(--ink); margin-top: 2.25mm; padding-top: 2.25mm; font-weight: 600; }
  .sum .grau { margin-top: var(--u); }
  .pay { margin-top: 9mm; }
  .pay > div { grid-column: 4 / span 3; }
  .pay .note { margin-top: var(--u); }
  .ft { position: fixed; left: var(--m); right: var(--m); top: ${fussTop}mm; color: var(--mut); }
  .ft .bank { grid-column: 1 / span 3; }
  .ft .legal { grid-column: 4 / span 3; }
</style>
</head>
<body>
<div class="fold" style="top:105mm"></div>
<div class="fold" style="top:148.5mm;width:7mm"></div>
<div class="fold" style="top:210mm"></div>

<div class="marke">${markeHtml}</div>
<div class="abs g co"><div>${kopfZeilen.length > 0 ? kopfZeilen.join('<br>') : ''}</div></div>
<div class="abs window">${empfaenger.join('<br>')}</div>
<div class="abs g meta"><div>${details
    .map(([bezeichnung, wert]) => `<span class="l">${h(bezeichnung)}</span><span>${wert}</span>`)
    .join('')}</div></div>

<h1>Rechnung</h1>
<div class="lead"></div>
<table class="posten">
    <colgroup>${colgroup}</colgroup>
    <thead>
      <tr class="sp"><td class="raum" colspan="${spalten.length}" style="height:${RAND_OBEN_MM}mm"></td></tr>
      <tr>
        <th class="pos">Pos.</th><th>Leistung</th><th></th><th>Menge</th><th>Einheit</th><th class="r">Einzelpreis</th>${
          mehrereSaetze ? '<th class="r">USt</th>' : ''
        }<th class="r">Netto</th>
      </tr>
    </thead>
    <tbody>${postenZeilen}
      <tr class="block"><td class="block" colspan="${spalten.length}">
  <div class="g sum"><div>
    ${summenZeilen.join('\n    ')}
    <div class="row tot"><span>Rechnungsbetrag</span><span>${centAlsText(r.zahlbetragCent)} €</span></div>
    ${befreiung}
  </div></div>
  <div class="g pay"><div>
    <p>${h(zahlungstext)}</p>
    ${zugferd}
  </div></div>
      </td></tr>
    </tbody>
    <tfoot><tr><td class="raum" colspan="${spalten.length}" style="height:${randUnten}mm"></td></tr></tfoot>
</table>

${fussHtml}
</body>
</html>
`;
}
