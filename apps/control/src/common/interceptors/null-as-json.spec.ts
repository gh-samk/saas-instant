import { readdirSync, readFileSync } from 'fs';
import { join } from 'path';
import type { CallHandler, ExecutionContext } from '@nestjs/common';
import { lastValueFrom, of } from 'rxjs';
import { NullAsJsonInterceptor } from './null-as-json.interceptor';

/** Ein Antwortobjekt, das sich befragen lässt. */
function response(headersSent = false) {
  const header: Record<string, string> = {};
  return {
    headersSent,
    header,
    setHeader: (name: string, value: string) => {
      header[name] = value;
    },
  };
}

function context(res: ReturnType<typeof response>): ExecutionContext {
  return {
    switchToHttp: () => ({ getResponse: () => res }),
  } as unknown as ExecutionContext;
}

function handler(value: unknown): CallHandler {
  return { handle: () => of(value) };
}

async function by(value: unknown, res = response()): Promise<unknown> {
  return lastValueFrom(
    new NullAsJsonInterceptor().intercept(context(res), handler(value)),
  );
}

/**
 * Gibt ein Handler `null` zurück, sendet der Express-Adapter einen LEEREN
 * Body — `Content-Length: 0`, kein `Content-Type`. Für einen Aufrufer mit
 * `await antwort.json()` ist das ein Syntaxfehler, kein leeres Ergebnis.
 * Gemessen an `GET /companies/:id/instanz`: Jede Organisationsseite ohne
 * Instanz brach in der Oberfläche ab.
 */
describe('`null` geht als JSON über die Leitung', () => {
  it('macht aus null die vier Zeichen `null` mit JSON-Kopf', async () => {
    const res = response();
    expect(await by(null, res)).toBe('null');
    expect(res.header['Content-Type']).toBe('application/json; charset=utf-8');
    // Und es ist gültiges JSON, das genau `null` bedeutet.
    expect(JSON.parse('null')).toBeNull();
  });

  it('lässt `undefined` unangetastet — das sind die @Res()-Routen', async () => {
    const res = response();
    expect(await by(undefined, res)).toBeUndefined();
    expect(res.header['Content-Type']).toBeUndefined();
  });

  it('fasst eine bereits gesendete Antwort nicht mehr an', async () => {
    const res = response(true);
    expect(await by(null, res)).toBeNull();
    expect(res.header['Content-Type']).toBeUndefined();
  });

  it.each([
    ['ein Objekt', { a: 1 }],
    ['eine Liste', [1, 2]],
    ['eine Zeichenkette', 'text'],
    ['eine Zahl', 0],
    ['false', false],
  ])('lässt %s unverändert', async (_name, value) => {
    expect(await by(value)).toEqual(value);
  });

  /**
   * Der Interceptor ist global. Dieser Test hält fest, WELCHE Routen ihn
   * brauchen — damit beim nächsten `| null` jemand hierher schaut und sieht,
   * dass es abgedeckt ist.
   */
  it('deckt jede Route ab, die `null` zurückgeben kann', () => {
    const root = join(__dirname, '..', '..');
    const found: string[] = [];
    const scan = (folder: string): void => {
      for (const entry of readdirSync(folder, { withFileTypes: true })) {
        const path = join(folder, entry.name);
        if (entry.isDirectory()) {
          scan(path);
          continue;
        }
        if (!entry.name.endsWith('.controller.ts')) continue;
        if (entry.name.endsWith('.spec.ts')) continue;
        const content = readFileSync(path, 'utf8');
        if (/Promise<[^>]*\|\s*null>/.test(content)) found.push(entry.name);
      }
    };
    scan(root);

    // Beide bekannt, beide gedeckt. Kommt eine dritte dazu, fällt der Test
    // auf — und wer ihn liest, weiss sofort, warum es ihn gibt.
    expect(found.sort()).toEqual([
      'broadcast.controller.ts',
      'instance.controller.ts',
    ]);
  });
});
