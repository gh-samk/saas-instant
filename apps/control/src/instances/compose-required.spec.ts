import { readFileSync } from 'fs';
import { join } from 'path';
import { ENVIRONMENT_VARIABLES } from './instance.rules';

/**
 * ===========================================================================
 * JEDE PFLICHTVARIABLE DER KUNDEN-COMPOSE WIRD AUCH GESETZT
 * ===========================================================================
 *
 * Coolify legt für jede in der Compose-Datei erwähnte Variable einen Eintrag
 * an — und bei der Pflichtform `${VAR:?Meldung}` nimmt es DIE MELDUNG als
 * Wert. Setzt die Verwaltung eine solche Variable nicht selbst, startet die
 * Instanz mit einem deutschen Satz an ihrer Stelle.
 *
 * Genau das ist mit `SMTP_HOST` passiert: Die Verwaltung setzte ihn nicht, und
 * eine Kundeninstanz hatte als Mailserver „SMTP_HOST muss
 * gesetzt sein, sonst kommen weder Einladungen noch Passwort-Reset an".
 *
 * Dieser Test liest die Compose-Datei selbst. Kommt dort eine neue
 * Pflichtvariable hinzu, fällt er — bevor ein Kunde es merkt.
 */
const COMPOSE = join(__dirname, '..', '..', '..', '..', 'docker-compose.coolify.yml');

function requiredVariables(): string[] {
  const text = readFileSync(COMPOSE, 'utf8');
  return [...new Set([...text.matchAll(/\$\{([A-Z][A-Z0-9_]*):\?/g)].map((t) => t[1]!))];
}

describe('Die Kunden-Compose und die Umgebung einer neuen Instanz', () => {
  it('findet überhaupt Pflichtvariablen — ein Test, der nichts findet, wäre still grün', () => {
    expect(requiredVariables().length).toBeGreaterThanOrEqual(5);
    expect(requiredVariables()).toContain('SMTP_HOST');
  });

  it('setzt JEDE Pflichtvariable selbst', () => {
    const set = new Set<string>(ENVIRONMENT_VARIABLES);
    const missing = requiredVariables().filter((name) => !set.has(name));
    expect(missing).toEqual([]);
  });
});
