// Hilfen der Suite "invoice": Mailpit-API, PDF-Prüfung ohne Fremdwerkzeuge, SQL gegen die Test-Datenbank.
import { createHash } from 'node:crypto';
import { inflateSync } from 'node:zlib';
import { docker } from '../lib/docker.mjs';
import { waitFor, sleep } from '../lib/util.mjs';

export const sha256 = (buf) => createHash('sha256').update(buf).digest('hex');

// ------------------------------------------------------------------ Mailpit
export function mailpit(base) {
  const get = async (path) => {
    const r = await fetch(`${base}/api/v1${path}`);
    if (!r.ok) throw new Error(`Mailpit ${path} -> HTTP ${r.status}`);
    return r;
  };
  return {
    async list() {
      return (await (await get('/messages?limit=200')).json()).messages ?? [];
    },
    async message(id) {
      return (await get(`/message/${id}`)).json();
    },
    async part(id, partId) {
      return Buffer.from(await (await get(`/message/${id}/part/${partId}`)).arrayBuffer());
    },
    async clear() {
      await fetch(`${base}/api/v1/messages`, { method: 'DELETE' });
    },
    /** Wartet auf eine Mail, deren Zusammenfassung `pred` erfüllt; liefert die volle Nachricht. */
    async waitFor(pred, label, timeoutMs = 60_000) {
      const summary = await waitFor(async () => (await this.list()).find(pred), { timeoutMs, label: `Mail: ${label}` });
      return this.message(summary.ID);
    },
  };
}

// ------------------------------------------------------------------ PDF
/** Alle entpackbaren Streams eines PDF (Flate) plus das Rohmaterial als latin1-Text. */
export function pdfStreams(buf) {
  const out = [];
  const raw = buf.toString('latin1');
  let pos = 0;
  for (;;) {
    const s = raw.indexOf('stream', pos);
    if (s < 0) break;
    if (raw.slice(s - 3, s) === 'end') { pos = s + 6; continue; }
    let start = s + 6;
    if (raw[start] === '\r') start++;
    if (raw[start] === '\n') start++;
    const e = raw.indexOf('endstream', start);
    if (e < 0) break;
    const dictStart = raw.lastIndexOf('obj', s);
    const dict = raw.slice(dictStart, s);
    const data = buf.subarray(start, e);
    let content = null;
    if (/FlateDecode/.test(dict)) {
      try { content = inflateSync(data); } catch { /* beschädigt oder nicht entpackbar */ }
    } else content = data;
    out.push({ dict, content });
    pos = e + 9;
  }
  return { raw, streams: out };
}

/** Findet den eingebetteten Anhang `factur-x.xml` (oder ersatzweise ein CII-XML) im PDF. */
export function extractAttachedXml(pdf) {
  const { raw, streams } = pdfStreams(pdf);
  const embedded = streams.filter((s) => /\/EmbeddedFile/.test(s.dict) && s.content);
  const xml = embedded.map((s) => s.content.toString('utf8')).find((t) => /CrossIndustryInvoice/.test(t));
  const nameInPdf =
    /factur-x\.xml/.test(raw) || streams.some((s) => s.content && s.content.includes('factur-x.xml'));
  return { xml: xml ?? null, nameInPdf, embeddedCount: embedded.length };
}

// ------------------------------------------------------------------ SQL
export function sqlClient({ container, dbName, user = 'postgres' }) {
  return async (sql, { allowFail = false } = {}) => {
    const r = await docker(
      ['exec', container, 'psql', '-U', user, '-d', dbName, '-v', 'ON_ERROR_STOP=1', '-tAc', sql],
      { allowFail },
    );
    return { code: r.code, out: r.stdout.trim(), err: r.stderr.trim() };
  };
}

export const today = () => new Date().toISOString().slice(0, 10);
export const monthRange = () => {
  const d = new Date();
  const y = d.getUTCFullYear();
  const m = d.getUTCMonth();
  const pad = (n) => String(n).padStart(2, '0');
  const last = new Date(Date.UTC(y, m + 1, 0)).getUTCDate();
  return { from: `${y}-${pad(m + 1)}-01`, until: `${y}-${pad(m + 1)}-${pad(last)}` };
};

/** SEPA-Gläubiger-ID prüfen (ISO 7064 MOD 97-10 über den nationalen Teil). */
export function creditorIdValid(id) {
  const s = id.replace(/\s+/g, '').toUpperCase();
  if (!/^[A-Z]{2}\d{2}[A-Z0-9]{3}[A-Z0-9]{1,28}$/.test(s)) return false;
  const rearranged = s.slice(7) + s.slice(0, 4);
  const num = [...rearranged].map((c) => (/\d/.test(c) ? c : String(c.charCodeAt(0) - 55))).join('');
  let rem = 0;
  for (const ch of num) rem = (rem * 10 + Number(ch)) % 97;
  return rem === 1;
}

// ------------------------------------------------------------------ Drosselung (Throttler der Control-API)
/**
 * Hält höchstens `limit` Aufrufe je Fenster ein (die Routen erlauben 10 je Minute). Wartet nur, wenn nötig;
 * `key` trennt die Routen (jede hat ihren eigenen Zähler im Server).
 */
export function pacer({ limit = 9, windowMs = 60_000 } = {}) {
  const calls = new Map();
  return async (key) => {
    const recent = () => (calls.get(key) ?? []).filter((t) => Date.now() - t < windowMs);
    let list = recent();
    if (list.length >= limit) {
      await sleep(windowMs - (Date.now() - list[0]) + 500);
      list = recent();
    }
    list.push(Date.now());
    calls.set(key, list);
  };
}

// ------------------------------------------------------------------ PDF-Inhalt (Farben, Text)
/** Alle Farbwerte (r,g,b in 0..255), die in den Inhaltsströmen eines PDF gesetzt werden (rg/RG/sc/scn). */
export function pdfColors(buf) {
  const found = [];
  const re = /(-?\d*\.?\d+)\s+(-?\d*\.?\d+)\s+(-?\d*\.?\d+)\s+(?:rg|RG|sc|scn|SC|SCN)\b/g;
  for (const { content } of pdfStreams(buf).streams) {
    if (!content || content.length > 2_000_000) continue;
    const text = content.toString('latin1');
    for (const m of text.matchAll(re)) {
      const rgb = [m[1], m[2], m[3]].map((x) => Math.round(Number(x) * 255));
      if (rgb.every((c) => c >= 0 && c <= 255)) found.push(rgb);
    }
  }
  return found;
}

/** Kommt die Farbe `#rrggbb` (mit Toleranz 1 je Kanal, wegen der Rundung im PDF) in den Inhaltsströmen vor? */
export function pdfHasColor(buf, hex) {
  const want = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
  return pdfColors(buf).some((c) => c.every((v, i) => Math.abs(v - want[i]) <= 1));
}

/** Anzahl Bild-XObjects (grobe Zählung aus den Wörterbüchern; die genaue Zahl liefert PdfText.java). */
export function pdfImageObjects(buf) {
  return pdfStreams(buf).streams.filter((s) => /\/Subtype\s*\/Image/.test(s.dict)).length;
}

/** Text vergleichbar machen: geschützte/schmale Leerzeichen und Zeilenumbrüche -> ein Leerzeichen. */
export const normText = (s) => s.replace(/[   ]/g, ' ').replace(/\s+/g, ' ').trim();
export const countOf = (hay, needle) => (needle === '' ? 0 : hay.split(needle).length - 1);
/** XML-Entitäten zurückführen (für Vergleiche mit Klartext). */
export const xmlUnescape = (s) =>
  s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&');
