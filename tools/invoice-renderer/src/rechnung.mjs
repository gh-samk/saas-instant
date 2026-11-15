// Datenmodell und Rechenwerk einer Rechnung.
//
// Bewusst ohne Fremdbibliotheken und ohne Bezug auf apps/ oder packages/:
// dieses Verzeichnis ist ein isolierter Erkundungsschritt. Das spaetere
// Rechnungsmodul uebernimmt die Struktur, nicht zwingend die Datei.
//
// Betraege werden durchgaengig in ganzen Cent gefuehrt. Fliesskomma wird nur
// zur Ausgabe verwendet. Grund: 490,00 EUR * 19 % ergibt in Fliesskomma
// 93.09999999999999 — bei mehreren Posten summieren sich solche Reste zu
// Abweichungen, die jeder ZUGFeRD-Validator als Rechenfehler meldet.

/** Rundet kaufmaennisch auf ganze Cent (halbe Cent aufwaerts). */
export function rundeCent(zahl) {
  if (!Number.isFinite(zahl)) {
    throw new TypeError(`rundeCent erwartet eine endliche Zahl, erhielt: ${zahl}`);
  }
  return Math.round(zahl + (zahl >= 0 ? 1e-9 : -1e-9));
}

/** Formatiert Cent als Dezimalzahl mit Punkt, wie sie in XML gehoert. */
export function centAlsXml(cent) {
  if (!Number.isInteger(cent)) {
    throw new TypeError(`centAlsXml erwartet ganze Cent, erhielt: ${cent}`);
  }
  const vorzeichen = cent < 0 ? '-' : '';
  const betrag = Math.abs(cent);
  return `${vorzeichen}${Math.floor(betrag / 100)}.${String(betrag % 100).padStart(2, '0')}`;
}

/** Formatiert Cent deutsch fuer das sichtbare Dokument: 1.041,25 */
export function centAlsText(cent) {
  if (!Number.isInteger(cent)) {
    throw new TypeError(`centAlsText erwartet ganze Cent, erhielt: ${cent}`);
  }
  return (cent / 100).toLocaleString('de-DE', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}

/** '2026-08-31' -> '20260831' (CII-Format 102). */
export function datumAlsCii(iso) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(iso)) {
    throw new TypeError(`Datum muss JJJJ-MM-TT sein, erhielt: ${iso}`);
  }
  return iso.replaceAll('-', '');
}

/** '2026-08-31' -> '31.08.2026' */
export function datumAlsText(iso) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(iso)) {
    throw new TypeError(`Datum muss JJJJ-MM-TT sein, erhielt: ${iso}`);
  }
  const [jahr, monat, tag] = iso.split('-');
  return `${tag}.${monat}.${jahr}`;
}

/**
 * Prueft die Pflichtangaben und ergaenzt alle abgeleiteten Betraege.
 * Wirft bei fehlenden Angaben, statt eine unvollstaendige Rechnung zu erzeugen:
 * eine Rechnung ohne USt-IdNr. faellt sonst erst beim Finanzamt auf.
 */
export function berechneRechnung(eingabe) {
  const fehlend = [];
  const verlangt = (pfad, wert) => {
    if (wert === undefined || wert === null || String(wert).trim() === '') fehlend.push(pfad);
  };

  verlangt('nummer', eingabe.nummer);
  verlangt('rechnungsdatum', eingabe.rechnungsdatum);
  verlangt('faelligAm', eingabe.faelligAm);
  verlangt('aussteller.name', eingabe.aussteller?.name);
  verlangt('aussteller.ustIdNr', eingabe.aussteller?.ustIdNr);
  verlangt('aussteller.anschrift.ort', eingabe.aussteller?.anschrift?.ort);
  verlangt('aussteller.anschrift.land', eingabe.aussteller?.anschrift?.land);
  verlangt('aussteller.bank.iban', eingabe.aussteller?.bank?.iban);
  verlangt('empfaenger.name', eingabe.empfaenger?.name);
  verlangt('empfaenger.anschrift.ort', eingabe.empfaenger?.anschrift?.ort);
  verlangt('empfaenger.anschrift.land', eingabe.empfaenger?.anschrift?.land);

  if (!Array.isArray(eingabe.posten) || eingabe.posten.length === 0) {
    fehlend.push('posten (mindestens einer)');
  }
  if (fehlend.length > 0) {
    throw new Error(`Rechnung unvollstaendig, fehlende Pflichtangaben: ${fehlend.join(', ')}`);
  }

  const posten = eingabe.posten.map((posten, index) => {
    const nummer = index + 1;
    if (!Number.isInteger(posten.einzelpreisCent)) {
      throw new TypeError(`Posten ${nummer}: einzelpreisCent muss ganze Cent sein.`);
    }
    if (!Number.isFinite(posten.menge) || posten.menge <= 0) {
      throw new TypeError(`Posten ${nummer}: menge muss groesser als 0 sein.`);
    }
    if (!Number.isFinite(posten.steuersatz) || posten.steuersatz < 0) {
      throw new TypeError(`Posten ${nummer}: steuersatz muss 0 oder groesser sein.`);
    }
    return {
      ...posten,
      zeile: String(nummer),
      nettoCent: rundeCent(posten.einzelpreisCent * posten.menge),
    };
  });

  // Steuer wird je Steuersatz gebildet, nicht je Posten. EN 16931 verlangt
  // genau eine Steueraufteilung (BG-23) je Kombination aus Kategorie und Satz;
  // die Summe der Einzelposten-Steuern waere bei Rundung nicht dieselbe Zahl.
  const nachSatz = new Map();
  for (const p of posten) {
    const schluessel = `${p.steuerkategorie ?? 'S'}|${p.steuersatz}`;
    const eintrag = nachSatz.get(schluessel) ?? {
      kategorie: p.steuerkategorie ?? 'S',
      satz: p.steuersatz,
      grundlageCent: 0,
      befreiungsgrund: p.befreiungsgrund,
    };
    eintrag.grundlageCent += p.nettoCent;
    nachSatz.set(schluessel, eintrag);
  }
  const steueraufteilung = [...nachSatz.values()].map((s) => ({
    ...s,
    steuerCent: rundeCent((s.grundlageCent * s.satz) / 100),
  }));

  const summeNettoCent = posten.reduce((s, p) => s + p.nettoCent, 0);
  const summeSteuerCent = steueraufteilung.reduce((s, t) => s + t.steuerCent, 0);
  const vorausgezahltCent = eingabe.vorausgezahltCent ?? 0;
  const summeBruttoCent = summeNettoCent + summeSteuerCent;

  return {
    ...eingabe,
    posten,
    steueraufteilung,
    summeNettoCent,
    summeSteuerCent,
    summeBruttoCent,
    vorausgezahltCent,
    zahlbetragCent: summeBruttoCent - vorausgezahltCent,
  };
}
