import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Hilfen für die Vertragstests: Routen aus den Controller-Quelltexten und
 * Aufrufe aus den Frontend-Quelltexten lesen. Reine Quelltextanalyse, ohne
 * Nest zu starten (kein Datenbank-, kein Netzzugriff).
 */

export const SRC = join(__dirname, '..');
export const GLOBAL_PREFIX = '/api';

export interface Route {
  method: string;
  /** Mit Präfix, Parameter als `:name`. */
  path: string;
  file: string;
}

export interface Call {
  method: string;
  /** Parameter und Schablonen als `:p`, ohne Query-String. */
  path: string;
  file: string;
  line: number;
}

export function walk(dir: string, accept: (file: string) => boolean): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) out.push(...walk(full, accept));
    else if (accept(full)) out.push(full);
  }
  return out;
}

/** Quelltext ohne Block- und Zeilenkommentare (Zeichenketten bleiben). */
export function withoutComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
    .replace(/(^|[^:'"`\\])\/\/.*$/gm, '$1');
}

function join2(...parts: string[]): string {
  const joined = parts
    .map((p) => p.replace(/^\/+|\/+$/g, ''))
    .filter((p) => p !== '')
    .join('/');
  return `/${joined}`;
}

const HTTP = ['Get', 'Post', 'Put', 'Patch', 'Delete', 'All'] as const;

/** Alle Routen aller `*.controller.ts` (ohne Specs). */
export function backendRoutes(): Route[] {
  const files = walk(SRC, (f) => /\.controller\.ts$/.test(f));
  const routes: Route[] = [];
  for (const file of files) {
    const source = withoutComments(readFileSync(file, 'utf8'));
    const parts = source.split(/@Controller\(/).slice(1);
    for (const part of parts) {
      const head = /^\s*(?:'([^']*)'|"([^"]*)"|\{[^)]*?path:\s*'([^']*)'[^)]*\})?\s*\)/.exec(
        part,
      );
      const prefix = head?.[1] ?? head?.[2] ?? head?.[3] ?? '';
      const body = part.slice(head?.[0].length ?? 0);
      const re = new RegExp(
        `@(${HTTP.join('|')})\\(\\s*(?:'([^']*)'|"([^"]*)")?\\s*\\)`,
        'g',
      );
      let m: RegExpExecArray | null;
      while ((m = re.exec(body))) {
        const method = m[1]!.toUpperCase();
        routes.push({
          method,
          path: join2(GLOBAL_PREFIX, prefix, m[2] ?? m[3] ?? ''),
          file,
        });
      }
    }
  }
  return routes;
}

/** Passt ein konkreter/Schablonen-Pfad auf eine Route? Segmentweise. */
export function pathMatches(route: string, candidate: string): boolean {
  const a = route.split('/');
  const b = candidate.split('/');
  if (a.length !== b.length) return false;
  return a.every((seg, i) => {
    const other = b[i]!;
    if (seg.startsWith(':') || other === ':p') return true;
    return seg === other;
  });
}

export function served(routes: Route[], method: string, path: string): boolean {
  return routes.some(
    (r) =>
      (r.method === method || r.method === 'ALL') && pathMatches(r.path, path),
  );
}

/**
 * Liest ab `start` (hinter dem ersten Zeichen eines Literals) ein Literal.
 * Gibt den Text mit `${…}` als \u0000 zurück und die Endposition.
 */
export function readLiteral(text: string, start: number): { value: string; end: number } {
  const quote = text[start]!;
  let i = start + 1;
  let value = '';
  while (i < text.length && text[i] !== quote) {
    if (text[i] === '\\') {
      value += text[i + 1] ?? '';
      i += 2;
      continue;
    }
    if (quote === '`' && text[i] === '$' && text[i + 1] === '{') {
      let depth = 1;
      i += 2;
      while (i < text.length && depth > 0) {
        const ch = text[i]!;
        if (ch === '`') i = readLiteral(text, i).end;
        else {
          if (ch === '{') depth += 1;
          else if (ch === '}') depth -= 1;
          i += 1;
        }
      }
      value += '\u0000';
      continue;
    }
    value += text[i];
    i += 1;
  }
  return { value, end: i + 1 };
}

/** `${…}` als ganzes Segment -> `:p`; hinten angehängt (Query) -> weg. */
export function normalizePath(literal: string): string {
  const noQuery = literal.split('?')[0]!;
  return noQuery
    // Hängt `${…}` an ein Segment an (`/api/tasks${query}`), ist es ein
    // Query-Anhang und fällt weg; steht es als ganzes Segment, ist es ein Parameter.
    .replace(/([^/\u0000])\u0000+$/, '$1')
    .replace(/\u0000/g, ':p')
    .replace(/\/+$/, '');
}

function lineOf(source: string, index: number): number {
  return source.slice(0, index).split('\n').length;
}

/** Alle `apiFetch`/`apiFile`/`fetch`-Aufrufe mit `/api/…`-Literal. */
export function frontendCalls(files: string[]): Call[] {
  const calls: Call[] = [];
  for (const file of files) {
    const source = withoutComments(readFileSync(file, 'utf8'));
    const re = /\b(apiFetch|apiFile|fetch)\b(?:<[^()]*?>)?\s*\(\s*/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(source))) {
      const at = m.index + m[0].length;
      // `${API_BASIS}` vorn überspringen.
      let start = at;
      if (source.startsWith('`${API_BASIS}', start)) {
        start = start + '`${API_BASIS}'.length - 1;
      }
      const ch = source[at];
      if (ch !== "'" && ch !== '"' && ch !== '`') continue;
      let literal: string;
      if (source.startsWith('`${API_BASIS}', at)) {
        literal = readLiteral(source, at).value.replace(/^\u0000/, '');
      } else {
        literal = readLiteral(source, at).value;
      }
      if (!literal.startsWith('/api/')) continue;
      // Der Optionsblock: bis zur schließenden Klammer des Aufrufs.
      let depth = 1;
      let i = readLiteral(source, at).end;
      const optionsStart = i;
      while (i < source.length && depth > 0) {
        const c = source[i]!;
        if (c === '`' || c === "'" || c === '"') {
          i = readLiteral(source, i).end;
          continue;
        }
        if (c === '(') depth += 1;
        else if (c === ')') depth -= 1;
        i += 1;
      }
      const options = source.slice(optionsStart, i);
      const method = /method:\s*'(\w+)'/.exec(options)?.[1]?.toUpperCase() ?? 'GET';
      calls.push({
        method,
        path: normalizePath(literal),
        file,
        line: lineOf(source, m.index),
      });
    }
  }
  return calls;
}
