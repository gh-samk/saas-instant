#!/usr/bin/env node
// Schreibt aus einer Rechnung die drei Ausgangsdateien:
//   rechnung.html   sichtbares Dokument, Vorstufe des PDF
//   factur-x.xml    ZUGFeRD/Factur-X CII, Profil EN 16931 (wird ins PDF eingebettet)
//   xrechnung.xml   XRechnung 3.0 als UBL (separater Download)
//
// Aufruf:  node src/erzeuge.mjs [Zielverzeichnis]

import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { beispielrechnung } from '../daten/beispielrechnung.mjs';
import { berechneRechnung } from './rechnung.mjs';
import { erzeugeCii } from './cii-en16931.mjs';
import { erzeugeUbl } from './ubl-xrechnung.mjs';
import { erzeugeHtml } from './layout-html.mjs';

const hier = dirname(fileURLToPath(import.meta.url));
const ziel = resolve(process.argv[2] ?? resolve(hier, '..', 'ergebnis'));

const rechnung = berechneRechnung(beispielrechnung);

await mkdir(ziel, { recursive: true });
await writeFile(resolve(ziel, 'rechnung.html'), erzeugeHtml(rechnung), 'utf8');
await writeFile(resolve(ziel, 'factur-x.xml'), erzeugeCii(rechnung), 'utf8');
await writeFile(resolve(ziel, 'xrechnung.xml'), erzeugeUbl(rechnung), 'utf8');

console.log(`Rechnung ${rechnung.nummer}`);
console.log(`  netto  ${(rechnung.summeNettoCent / 100).toFixed(2)} ${rechnung.waehrung}`);
console.log(`  USt.   ${(rechnung.summeSteuerCent / 100).toFixed(2)} ${rechnung.waehrung}`);
console.log(`  brutto ${(rechnung.summeBruttoCent / 100).toFixed(2)} ${rechnung.waehrung}`);
console.log(`geschrieben nach ${ziel}`);
