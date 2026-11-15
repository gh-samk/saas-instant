import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

/**
 * R1/R4 für die Sicherungs-Anbindung — nachgeprüft, nicht versprochen.
 *
 * Ergänzt `coolify/no-delete-path.spec.ts` um die neuen Dateien (Teil F):
 * Der Agent-Client kennt nur GET/PUT/POST, die Wiederherstellungs-Dateien
 * kennen gegenüber dem Provisioner nur create/status/stop, und nirgends steht
 * ein Löschaufruf gegen Coolify, Instanzen oder Datenbanken.
 */
const SRC = join(__dirname, '..');

function code(path: string): string {
  return readFileSync(join(SRC, path), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .filter((row) => !row.trim().startsWith('//'))
    .join('\n');
}

const BACKUP_FILES = [
  ...readdirSync(__dirname)
    .filter((f) => f.endsWith('.ts') && !f.endsWith('.spec.ts'))
    .map((f) => `backup-settings/${f}`),
  'backup-settings/dto/backup-settings.dto.ts',
  'instances/instance-restore.service.ts',
  'instances/instance-restore.errors.ts',
  'instances/instance-backup.service.ts',
  'instances/instance-backups.controller.ts',
  'instances/backup-plan.service.ts',
  'instances/backup-plan.ts',
  'instances/internal-backup-plan.controller.ts',
];

describe('R1/R4 — kein Löschpfad in der Sicherungs-Anbindung', () => {
  it('findet die Dateien', () => {
    expect(BACKUP_FILES.length).toBeGreaterThanOrEqual(12);
    for (const file of BACKUP_FILES) expect(code(file).length).toBeGreaterThan(0);
  });

  it('schickt nirgends ein HTTP-DELETE und kennt keinen Löschaufruf', () => {
    const suspicion = /\b(delete|destroy|remove|purge|wipe|loesche|entferne|zerstoere)[A-Za-z]*\s*\(/i;
    for (const file of BACKUP_FILES) {
      const text = code(file);
      expect(`${file}: ${/(['"`])DELETE\1|method:\s*['"`]delete['"`]/i.test(text)}`).toBe(`${file}: false`);
      expect(`${file}: ${suspicion.test(text)}`).toBe(`${file}: false`);
    }
  });

  it('ruft den Provisioner nur mit create, status und stop auf', () => {
    for (const file of BACKUP_FILES) {
      const calls = [...code(file).matchAll(/this\.provisioner\.([A-Za-z]+)\(/g)].map((m) => m[1]);
      for (const name of calls) expect(['create', 'status', 'stop']).toContain(name);
    }
  });

  it('löscht keine Nachweis-Zeilen (Instanz, Sicherung, Wiederherstellung)', () => {
    for (const file of BACKUP_FILES) {
      expect(code(file)).not.toMatch(
        /\b(instance|backup|instanceRestore|auditLog|backupTarget)\s*\.\s*(delete|deleteMany)\s*\(/i,
      );
    }
  });

  it('der Agent-Client kennt nur GET, PUT und POST', () => {
    const text = code('backup-settings/backup-agent.client.ts');
    expect(text).toContain("type AgentMethod = 'GET' | 'PUT' | 'POST'");
    expect(text).not.toMatch(/['"`](DELETE|PATCH)['"`]/);
  });

  it('die Übernahme stoppt die alte Instanz und löscht sie nicht', () => {
    const text = code('instances/instance-restore.service.ts');
    expect(text).toContain('this.provisioner.stop(old.coolifyApplicationId)');
    expect(text).not.toMatch(/instance\.(delete|deleteMany)/);
  });
});
