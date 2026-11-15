import { readFileSync } from 'fs';
import { join } from 'path';

/**
 * ===========================================================================
 * DER AUFBAU FRAGT COOLIFY NICHT NACH DEM ZUSTAND DER ANWENDUNG
 * ===========================================================================
 *
 * Am 12.09.2026 scheiterte der vierte Versuch, eine Instanz anzulegen, an
 * einer Warteschleife, die nachsah, ob Coolify die Compose-Datei gelesen
 * hatte. Sie HATTE — aber `docker_compose_raw` ist bei Coolify ein sensibles
 * Feld, und das Token der Verwaltung hat bewusst kein `read:sensitive`.
 * Coolify liess das Feld deshalb ganz weg; die Schleife sah „nicht geladen",
 * so lange sie auch fragte.
 *
 * Der Nachweis, der das hätte fangen sollen, lief mit einem Voll-Token statt
 * mit dem der Verwaltung und war damit blind für genau diese Grenze.
 *
 * Jetzt beantwortet das SETZEN der Domäne die Frage. Dieser Test hält fest,
 * dass der Aufbau Coolify nicht wieder nach dem Zustand einer Anwendung
 * fragt — jede solche Abfrage hinge an Feldern, deren Sichtbarkeit das Token
 * bestimmt, nicht der Code.
 */
describe('Der Instanz-Aufbau', () => {
  const source = readFileSync(join(__dirname, 'instance-provisioning.service.ts'), 'utf8');
  // Nur Code, keine Kommentare: Die Begründung darf die Wörter nennen.
  const code = source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1');

  const provisionerSource = readFileSync(
    join(__dirname, '..', 'coolify', 'coolify.provisioner.ts'),
    'utf8',
  );
  const provisionerCode = provisionerSource
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1');
  // Nur das Anlegen — `status(ref)` liest bewusst (Verwerfen einer Erstellung).
  const createCode = provisionerCode.slice(
    provisionerCode.indexOf('async create('),
    provisionerCode.indexOf('status(): Promise'),
  );

  it('fragt Coolify nicht nach dem Zustand einer Anwendung', () => {
    expect(code).not.toContain('getApplication(');
    expect(code).not.toContain('.status(');
    expect(createCode.length).toBeGreaterThan(200);
    expect(createCode).not.toContain('getApplication(');
  });

  it('liest kein Feld, das Coolify ohne read:sensitive weglässt', () => {
    // Verboten ist das LESEN des Feldes — als Index oder als Eigenschaft.
    // Das Wort in der erkannten Coolify-Antwort („without
    // docker_compose_raw") ist erlaubt und sogar verlangt (Fall darunter);
    // eine erste Fassung dieses Tests verbot das Wort selbst und widersprach
    // sich damit.
    expect(code).not.toMatch(/\[\s*['"]docker_compose(_raw)?['"]\s*\]/);
    expect(code).not.toMatch(/\.docker_compose(_raw)?\b/);
    expect(code).not.toContain('composeGeladen');
  });

  it('fällt um, sobald jemand das Feld wieder liest (Gegenprobe)', () => {
    expect("roh['docker_compose_raw']").toMatch(/\[\s*['"]docker_compose(_raw)?['"]\s*\]/);
    expect('application.docker_compose_raw').toMatch(/\.docker_compose(_raw)?\b/);
    expect("'without docker_compose_raw'").not.toMatch(/\.docker_compose(_raw)?\b/);
  });

  it('erkennt „noch nicht so weit" an genau der Antwort von Coolify', () => {
    expect(provisionerCode).toContain("'without docker_compose_raw'");
  });
});
