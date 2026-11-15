import { centAsText } from '../invoice.amount';
import type { InvoiceDocument } from './document.types';

/**
 * DAS SICHTBARE RECHNUNGSDOKUMENT ALS HTML — Entwurf B (Briefkopf), freigegeben
 * in `docs/design-proposals/rechnung-entwurf-b.html`.
 *
 * Briefkopf, Bankblock und Pflichtangaben kommen fertig als Zeilen aus dem
 * Firmenprofil (`issuer.blocks`), Logo und Akzentfarbe aus dem Profil. Das
 * Dokument der Rechnungsdienst-Container (Java) nimmt HTML entgegen; dieses
 * Modul ist die einzige Stelle, die es erzeugt. Zwei Dinge sind für PDF/A
 * entscheidend und stehen deshalb hier:
 *
 * 1. `font-family` nennt die Schrift, die im Container als Datei vorliegt:
 *    Inter, als Variable Font. Fontconfig kennt sie unter dem Familiennamen
 *    „Inter Variable“ (nicht „Inter“); mit „Inter“ griff Chromium auf DejaVu
 *    zurück. Ein Rückfall auf eine Systemschrift kann dazu führen, dass der
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

/** `2026-11-01`/`2026-11-30` → `01.11. – 30.11.2026` (Jahr vorn nur bei Jahreswechsel). */
function periodAsText(from: string, until: string): string {
  const f = dateAsText(from);
  return from.slice(0, 4) === until.slice(0, 4)
    ? `${f.slice(0, 6)} – ${dateAsText(until)}`
    : `${f} – ${dateAsText(until)}`;
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

/** Profil der ausgelieferten XML-Fassung; der ZUGFeRD-Hinweis gilt nur für EN16931. */
export type LayoutProfile = 'EN16931' | 'XRECHNUNG';

const DEFAULT_ACCENT = '#0369A1';

const UNIT_NAMES: Record<string, string> = {
  C62: 'Stück',
  H87: 'Stück',
  MON: 'Monat',
  ANN: 'Jahr',
  DAY: 'Tag',
  HUR: 'Stunde',
  LS: 'pauschal',
  KGM: 'kg',
  MTR: 'm',
};

const lines = (rows: string[]): string => rows.map((l) => h(l)).join('<br>');

export function createHtml(r: InvoiceDocument, profile: LayoutProfile = 'EN16931'): string {
  const a = r.issuer;
  const e = r.recipient;
  const accent = /^#[0-9a-fA-F]{6}$/.test(a.accentColor ?? '')
    ? (a.accentColor as string)
    : DEFAULT_ACCENT;
  const [first = '', ...rest] = a.blocks.companyLines;
  const logo = a.logoDataUri
    ? `<img class="logo" alt="" src="${h(a.logoDataUri).replaceAll('"', '&quot;')}">`
    : `<div class="mark">${h(Array.from(a.name.trim())[0] ?? '')}</div>`;
  const contact = a.blocks.contactLines;
  const companyBlock =
    `<b>${h(first)}</b>` +
    (rest.length > 0 ? `<br>${lines(rest)}` : '') +
    (contact.length > 0 ? `<br><br>${lines(contact)}` : '');
  const recipientLines = [
    e.address.street,
    `${e.address.postalCode} ${e.address.city}`.trim(),
    countryAsText(e.address.country) === 'Deutschland' ? '' : countryAsText(e.address.country),
  ].filter((l) => l !== '');

  const meta: Array<[string, string]> = [
    ['Nummer', h(r.number)],
    ['Datum', dateAsText(r.invoiceDate)],
    ['Zeitraum', periodAsText(r.servicePeriod.from, r.servicePeriod.until)],
    ['Fällig am', dateAsText(r.dueAt)],
  ];
  if (r.buyerReference) meta.push(['Leitweg-ID', h(r.buyerReference)]);

  const linesRows = r.lines
    .map(
      (p) => `
  <div class="tr"><div class="lei"><span class="pos">${h(p.row)}</span><span><b>${h(p.label)}</b></span></div><div class="num"><span>${quantityAsText(p.quantity)}</span><span>${h(
    UNIT_NAMES[p.unit] ?? p.unit,
  )}</span><span>${centAsText(p.unitPriceCent)} €</span><span>${centAsText(p.netCent)} €</span></div></div>`,
    )
    .join('');

  const taxRows = r.taxBreakdown
    .map(
      (t) =>
        `<div class="row"><span>zzgl. ${h(t.record)} % USt</span><span>${centAsText(t.taxCent)} €</span></div>`,
    )
    .join('');

  // Zahlungssatz, gesetzlich nötige Hinweise (§ 19 UStG, Steuerbefreiung,
  // Reverse Charge) und der eigene Zahlungshinweis; ZUGFeRD-Hinweis nur beim
  // Profil EN16931. Kein Einleitungssatz, keine Unterzeile je Leistung.
  const notes = [r.paymentTerm, r.hint, r.paymentNote].filter(
    (t): t is string => (t ?? '') !== '',
  );

  // Fußzeile: Basislinie 4,5 mm, unterste Zeile höchstens bei 279 mm.
  // Beginnt höher, wenn mehr Zeilen anfallen, statt abgeschnitten zu werden.
  // Spaltenbreite 79 mm ≈ 44 Zeichen je Zeile bei 9 pt; lange Zeilen brechen um.
  const rowCount = (rows: string[]): number =>
    rows.reduce((n, l) => n + Math.max(1, Math.ceil(Array.from(l).length / 44)), 0);
  const footerRows = Math.max(rowCount(a.blocks.bankLines), rowCount(a.blocks.legalLines), 1);
  const footerTop = Math.min(247.5, 279 - footerRows * 4.5);

  return `<!DOCTYPE html>
<html lang="de">
<head>
<meta charset="utf-8">
<title>Rechnung ${h(r.number)}</title>
<style>
@page{size:A4;margin:0}
:root{--ink:#16191d;--mut:#6b7480;--hair:#cfd3d9;--acc:${accent};--m:20mm;--n:9pt;--s:9pt;--u:4.5mm}
*{box-sizing:border-box;margin:0;padding:0}
html{-webkit-print-color-adjust:exact;print-color-adjust:exact}
body{font-family:"Inter Variable";color:var(--ink);font-size:var(--n);line-height:var(--u);font-feature-settings:"tnum"}
.page{position:relative;width:210mm;height:297mm;background:#fff;overflow:hidden}
.g{display:grid;grid-template-columns:repeat(6,minmax(0,1fr));column-gap:4mm}
.abs{position:absolute;left:var(--m);right:var(--m)}
.s{font-size:var(--s);color:var(--mut)}
b{font-weight:600}
.mark{position:absolute;left:var(--m);top:13.5mm;width:9mm;height:9mm;background:var(--acc);color:#fff;display:grid;place-items:center;font-weight:600;line-height:1}
.logo{position:absolute;left:var(--m);top:13.5mm;max-width:60mm;max-height:20mm;object-fit:contain}
.co{top:13.5mm;font-size:var(--s);color:var(--mut)}
.co>div{grid-column:4 / span 3}
.co b{color:var(--ink)}
.window{top:49.5mm;width:85mm;height:40.5mm}
.meta{top:49.5mm}
.meta>div{grid-column:4 / span 3;display:grid;grid-template-columns:29mm 1fr}
.meta .l{font-size:var(--s);color:var(--mut)}
h1{position:absolute;left:var(--m);top:94.5mm;font-size:var(--n);font-weight:600;color:var(--acc)}
.body{position:absolute;top:103.5mm;left:var(--m);right:var(--m)}
.tr{display:grid;grid-template-columns:repeat(6,minmax(0,1fr));column-gap:4mm;padding:2.25mm 0;border-bottom:.2mm solid var(--hair)}
.tr.h{padding:0 0 2.25mm;border-bottom:.2mm solid var(--ink);font-size:var(--s);color:var(--mut)}
.tr .lei{grid-column:1 / span 3;display:grid;grid-template-columns:8mm 1fr}
.tr .num{grid-column:4 / span 3;display:grid;grid-template-columns:14mm 21mm 1fr 1fr}
.tr .num span:nth-child(n+3){text-align:right}
.pos{color:var(--mut)}
.sum{margin-top:4.5mm}.sum>div{grid-column:4 / span 3}
.sum .row{display:flex;justify-content:space-between}
.sum .tot{border-top:.2mm solid var(--ink);margin-top:2.25mm;padding-top:2.25mm;font-weight:600}
.pay{margin-top:9mm}.pay>div{grid-column:4 / span 3}.pay p+p{margin-top:var(--u)}
.ft{top:247.5mm;font-size:var(--s);color:var(--mut)}
.ft .bank{grid-column:1 / span 3}.ft .legal{grid-column:4 / span 3}
.fold{position:absolute;left:0;width:5mm;height:.2mm;background:#8a919b}
</style>
</head>
<body>
<div class="page">
 <div class="fold" style="top:105mm"></div><div class="fold" style="top:148.5mm;width:7mm"></div><div class="fold" style="top:210mm"></div>
 ${logo}
 <div class="abs g co"><div>${companyBlock}</div></div>
 <div class="abs window"><b>${h(e.name)}</b><br>${lines(recipientLines)}</div>
 <div class="abs g meta"><div>${meta
   .map(([l, v]) => `<span class="l">${l}</span><span>${v}</span>`)
   .join('')}</div></div>
 <h1>${r.cancellationNote ? h(r.cancellationNote) : 'Rechnung'}</h1>
 <div class="body">
  <div class="tr h"><div class="lei"><span>Pos.</span><span>Leistung</span></div><div class="num"><span>Menge</span><span>Einheit</span><span>Einzelpreis</span><span>Netto</span></div></div>${linesRows}
  <div class="g sum"><div>
   <div class="row"><span>Summe netto</span><span>${centAsText(r.sumNetCent)} €</span></div>
   ${taxRows}
   <div class="row tot"><span>Rechnungsbetrag</span><span>${centAsText(r.paymentAmountCent)} €</span></div>
  </div></div>
  <div class="g pay"><div>
   ${notes.map((t) => `<p>${h(t)}</p>`).join('\n   ')}
   ${profile === 'EN16931' ? '<p class="note s">Diese Rechnung enthält eine maschinenlesbare Fassung nach ZUGFeRD (EN 16931).</p>' : ''}
  </div></div>
 </div>
 <div class="abs g ft" style="top:${footerTop}mm">
  <div class="bank">${lines(a.blocks.bankLines)}</div>
  <div class="legal">${lines(a.blocks.legalLines)}</div>
 </div>
</div>
</body>
</html>
`;
}
