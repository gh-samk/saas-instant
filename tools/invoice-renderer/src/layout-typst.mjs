// Zweiter Renderkandidat: dasselbe Dokument als Typst-Quelle.
//
// Bewusst schlichter gehalten als die HTML-Fassung. Zweck ist der Vergleich
// der PDF-Erzeugung, nicht ein zweites gepflegtes Layout: wenn Typst gewinnt,
// wird daraus ein vollwertiges Muster, wenn nicht, faellt die Datei weg.

import { centAlsText, datumAlsText } from './rechnung.mjs';

/**
 * Maskiert Text fuer den Auszeichnungsteil von Typst.
 *
 * Wichtig ist vor allem das @: eine E-Mail-Adresse wie buchhaltung@example.com
 * liest Typst als Verweis auf eine Sprungmarke und bricht mit
 * "label does not exist in the document" ab. Dasselbe gilt fuer #, *, _, $
 * und die spitzen Klammern.
 */
function t(text) {
  return String(text).replace(/[\\@#*_$<>`"]/g, (zeichen) => `\\${zeichen}`);
}

export function erzeugeTypst(r) {
  const a = r.aussteller;
  const e = r.empfaenger;
  const k = a.komplementaerin;
  const landText = a.anschrift.land === 'DE' ? 'Deutschland' : (a.anschrift.land ?? '');
  const komplementaerinSpalte = k?.name
    ? `[*Persönlich haftende Gesellschafterin* \\ ${t(k.name)} \\ ${t(`${k.registergericht ?? ''} ${k.registerKennung ?? ''}`.trim())}${
        k.geschaeftsfuehrer?.length ? ` \\ Geschäftsführer: ${t(k.geschaeftsfuehrer.join(', '))}` : ''
      }],`
    : '';

  const zeilen = r.posten
    .map(
      (p) =>
        `  [${t(p.zeile)}], [*${t(p.bezeichnung)}* \\ #text(size: 8pt, fill: rgb("#555555"))[${t(p.beschreibung ?? '')}]], ` +
        `[#h(1fr)${t(String(p.menge))}], [#h(1fr)${t(centAlsText(p.einzelpreisCent))}], ` +
        `[#h(1fr)${t(String(p.steuersatz))} %], [#h(1fr)${t(centAlsText(p.nettoCent))}],`,
    )
    .join('\n');

  const steuern = r.steueraufteilung
    .map(
      (s) =>
        `  [zzgl. ${t(String(s.satz))} % USt. auf ${t(centAlsText(s.grundlageCent))} EUR], [#h(1fr)${t(centAlsText(s.steuerCent))} EUR],`,
    )
    .join('\n');

  return `#set page(paper: "a4", margin: (top: 20mm, bottom: 16mm, x: 18mm))
#set text(font: "DejaVu Sans", size: 9.5pt, lang: "de")
#let grau = rgb("#555555")

#grid(columns: (1fr, auto),
  [#text(size: 15pt, weight: "bold")[${t(a.name)}] \\ #text(size: 8pt, fill: grau)[Rechnung]],
  align(right)[#text(size: 8pt, fill: grau)[${t(a.anschrift.strasse)} \\ ${t(a.anschrift.plz)} ${t(a.anschrift.ort)} \\ ${t(a.kontakt.telefon)} \\ ${t(a.kontakt.email)}]],
)

#v(16mm)
#text(size: 7pt, fill: grau)[${t(a.name)} · ${t(a.anschrift.strasse)} · ${t(a.anschrift.plz)} ${t(a.anschrift.ort)}]
#line(length: 100%, stroke: 0.4pt + rgb("#bbbbbb"))
#v(2mm)
*${t(e.name)}* \\
z. Hd. ${t(e.ansprechpartner)} \\
${t(e.anschrift.strasse)} \\
${t(e.anschrift.plz)} ${t(e.anschrift.ort)}

#v(14mm)
#text(size: 13pt, weight: "bold")[Rechnung ${t(r.nummer)}]
#v(1mm)
#text(size: 8.5pt, fill: grau)[
  Rechnungsdatum ${t(datumAlsText(r.rechnungsdatum))} · Leistungszeitraum ${t(datumAlsText(r.leistungszeitraum.von))} – ${t(datumAlsText(r.leistungszeitraum.bis))} · Fällig am ${t(datumAlsText(r.faelligAm))} · Ihr Zeichen ${t(r.bestellzeichen)}
]

#v(4mm)
#table(
  columns: (8mm, 1fr, 16mm, 24mm, 14mm, 24mm),
  stroke: (x, y) => (bottom: if y == 0 { 0.8pt } else { 0.4pt + rgb("#dddddd") }),
  inset: (x: 2pt, y: 6pt),
  table.header(
    [#text(size: 7.5pt, fill: grau)[Pos.]], [#text(size: 7.5pt, fill: grau)[Leistung]],
    [#h(1fr)#text(size: 7.5pt, fill: grau)[Menge]], [#h(1fr)#text(size: 7.5pt, fill: grau)[Einzelpreis]],
    [#h(1fr)#text(size: 7.5pt, fill: grau)[USt.]], [#h(1fr)#text(size: 7.5pt, fill: grau)[Netto EUR]],
  ),
${zeilen}
)

#v(4mm)
#align(right)[#table(
  columns: (auto, 28mm), stroke: none, inset: (x: 4pt, y: 3pt),
  [Summe netto], [#h(1fr)${t(centAlsText(r.summeNettoCent))} EUR],
${steuern}
  table.hline(stroke: 0.8pt),
  [*Rechnungsbetrag*], [#h(1fr)*${t(centAlsText(r.zahlbetragCent))} EUR*],
)]

#v(8mm)
*Zahlung* \\
Verwendungszweck Rechnung ${t(r.nummer)} \\
Kontoinhaberin ${t(a.name)} \\
IBAN ${t(a.bank.iban)} · BIC ${t(a.bank.bic)} (${t(a.bank.institut)})

#v(3mm)
#text(size: 8.5pt)[${t(r.zahlungsbedingung)} ${t(r.hinweis)}]
#v(2mm)
#text(size: 8.5pt)[Dieser Rechnung ist eine maschinenlesbare Fassung nach ZUGFeRD (Profil EN 16931) als Anlage #raw("factur-x.xml") beigefügt.]

#place(bottom + left, dx: 0pt, dy: 0pt)[
  #line(length: 100%, stroke: 0.4pt + rgb("#bbbbbb"))
  #v(1mm)
  #text(size: 6.8pt, fill: grau)[
    #grid(columns: (${k?.name ? '1fr, 1fr, 1fr' : '1fr, 1fr'}), gutter: 4mm,
      [*${t(a.name)}* \\ ${t(a.anschrift.strasse)} \\ ${t(a.anschrift.plz)} ${t(a.anschrift.ort)}${landText ? `, ${t(landText)}` : ''} \\ ${t(a.registergericht)} ${t(a.registerKennung)}],
      ${komplementaerinSpalte}
      [*Bank & Steuer* \\ ${t(a.bank.institut)} \\ IBAN ${t(a.bank.iban)} \\ BIC ${t(a.bank.bic)} \\ USt-IdNr. ${t(a.ustIdNr)}],
    )
  ]
]
`;
}
