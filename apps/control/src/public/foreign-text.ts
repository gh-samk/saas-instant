/**
 * Aufbereitung von FREMDTEXT — also allem, was ein Unbeteiligter über das
 * öffentliche Formular schickt.
 *
 * Hintergrund [K1]: Der Freitext des Absenders ging wörtlich, mitsamt
 * Zeilenumbrüchen, in eine `Notiz{vomSystem:true}` an einer bestehenden
 * Organisation. Die Oberfläche stellt Notizen mit `whitespace-pre-line` dar,
 * also wurde aus einer eingeschickten `nachricht` ein mehrzeiliger Block, der
 * echte Systemzeilen nachbaute — etwa eine erfundene Zeile
 * "Status gewechselt: Zahlend -> Beendet" mitsamt bestätigter Kündigung.
 *
 * Die Betreiberin konnte das weder löschen noch richtigstellen (beides
 * `409 notiz_vom_system`). Nötig war dafür nur die Kontaktadresse aus dem
 * Impressum.
 *
 * Zwei Regeln, die zusammen greifen:
 * 1. Fremdtext steht NIEMALS in einer `vomSystem`-Notiz (siehe
 *    `OeffentlichService.legeAn`).
 * 2. Fremdtext ist EINZEILIG und eingefasst. Damit kann er in keiner
 *    Darstellung eine eigene Zeile beginnen — und ohne eigene Zeile lässt sich
 *    keine Systemzeile nachbauen.
 */

/** Steuerzeichen, Zeilen- und Absatztrenner, unsichtbare Formatzeichen. */
const CONTROL_CHARACTERS = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu;

/** Die Zeichen, mit denen eingefasst wird — im Inhalt haben sie nichts verloren. */
const ENCLOSURE = /[„“]/g;

/** Öffnendes und schließendes Anführungszeichen der Einfassung. */
export const ENCLOSURE_AUF = '„';
export const ENCLOSURE_TO = '“';

/**
 * Macht aus beliebigem Fremdtext eine einzige Zeile ohne Steuerzeichen.
 *
 * Der Text wird NICHT gekürzt: er ist der Grund der Anfrage und die Betreiberin
 * soll ihn lesen können. Genommen wird ihm nur, was Struktur vortäuschen kann.
 */
export function singleLine(text: string): string {
  return text
    .replace(CONTROL_CHARACTERS, ' ')
    .replace(ENCLOSURE, "'")
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Eine Zeile `Feld: "Wert"` — oder nichts, wenn nichts da ist.
 *
 * Die Einfassung ist der sichtbare Teil der Regel: Was zwischen den
 * Anführungszeichen steht, hat jemand von außen geschrieben. Der Feldname
 * davor stammt vom System und enthält keinen Fremdtext.
 */
export function detail(field: string, value: string | undefined): string | null {
  if (value === undefined) return null;
  const clean = singleLine(value);
  if (clean === '') return null;
  return `${field}: ${ENCLOSURE_AUF}${clean}${ENCLOSURE_TO}`;
}
