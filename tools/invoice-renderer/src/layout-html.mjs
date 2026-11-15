// Das sichtbare Rechnungsdokument als HTML.
//
// Warum HTML und nicht ein PDF-Baukasten in JavaScript: das spaetere
// Rechnungsmodul lebt in einem TypeScript-Stack. HTML ist die einzige
// Layoutsprache, die hier ohnehin jeder beherrscht. Der Weg nach PDF laeuft
// ueber einen Renderer im Container (siehe README.md).
//
// Zwei Dinge sind fuer PDF/A entscheidend und stehen deshalb hier, nicht im
// Renderer:
//   1. font-family nennt genau EINE Schrift, die im Container als Datei
//      vorliegt. Ein Fallback auf eine Systemschrift kann dazu fuehren, dass
//      der Renderer eine nicht einbettbare Schrift waehlt — PDF/A verlangt,
//      dass jede verwendete Schrift eingebettet ist.
//   2. Keine externen Ressourcen (kein Bild per URL, keine Webfont-URL). Was
//      beim Rendern fehlt, fehlt still.

import { centAlsText, datumAlsText } from './rechnung.mjs';

function h(text) {
  return String(text)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;');
}

export function erzeugeHtml(r) {
  const a = r.aussteller;
  const e = r.empfaenger;
  const k = a.komplementaerin;
  // Optional: ohne Komplementaerin (z. B. keine GmbH & Co KG) kein Block.
  const komplementaerinBlock = k?.name
    ? `<div>
    <b>Persönlich haftende Gesellschafterin</b><br>
    ${h(k.name)}<br>
    ${h(`${k.registergericht ?? ''} ${k.registerKennung ?? ''}`.trim())}${
      k.geschaeftsfuehrer?.length ? `<br>\n    Geschäftsführer: ${h(k.geschaeftsfuehrer.join(', '))}` : ''
    }
  </div>`
    : '';
  // Land nur, wenn gesetzt; DE wird als "Deutschland" ausgeschrieben.
  const landText = a.anschrift.land === 'DE' ? 'Deutschland' : (a.anschrift.land ?? '');

  const postenZeilen = r.posten
    .map(
      (p) => `
      <tr>
        <td class="mitte">${h(p.zeile)}</td>
        <td>
          <span class="bezeichnung">${h(p.bezeichnung)}</span>
          ${p.beschreibung ? `<span class="beschreibung">${h(p.beschreibung)}</span>` : ''}
        </td>
        <td class="rechts">${h(p.menge)}</td>
        <td class="rechts">${centAlsText(p.einzelpreisCent)}</td>
        <td class="mitte">${h(p.steuersatz)} %</td>
        <td class="rechts">${centAlsText(p.nettoCent)}</td>
      </tr>`,
    )
    .join('');

  const steuerZeilen = r.steueraufteilung
    .map(
      (t) => `
      <tr>
        <th>zzgl. ${h(t.satz)} % USt. auf ${centAlsText(t.grundlageCent)} €</th>
        <td class="rechts">${centAlsText(t.steuerCent)} €</td>
      </tr>`,
    )
    .join('');

  return `<!DOCTYPE html>
<html lang="de">
<head>
<meta charset="utf-8">
<title>Rechnung ${h(r.nummer)}</title>
<style>
  @page { size: A4; margin: 16mm 18mm 12mm 18mm; }
  * { box-sizing: border-box; }
  html { -webkit-print-color-adjust: exact; print-color-adjust: exact; }
  body {
    font-family: "DejaVu Sans";
    font-size: 9.5pt;
    line-height: 1.45;
    color: #1a1a1a;
    margin: 0;
  }
  header { display: flex; justify-content: space-between; align-items: flex-start; }
  .marke { font-size: 15pt; font-weight: bold; letter-spacing: 0.02em; }
  .marke small { display: block; font-size: 8pt; font-weight: normal; color: #555; letter-spacing: 0; }
  .absenderblock { text-align: right; font-size: 8pt; color: #555; line-height: 1.5; }
  .absenderzeile { margin-top: 13mm; font-size: 7pt; color: #666;
                   border-bottom: 0.4pt solid #bbb; padding-bottom: 1mm; }
  .empfaenger { margin-top: 2mm; line-height: 1.5; }
  .empfaenger .name { font-weight: bold; }
  h1 { font-size: 13pt; margin: 10mm 0 1mm 0; }
  .eckdaten { display: flex; gap: 8mm; font-size: 8.5pt; color: #444; margin-bottom: 6mm; }
  .eckdaten div span { display: block; color: #777; font-size: 7.5pt; text-transform: uppercase;
                       letter-spacing: 0.05em; }
  table.posten { width: 100%; border-collapse: collapse; margin-top: 2mm; }
  table.posten th { text-align: left; font-size: 7.5pt; text-transform: uppercase;
                    letter-spacing: 0.05em; color: #555; border-bottom: 0.8pt solid #333;
                    padding: 0 2mm 1.5mm 0; }
  table.posten td { padding: 2.5mm 2mm 2.5mm 0; border-bottom: 0.4pt solid #ddd;
                    vertical-align: top; }
  .bezeichnung { display: block; font-weight: bold; }
  .beschreibung { display: block; color: #555; font-size: 8.5pt; }
  .rechts { text-align: right; white-space: nowrap; }
  .mitte { text-align: center; white-space: nowrap; }
  table.summe { margin-left: auto; margin-top: 4mm; border-collapse: collapse; min-width: 78mm; }
  table.summe th { text-align: left; font-weight: normal; padding: 1mm 6mm 1mm 0; }
  table.summe td { padding: 1mm 0; }
  table.summe tr.gesamt th, table.summe tr.gesamt td {
    font-weight: bold; font-size: 11pt; border-top: 0.8pt solid #333; padding-top: 2mm;
  }
  .zahlung { margin-top: 7mm; }
  .zahlung h2 { font-size: 9.5pt; margin: 0 0 1mm 0; }
  .zahlung dl { display: grid; grid-template-columns: 34mm 1fr; gap: 0.6mm 3mm; margin: 0; }
  .zahlung dt { color: #666; }
  .zahlung dd { margin: 0; }
  .hinweis { margin-top: 6mm; font-size: 8.5pt; color: #444; }
  footer { margin-top: 8mm; border-top: 0.4pt solid #bbb; padding-top: 2mm;
           font-size: 6.8pt; line-height: 1.5; color: #555;
           display: grid; grid-template-columns: repeat(3, 1fr); gap: 4mm; }
  footer b { font-weight: bold; color: #333; }
</style>
</head>
<body>

<header>
  <div class="marke">${h(a.name)}<small>Rechnung</small></div>
  <div class="absenderblock">
    ${h(a.anschrift.strasse)}<br>
    ${h(a.anschrift.plz)} ${h(a.anschrift.ort)}<br>
    ${h(a.kontakt.telefon)}<br>
    ${h(a.kontakt.email)}
  </div>
</header>

<div class="absenderzeile">${h(a.name)} · ${h(a.anschrift.strasse)} · ${h(a.anschrift.plz)} ${h(a.anschrift.ort)}</div>
<div class="empfaenger">
  <span class="name">${h(e.name)}</span><br>
  ${e.ansprechpartner ? `z. Hd. ${h(e.ansprechpartner)}<br>` : ''}
  ${h(e.anschrift.strasse)}<br>
  ${h(e.anschrift.plz)} ${h(e.anschrift.ort)}
</div>

<h1>Rechnung ${h(r.nummer)}</h1>

<div class="eckdaten">
  <div><span>Rechnungsdatum</span>${datumAlsText(r.rechnungsdatum)}</div>
  <div><span>Leistungszeitraum</span>${datumAlsText(r.leistungszeitraum.von)} – ${datumAlsText(r.leistungszeitraum.bis)}</div>
  <div><span>Fällig am</span>${datumAlsText(r.faelligAm)}</div>
  <div><span>Ihr Zeichen</span>${h(r.bestellzeichen)}</div>
</div>

<table class="posten">
  <thead>
    <tr>
      <th class="mitte">Pos.</th>
      <th>Leistung</th>
      <th class="rechts">Menge</th>
      <th class="rechts">Einzelpreis €</th>
      <th class="mitte">USt.</th>
      <th class="rechts">Netto €</th>
    </tr>
  </thead>
  <tbody>${postenZeilen}
  </tbody>
</table>

<table class="summe">
  <tr><th>Summe netto</th><td class="rechts">${centAlsText(r.summeNettoCent)} €</td></tr>
  ${steuerZeilen}
  <tr class="gesamt"><th>Rechnungsbetrag</th><td class="rechts">${centAlsText(r.zahlbetragCent)} €</td></tr>
</table>

<div class="zahlung">
  <h2>Zahlung</h2>
  <dl>
    <dt>Verwendungszweck</dt><dd>Rechnung ${h(r.nummer)}</dd>
    <dt>Kontoinhaberin</dt><dd>${h(a.name)}</dd>
    <dt>IBAN</dt><dd>${h(a.bank.iban.replace(/(.{4})/g, '$1 ').trim())}</dd>
    <dt>BIC</dt><dd>${h(a.bank.bic)} (${h(a.bank.institut)})</dd>
  </dl>
  <p class="hinweis">${h(r.zahlungsbedingung)} ${h(r.hinweis)}</p>
  <p class="hinweis">Dieser Rechnung ist eine maschinenlesbare Fassung nach ZUGFeRD (Profil EN 16931) als Anlage <b>factur-x.xml</b> beigefügt.</p>
</div>

<footer>
  <div>
    <b>${h(a.name)}</b><br>
    ${h(a.anschrift.strasse)}<br>
    ${h(a.anschrift.plz)} ${h(a.anschrift.ort)}${landText ? `, ${h(landText)}` : ''}<br>
    ${h(a.registergericht)} ${h(a.registerKennung)}
  </div>
  ${komplementaerinBlock}
  <div>
    <b>Bank &amp; Steuer</b><br>
    ${h(a.bank.institut)}<br>
    IBAN ${h(a.bank.iban)}<br>
    BIC ${h(a.bank.bic)}<br>
    USt-IdNr. ${h(a.ustIdNr)}
  </div>
</footer>

</body>
</html>
`;
}
