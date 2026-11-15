#!/usr/bin/env node
/**
 * Legt die Hausschriften unter einem STABILEN Pfad ab: `public/fonts/`.
 *
 * ===========================================================================
 * WOZU, WENN DIE OBERFLÄCHE DIE SCHRIFTEN DOCH SCHON LÄDT
 * ===========================================================================
 *
 * Sie lädt sie über `@saas-instant/ui/fonts`, und Vite gibt ihnen dabei einen
 * Hash im Dateinamen (`hanken-grotesk-latin-wght-normal-CaVRRdDk.woff2`). Der
 * ändert sich bei jedem Fassungswechsel der Schrift. Für die React-Oberfläche
 * ist das richtig — sie bekommt den Namen aus dem Bündel.
 *
 * Die öffentlichen Seiten aus `consent/pages.ts` bekommen ihn NICHT: Sie
 * werden serverseitig als Zeichenkette gebaut, ohne Bündel und ohne
 * Manifest. Sie brauchen einen Pfad, den man aufschreiben kann.
 *
 * Vite kopiert `public/` unverändert nach `dist-web/`. Damit gibt es die
 * Schriften zweimal im Bündel — einmal gehasht für die Oberfläche, einmal
 * unter festem Namen für die serverseitigen Seiten. Rund 70 kB, und dafür
 * müssen die Seiten keine Verbindung nach draussen aufbauen.
 *
 * NICHT IM REPOSITORY: Der Ordner steht in `.gitignore`. Die Schrift ist eine
 * Abhängigkeit, kein Quelltext; sie zweimal einzuchecken hiesse, sie bei jeder
 * Aktualisierung an zwei Stellen nachzuziehen.
 */
import { copyFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const TARGET = join(dirname(fileURLToPath(import.meta.url)), '..', 'public', 'fonts');

/**
 * Nur die LATEINISCHEN Teilmengen. Die Seiten tragen deutsche Sätze; Kyrillisch
 * und Vietnamesisch wären 60 kB, die niemand zu sehen bekommt.
 */
const FONTS = [
  ['@fontsource-variable/hanken-grotesk', 'hanken-grotesk-latin-wght-normal.woff2'],
  ['@fontsource-variable/source-serif-4', 'source-serif-4-latin-wght-normal.woff2'],
];

mkdirSync(TARGET, { recursive: true });
/**
 * Aufgeloest wird ueber den WORKSPACE-PFAD, nicht ueber `require.resolve`.
 *
 * Die Schriften sind eine Abhaengigkeit des Design-Systems, nicht der
 * Verwaltung — `apps/control` hat sie nicht in seiner package.json, und pnpm
 * legt nur an, was auch deklariert ist. Ein `require.resolve` von hier aus
 * scheitert deshalb, und ueber `@saas-instant/ui` fuehrt er auch nicht: Das Paket
 * exportiert seine package.json nicht.
 *
 * In einem Monorepo mit festen Pfaden ist der direkte Weg der ehrlichere. Er
 * sagt zugleich die Abhaengigkeitskette, wie sie ist: Die Verwaltung haengt an
 * `@saas-instant/ui`, und dort liegen die Schriften.
 */
const UI_FONTS = join(
  dirname(fileURLToPath(import.meta.url)),
  '..', '..', '..', 'packages', 'ui', 'node_modules', '@fontsource-variable',
);

mkdirSync(TARGET, { recursive: true });
for (const [fontPackage, file] of FONTS) {
  const source = join(UI_FONTS, fontPackage.split('/')[1], 'files', file);
  if (!existsSync(source)) {
    // Laut abbrechen statt still eine Seite ohne Hausschrift auszuliefern.
    console.error(
      `Schrift nicht gefunden: ${source}\n` +
        'Wurde `pnpm install` ausgefuehrt? Hat sich die Fassung von ' +
        `${fontPackage} geaendert?`,
    );
    process.exit(1);
  }
  copyFileSync(source, join(TARGET, file));
  console.log(`Schrift kopiert: ${file}`);
}
