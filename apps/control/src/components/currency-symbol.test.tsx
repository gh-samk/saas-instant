import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const SRC = join(__dirname, '..');

/**
 * ===========================================================================
 * KEIN DOLLARZEICHEN IN DER OBERFLÄCHE
 * ===========================================================================
 *
 * Die Verwaltung rechnet in Euro, und zwar ausschließlich. Ein `$` im
 * Rechnungssymbol ist deshalb kein Geschmacksthema: Es steht an der Stelle,
 * an der jemand die Währung ablesen würde.
 *
 * WARUM DAS EIN TEST IST UND KEINE NOTIZ. Lucide führt zu fast jedem
 * Geldsymbol eine Dollar-Fassung als schlichtesten Namen — `Receipt`,
 * `Banknote`, `BadgeDollarSign`. Wer das nächste Mal ein Rechnungssymbol
 * sucht, greift nach dem kürzesten Namen und hat das `$` wieder drin, ohne es
 * zu bemerken: Bei 16 px ist der Unterschied zwischen `$` und `€` nur ein
 * Strich.
 *
 * DIE LISTE NENNT NUR SYMBOLE, DIE TATSÄCHLICH EIN `$` ZEICHNEN. `Wallet`,
 * `Landmark` und `ReceiptText` tragen keines und bleiben erlaubt — ein Verbot
 * dem Namen nach („alles, was nach Geld klingt") würde brauchbare Symbole
 * mitnehmen und wäre nach dem dritten Fehlalarm abgeschaltet.
 *
 * `Receipt` ist der Fall, der ihn ausgelöst hat: Der Name klingt neutral, das
 * Symbol zeichnet aber `M12 17V7` plus die S-Kurve — ein Dollarzeichen.
 */
const WITH_DOLLAR_SIGN = [
  'Receipt',
  'DollarSign',
  'CircleDollarSign',
  'BadgeDollarSign',
  'SquareDollarSign',
  'HandCoins',
  'PiggyBank',
  'BanknoteArrowUp',
  'BanknoteArrowDown',
];

function allSourceFiles(directory: string): string[] {
  return readdirSync(directory).flatMap((entry) => {
    const path = join(directory, entry);
    if (statSync(path).isDirectory()) return allSourceFiles(path);
    return /\.tsx?$/.test(entry) && !/\.(spec|test)\.tsx?$/.test(entry)
      ? [path]
      : [];
  });
}

/** Was eine Datei aus `lucide-react` holt. */
function lucideEinfuhren(content: string): string[] {
  const match = content.matchAll(
    /import\s*\{([^}]*)\}\s*from\s*'lucide-react'/g,
  );
  return [...match].flatMap((m) =>
    (m[1] ?? '')
      .split(',')
      .map((name) => name.trim().replace(/^type\s+/, ''))
      .filter((name) => name !== ''),
  );
}

describe('Geldsymbole zeigen ein €, nie ein $', () => {
  const files = allSourceFiles(SRC);

  it('findet überhaupt Quelldateien (sonst prüft der Test nichts)', () => {
    expect(files.length).toBeGreaterThan(30);
  });

  it('führt nirgends ein Symbol mit Dollarzeichen ein', () => {
    const violations = files.flatMap((path) => {
      const introduced = lucideEinfuhren(readFileSync(path, 'utf8'));
      return introduced
        .filter((name) => WITH_DOLLAR_SIGN.includes(name))
        .map((name) => `${path.slice(SRC.length + 1)}: ${name}`);
    });
    expect(violations).toEqual([]);
  });

  it('benutzt für Rechnungen ReceiptEuro (Gegenprobe zum Verbot oben)', () => {
    // Ohne das hier wäre der Test auch dann grün, wenn gar kein
    // Rechnungssymbol mehr da ist — „nichts verboten gefunden" ist keine
    // Aussage darüber, dass das Richtige benutzt wird.
    const withEuro = files.filter((path) =>
      lucideEinfuhren(readFileSync(path, 'utf8')).includes('ReceiptEuro'),
    );
    expect(withEuro.length).toBeGreaterThanOrEqual(3);
  });
});
