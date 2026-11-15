import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  backendRoutes,
  frontendCalls,
  normalizePath,
  served,
  SRC,
  walk,
  withoutComments,
} from './route-parsing';

/**
 * ===========================================================================
 * VERTRAG FRONTEND <-> BACKEND (Umbenennungsreste)
 * ===========================================================================
 *
 * Nach der Umbenennung fand die Sicherheitsprüfung mehrfach Pfade, die nicht
 * mehr stimmten (Frontend rief `/api/users`, der Controller hieß `user`),
 * obwohl alle Tests grün waren: Jede Seite wurde nur gegen ihre EIGENE
 * Attrappe geprüft. Dieser Test legt beide Seiten übereinander.
 *
 * Er liest Quelltext (Controller-Dekoratoren, `apiFetch`-Aufrufe), startet
 * nichts und braucht keine Datenbank.
 */

const routes = backendRoutes();

describe('Vertrag Frontend <-> Backend', () => {
  it('findet die Controller überhaupt (sonst prüft der Test nichts)', () => {
    expect(routes.length).toBeGreaterThan(100);
    expect(served(routes, 'GET', '/api/users')).toBe(true);
  });

  it('jeder apiFetch-Aufruf in lib/api.ts wird von einer Route bedient', () => {
    const calls = frontendCalls([
      join(SRC, 'lib/api.ts'),
      join(SRC, 'lib/api-client.ts'),
    ]);
    expect(calls.length).toBeGreaterThan(80);
    const unserved = calls
      .filter((c) => !served(routes, c.method, c.path))
      .map((c) => `${c.method} ${c.path}  (${c.file.replace(SRC, 'src')}:${c.line})`);
    expect(unserved).toEqual([]);
  });

  it('jeder /api-Aufruf im übrigen Frontend wird von einer Route bedient', () => {
    const files = walk(
      SRC,
      (f) =>
        /\.(ts|tsx)$/.test(f) &&
        !/\.(spec|test)\.tsx?$/.test(f) &&
        !/[\\/]lib[\\/]api(-client)?\.ts$/.test(f) &&
        /\.tsx$|[\\/](context|components|pages|lib|utils)[\\/]/.test(f),
    );
    const unserved = frontendCalls(files)
      .filter((c) => !served(routes, c.method, c.path))
      .map((c) => `${c.method} ${c.path}  (${c.file.replace(SRC, 'src')}:${c.line})`);
    expect(unserved).toEqual([]);
  });

  it('Verweise (href/src) auf /api im Frontend treffen eine GET-Route', () => {
    const files = walk(SRC, (f) => /\.tsx$/.test(f) && !/\.(spec|test)\.tsx$/.test(f));
    const bad: string[] = [];
    for (const file of files) {
      const source = withoutComments(readFileSync(file, 'utf8'));
      for (const m of source.matchAll(/(?:href|src)=\{?`(\/api\/[^`]*)`/g)) {
        const path = normalizePath(m[1]!.replace(/\$\{[^}]*\}/g, '\u0000'));
        if (!served(routes, 'GET', path)) bad.push(`${path} (${file.replace(SRC, 'src')})`);
      }
    }
    expect(bad).toEqual([]);
  });

  /**
   * Mail-Links und Seiten, die der SERVER baut: Bestätigungs-, Abmelde- und
   * Aufnahmelink, das Formular-`action`, Notfall-Links. `/api/…` muss eine
   * Route treffen, alles andere eine Seite der Anwendung (App.tsx).
   */
  it('Links, die das Backend in Mails und Seiten baut, treffen eine Route oder Seite', () => {
    const app = readFileSync(join(SRC, 'App.tsx'), 'utf8');
    const pages = [...app.matchAll(/path="([^"]+)"/g)].map((m) => m[1]!);
    const pageServed = (p: string) =>
      pages.some((page) =>
        page === p || new RegExp(`^${page.replace(/:[^/]+/g, '[^/]+')}$`).test(p.replace(/:p/g, 'x')),
      );

    const files = walk(
      SRC,
      (f) => /\.ts$/.test(f) && !/\.(spec|test)\.ts$/.test(f) && !/[\\/](lib|utils|i18n)[\\/]/.test(f),
    );
    const found: string[] = [];
    const bad: string[] = [];
    for (const file of files) {
      const source = withoutComments(readFileSync(file, 'utf8'));
      // `${baseUrl(...)}/pfad` und `${this.baseUrl()}/pfad` und `/api/…`.
      const re = /`(?:\$\{(?:[^{}]|\{[^{}]*\})*\})?(\/(?:api\/)?[a-z][a-z0-9/_-]*(?:\/\$\{[^}]*\})*[a-z0-9/_-]*)(?:\?[^`]*)?`/g;
      for (const m of source.matchAll(re)) {
        const whole = m[0];
        const isLink = /baseUrl|BaseUrl/.test(whole) || m[1]!.startsWith('/api/');
        if (!isLink) continue;
        const path = normalizePath(m[1]!.replace(/\$\{[^}]*\}/g, '\u0000'));
        found.push(path);
        const ok = path.startsWith('/api/')
          ? routes.some((r) => r.path.split('/').length === path.split('/').length && served(routes, r.method, path))
          : pageServed(path);
        if (!ok) bad.push(`${path} (${file.replace(SRC, 'src')})`);
      }
    }
    // Der Test muss die bekannten Links tatsächlich gesehen haben.
    expect(found).toEqual(
      expect.arrayContaining([
        '/api/intake/:p',
        '/api/consent/confirmation/:p',
        '/api/consent/unsubscribe/:p',
      ]),
    );
    expect(bad).toEqual([]);
  });

  it('die Notfall-Links des Servers zeigen auf Seiten der Anwendung', () => {
    const source = readFileSync(join(SRC, 'auth/emergency.service.ts'), 'utf8');
    const app = readFileSync(join(SRC, 'App.tsx'), 'utf8');
    const paths = [...source.matchAll(/:\s*'(\/emergency-[a-z-]+)'/g)].map((m) => m[1]!);
    expect(paths.length).toBe(2);
    for (const p of paths) expect(app).toContain(`path="${p}"`);
  });
});
