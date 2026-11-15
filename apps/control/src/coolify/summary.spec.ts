import { REASON_MAX, summary } from './coolify.client';

/**
 * ===========================================================================
 * WARUM ES DIESE FUNKTION GIBT
 * ===========================================================================
 *
 * Am 07.09.2026 scheiterte das Anlegen einer Instanz mit
 * „Coolify antwortete 422 auf POST /applications/private-deploy-key." —
 * mehr stand nicht da. `422` ist der EINE Status, dessen Rumpf sagt, welches
 * Feld nicht stimmt; Coolify hatte ihn mitgeschickt, und der Client hat ihn
 * gelesen und weggeworfen. Die Ursache liess sich danach nur noch raten.
 */
describe('Der Auszug aus einer Coolify-Fehlerantwort', () => {
  it('nennt Feld UND Grund einer Validierung', () => {
    const reason = summary(
      JSON.stringify({
        message: 'Validation failed.',
        errors: { project_uuid: ['This field is required.'] },
      }),
    );
    expect(reason).toContain('Validation failed.');
    expect(reason).toContain('project_uuid');
    expect(reason).toContain('required');
  });

  it('nennt jedes beanstandete Feld, nicht nur das erste', () => {
    const reason = summary(
      JSON.stringify({
        message: 'Validation failed.',
        errors: {
          project_uuid: ['This field is required.'],
          server_uuid: ['This field is required.'],
        },
      }),
    );
    expect(reason).toContain('project_uuid');
    expect(reason).toContain('server_uuid');
  });

  it('kommt auch mit `error` statt `errors` zurecht', () => {
    expect(summary(JSON.stringify({ message: 'Invalid request.', error: 'Empty JSON.' })))
      .toContain('Invalid request.');
  });

  it('verwirft Nicht-JSON nicht, sondern entschaerft es', () => {
    // Eine HTML-Fehlerseite beantwortet immerhin die Frage, WER geantwortet
    // hat — ein Proxy davor oder Coolify selbst.
    const reason = summary('<html>\n<head><title>502 Bad Gateway</title>\n');
    expect(reason).toContain('502 Bad Gateway');
    expect(reason).not.toContain('\n');
  });

  it('bleibt einzeilig und kurz genug fuer eine Karte', () => {
    const reason = summary('x'.repeat(5000));
    expect(reason.length).toBeLessThanOrEqual(REASON_MAX + 1);
    expect(reason.endsWith('…')).toBe(true);
  });

  it('macht aus einer leeren Antwort keine leere Behauptung', () => {
    expect(summary('')).toBe('');
    expect(summary('   \n  ')).toBe('');
  });
});
