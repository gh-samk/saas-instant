import { AppController, RobotsController } from './app.controller';
import { APP_VERSION } from './version';

describe('AppController', () => {
  const controller = new AppController();

  it('gesundheit() bleibt ein reines Lebenszeichen ohne Zustand', () => {
    expect(controller.health()).toEqual({ status: 'ok' });
  });
});

/**
 * Die Verwaltung hatte keinen /api/version — anders als die Kundenanwendung.
 * Damit liess sich im Stoerungsfall nicht ablesen, welcher Stand laeuft.
 */
describe('AppController.version', () => {
  const controller = new AppController();
  const before = { ...process.env };
  afterEach(() => {
    process.env = { ...before };
  });

  it('meldet eine Semver-Fassung', () => {
    expect(controller.version().version).toMatch(/^\d+\.\d+\.\d+$/);
    expect(controller.version().version).toBe(APP_VERSION);
  });

  it('nimmt Commit und Bauzeitpunkt aus der Umgebung', () => {
    process.env.APP_GIT_SHA = 'abc123';
    process.env.APP_BUILD_TIME = '2026-09-06T10:00:00Z';
    expect(controller.version()).toMatchObject({
      commit: 'abc123',
      builtAt: '2026-09-06T10:00:00Z',
    });
  });

  /** Genau daran zeigte die Kundenanwendung lange einen leeren Commit. */
  it('behandelt einen LEEREN Wert wie einen fehlenden', () => {
    process.env.APP_GIT_SHA = '';
    expect(controller.version().commit).toBe('dev');
  });

  it('gibt ohne Umgebung und ohne Datei null zurueck', () => {
    delete process.env.APP_BUILD_TIME;
    expect(controller.version().builtAt).toBeNull();
  });

  it('verraet nichts ueber Konten oder den Postausgang', () => {
    const fields = Object.keys(controller.version());
    expect(fields.sort()).toEqual(['builtAt', 'commit', 'version']);
  });
});

describe('RobotsController', () => {
  it('sperrt Suchmaschinen aus', () => {
    expect(new RobotsController().robots()).toContain('Disallow: /');
  });
});
