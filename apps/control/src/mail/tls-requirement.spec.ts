import { checkTlsRequirement } from './tls-requirement';

/**
 * Die Abschaltung der Transportverschlüsselung ist in Produktion ein
 * Startabbruch, keine Warnung. Der Test hält beide Richtungen fest: dass
 * abgebrochen wird, UND dass die lokale Entwicklung weiterläuft — sonst wäre
 * der Schutz zwar da, aber der Docker-Stack gegen Mailpit kaputt.
 */
describe('SMTP_TLS_ERZWINGEN in Produktion', () => {
  it('bricht bei NODE_ENV=production und SMTP_TLS_ERZWINGEN=0 ab', () => {
    expect(() => checkTlsRequirement('production', '0')).toThrow(
      /SMTP_TLS_ERZWINGEN/,
    );
  });

  it('nennt die Variable beim Namen und sagt, warum es sie gibt', () => {
    // Eine Fehlermeldung, die nur „ungültige Konfiguration" sagt, führt bei
    // der nächsten Fehlersuche wieder zum Abschalten.
    let message = '';
    try {
      checkTlsRequirement('production', '0');
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    expect(message).toContain('SMTP_TLS_ERZWINGEN=0');
    expect(message).toContain('NODE_ENV=production');
    expect(message).toContain('Anmeldecode');
    expect(message).toContain('SMTP_PASS');
    // Und sie muss sagen, was zu tun ist.
    expect(message).toContain('Mailpit');
  });

  it('lässt Produktion mit erzwungener Verschlüsselung durch', () => {
    expect(() => checkTlsRequirement('production', '1')).not.toThrow();
  });

  it('behandelt „nicht gesetzt" in Produktion als erzwungen', () => {
    // Die Vorgabe im MailService ist '1'. Fehlt die Variable, ist alles gut —
    // sonst könnte niemand ohne sie starten.
    expect(() => checkTlsRequirement('production', undefined)).not.toThrow();
    expect(() => checkTlsRequirement('production', '')).not.toThrow();
  });

  it('wertet NUR die ausdrückliche 0 als Abschaltung — wie der MailService', () => {
    // Wichtig, dass beide Stellen dieselbe Lesart haben: würde der Wächter
    // strenger lesen als der MailService, bräche der Start bei Werten ab, die
    // gar nichts abschalten.
    for (const value of ['false', 'nein', 'off', '00', ' 0']) {
      expect(() => checkTlsRequirement('production', value)).not.toThrow();
    }
  });

  it('LÄSST DIE LOKALE ENTWICKLUNG DURCH — sonst startet der Docker-Stack nicht', () => {
    // Genau der Fall aus docker-compose.yml: Mailpit spricht kein STARTTLS.
    expect(() => checkTlsRequirement('development', '0')).not.toThrow();
    expect(() => checkTlsRequirement(undefined, '0')).not.toThrow();
    expect(() => checkTlsRequirement('test', '0')).not.toThrow();
  });
});
