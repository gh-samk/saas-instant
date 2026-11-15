import { centAsText } from '../invoice.amount';
import type { InvoiceDocument } from './document.types';

/**
 * DAS SICHTBARE RECHNUNGSDOKUMENT ALS HTML.
 *
 * Übernommen aus `tools/invoice-renderer/src/layout-html.mjs`. Zwei
 * Dinge daraus sind für PDF/A entscheidend und stehen deshalb hier und nicht
 * im Renderer:
 *
 * 1. `font-family` nennt GENAU EINE Schrift, die im Container als Datei
 *    vorliegt. Ein Rückfall auf eine Systemschrift kann dazu führen, dass der
 *    Renderer eine nicht einbettbare Schrift wählt — PDF/A verlangt, dass jede
 *    verwendete Schrift eingebettet ist.
 * 2. KEINE EXTERNEN RESSOURCEN. Kein Bild per URL, keine Webfont-URL. Was beim
 *    Rendern fehlt, fehlt still: Das PDF entstünde trotzdem, nur ohne Logo,
 *    und niemand bekäme eine Fehlermeldung.
 *
 * Der Erkundungsschritt hat gemessen, dass Chromiums Rohausgabe an genau drei
 * Punkten von PDF/A-3b abweicht (Farbzielprofil, XMP-Metadatenstrom,
 * Trailer-Kennung) — und dass Mustangproject beim Einbetten genau diese drei
 * ergänzt. Kein Wort über Schriften. Diese Datei darf das nicht ändern.
 */

/** Maskiert Text für HTML-Inhalte. */
function h(text: string | number): string {
  return String(text)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;');
}

/** `2026-08-31` → `31.08.2026` */
export function dateAsText(iso: string): string {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(iso)) {
    throw new TypeError(`Datum muss JJJJ-MM-TT sein, erhielt: ${iso}`);
  }
  const [year, month, day] = iso.split('-');
  return `${day}.${month}.${year}`;
}

/** Ländername aus dem Code; leer, wenn nichts gesetzt ist. Nichts wird erfunden. */
function countryAsText(code: string): string {
  const value = (code ?? '').trim();
  if (value === '') return '';
  if (/^[A-Za-z]{2}$/.test(value)) {
    try {
      return new Intl.DisplayNames(['de'], { type: 'region' }).of(value.toUpperCase()) ?? value;
    } catch {
      return value;
    }
  }
  return value;
}

/** Menge lesbar: ganze Zahlen ohne Nachkommastellen. */
function quantityAsText(quantity: number): string {
  return Number.isInteger(quantity)
    ? String(quantity)
    : quantity.toLocaleString('de-DE', { minimumFractionDigits: 1, maximumFractionDigits: 3 });
}

export function createHtml(r: InvoiceDocument): string {
  const a = r.issuer;
  const e = r.recipient;
  const k = a.generalPartner;
  const countryName = countryAsText(a.address.country);
  // Nur drucken, was gesetzt ist: ohne Gesellschafterin kein Block, ohne
  // Register oder Geschäftsführung keine leeren Zeilen.
  const partnerLines = [
    k.seat ? `Sitz ${h(k.seat)}` : '',
    `${k.registerCourt} ${k.registerIdentifier}`.trim() ? h(`${k.registerCourt} ${k.registerIdentifier}`.trim()) : '',
    k.managingDirector.length > 0 ? `Geschäftsführer: ${h(k.managingDirector.join(', '))}` : '',
  ].filter((line) => line !== '');
  const partnerBlock = k.name.trim() === ''
    ? ''
    : `<div>
    <b>Persönlich haftende Gesellschafterin</b><br>
    ${h(k.name)}${partnerLines.length > 0 ? `<br>\n    ${partnerLines.join('<br>\n    ')}` : ''}
  </div>`;

  const linesRows = r.lines
    .map(
      (p) => `
      <tr>
        <td class="mitte">${h(p.row)}</td>
        <td>
          <span class="bezeichnung">${h(p.label)}</span>
          ${p.description ? `<span class="beschreibung">${h(p.description)}</span>` : ''}
          ${p.period ? `<span class="beschreibung">${dateAsText(p.period.from)} – ${dateAsText(p.period.until)}</span>` : ''}
        </td>
        <td class="rechts">${quantityAsText(p.quantity)}</td>
        <td class="rechts">${centAsText(p.unitPriceCent)}</td>
        <td class="mitte">${h(p.taxRate)} %</td>
        <td class="rechts">${centAsText(p.netCent)}</td>
      </tr>`,
    )
    .join('');

  const taxRows = r.taxBreakdown
    .map(
      (t) => `
      <tr>
        <th>zzgl. ${h(t.record)} % USt. auf ${centAsText(t.basisCent)} €</th>
        <td class="rechts">${centAsText(t.taxCent)} €</td>
      </tr>`,
    )
    .join('');

  return `<!DOCTYPE html>
<html lang="de">
<head>
<meta charset="utf-8">
<title>Rechnung ${h(r.number)}</title>
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
  table.lines { width: 100%; border-collapse: collapse; margin-top: 2mm; }
  table.lines th { text-align: left; font-size: 7.5pt; text-transform: uppercase;
                    letter-spacing: 0.05em; color: #555; border-bottom: 0.8pt solid #333;
                    padding: 0 2mm 1.5mm 0; }
  table.lines td { padding: 2.5mm 2mm 2.5mm 0; border-bottom: 0.4pt solid #ddd;
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
  .einleitung { margin: 5mm 0 0; font-size: 9.5pt; }
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
    ${h(a.address.street)}<br>
    ${h(a.address.postalCode)} ${h(a.address.city)}<br>
    ${h(a.contact.phone)}<br>
    ${h(a.contact.email)}
  </div>
</header>

<div class="absenderzeile">${h(a.name)} · ${h(a.address.street)} · ${h(a.address.postalCode)} ${h(a.address.city)}</div>
<div class="empfaenger">
  <span class="name">${h(e.name)}</span><br>
  ${h(e.address.street)}<br>
  ${h(e.address.postalCode)} ${h(e.address.city)}
</div>

<h1>Rechnung ${h(r.number)}</h1>

<div class="eckdaten">
  <div><span>Rechnungsdatum</span>${dateAsText(r.invoiceDate)}</div>
  <div><span>Leistungszeitraum</span>${dateAsText(r.servicePeriod.from)} – ${dateAsText(r.servicePeriod.until)}</div>
  <div><span>Fällig am</span>${dateAsText(r.dueAt)}</div>
  <div><span>Ihr Zeichen</span>${h(r.orderReference)}</div>
</div>

${r.cancellationNote ? `<p class="hinweis"><b>${h(r.cancellationNote)}</b></p>` : ''}
${r.introduction ? `<p class="einleitung">${h(r.introduction)}</p>` : ''}

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
  <tbody>${linesRows}
  </tbody>
</table>

<table class="summe">
  <tr><th>Summe netto</th><td class="rechts">${centAsText(r.sumNetCent)} €</td></tr>
  ${taxRows}
  <tr class="gesamt"><th>Rechnungsbetrag</th><td class="rechts">${centAsText(r.paymentAmountCent)} €</td></tr>
</table>

<div class="zahlung">
  <h2>Zahlung</h2>
  <dl>
    <dt>Verwendungszweck</dt><dd>Rechnung ${h(r.number)}</dd>
    <dt>Kontoinhaberin</dt><dd>${h(a.name)}</dd>
    <dt>IBAN</dt><dd>${h(a.bank.iban.replace(/(.{4})/g, '$1 ').trim())}</dd>
    <dt>BIC</dt><dd>${h(a.bank.bic)} (${h(a.bank.institution)})</dd>
  </dl>
  <p class="hinweis">${h(r.paymentTerm)} ${h(r.hint)}</p>
  ${r.paymentNote ? `<p class="hinweis">${h(r.paymentNote)}</p>` : ''}
  <p class="hinweis">Dieser Rechnung ist eine maschinenlesbare Fassung nach ZUGFeRD (Profil EN 16931) als Anlage <b>factur-x.xml</b> beigefügt.</p>
</div>

<footer>
  <div>
    <b>${h(a.name)}</b><br>
    ${h(a.address.street)}<br>
    ${h(a.address.postalCode)} ${h(a.address.city)}${countryName ? `, ${h(countryName)}` : ''}<br>
    ${a.seat ? `Sitz ${h(a.seat)}<br>` : ''}${h(a.registerCourt)} ${h(a.registerIdentifier)}
  </div>
  ${partnerBlock}
  <div>
    <b>Bank &amp; Steuer</b><br>
    ${h(a.bank.institution)}<br>
    IBAN ${h(a.bank.iban)}<br>
    BIC ${h(a.bank.bic)}<br>
    USt-IdNr. ${h(a.vatId)}
  </div>
</footer>

</body>
</html>
`;
}
