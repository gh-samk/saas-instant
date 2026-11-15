import type { ConfigService } from '@nestjs/config';
import { readFileSync, readdirSync, statSync } from 'fs';
import { join } from 'path';
import { baseUrl, companyUrl } from './base-url';

function config(values: Record<string, string> = {}): ConfigService {
  return {
    get: (name: string, preset?: string) => values[name] ?? preset,
  } as unknown as ConfigService;
}

describe('Die Basisadresse der Mail-Links', () => {
  it('bevorzugt CONTROL_MAIL_BASE_URL vor CONTROL_APP_URL', () => {
    expect(
      baseUrl(
        config({
          CONTROL_MAIL_BASE_URL: 'https://post.example',
          CONTROL_APP_URL: 'https://intern.example',
        }),
      ),
    ).toBe('https://post.example');
  });

  it('faellt auf CONTROL_APP_URL zurueck', () => {
    expect(baseUrl(config({ CONTROL_APP_URL: 'https://a.example' }))).toBe(
      'https://a.example',
    );
  });

  it('schneidet Schraegstriche am Ende ab', () => {
    expect(baseUrl(config({ CONTROL_APP_URL: 'https://a.example///' }))).toBe(
      'https://a.example',
    );
  });

  /**
   * Der Pfad muss der Route in `App.tsx` entsprechen. Ein Verweis ins Leere
   * waere schlimmer als keiner: Die Verwaltung faengt jeden unbekannten Pfad
   * mit der Oberflaeche ab und leitet auf die Anmeldeseite um — die Mail
   * saehe richtig aus und fuehrte trotzdem nirgendwohin.
   */
  it('baut den Verweis auf eine Organisation so, wie der Router ihn kennt', () => {
    const url = companyUrl(
      config({ CONTROL_APP_URL: 'https://v.example' }),
      'abc-123',
    );
    expect(url).toBe('https://v.example/companies/abc-123');

    const app = readFileSync(join(__dirname, '..', 'App.tsx'), 'utf8');
    expect(app).toContain('path="/companies/:id"');
  });
});

/**
 * ===========================================================================
 * ES DARF KEINE VIERTE ABSCHRIFT GEBEN [A.34]
 * ===========================================================================
 *
 * Dieselben fuenf Zeilen standen zweimal im Quelltext, und die zweite
 * begruendete im eigenen Kommentar, warum zwei Fassungen derselben Adresse
 * gefaehrlich sind. Beide delegieren jetzt hierher. Dieser Test haelt den
 * Zustand fest — dieselbe Bauweise wie `kanaltrennung.spec.ts`: Er liest den
 * Quelltext und zaehlt.
 */
describe('Die Vorrangregel steht nur an einer Stelle', () => {
  function allSources(folder: string): string[] {
    return readdirSync(folder).flatMap((entry) => {
      const path = join(folder, entry);
      if (statSync(path).isDirectory()) return allSources(path);
      return path.endsWith('.ts') && !path.endsWith('.spec.ts') ? [path] : [];
    });
  }

  it('liest CONTROL_MAIL_BASE_URL in genau einer Datei', () => {
    const match = allSources(join(__dirname, '..')).filter((path) =>
      readFileSync(path, 'utf8').includes('CONTROL_MAIL_BASE_URL'),
    );
    expect(match.map((p) => p.split('/').pop())).toEqual(['base-url.ts']);
  });
});
