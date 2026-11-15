import { setUpFactors } from '../auth/factors';

/**
 * Regressionstests zum Befund A.9: Ein eingetragenes Konto bekam ein Passwort,
 * aber keinen zweiten Faktor. Die Anmeldung verlangt nach dem Passwort einen
 * zweiten Faktor, und alle Wege, einen einzurichten, liegen hinter dem
 * SitzungGuard. Ohne Sitzung kein Faktor, ohne Faktor keine Sitzung —
 * eingeladene Menschen kamen nie hinein.
 *
 * Diese Tests halten die Bedingung fest, an der das hing. Der vollständige
 * Durchlauf steht in benutzer.integration.spec.ts (braucht eine Datenbank).
 */
describe('Anmeldefähigkeit eines frisch eingetragenen Kontos', () => {
  it('ohne jeden Faktor bleibt die Auswahl leer — die Sackgasse', () => {
    expect(
      setUpFactors({
        loginCodeEnabled: false,
        totpSecret: null,
        passkeyCount: 0,
      }),
    ).toEqual([]);
  });

  it('mit aktivem E-Mail-Code steht genau ein Weg offen', () => {
    expect(
      setUpFactors({
        loginCodeEnabled: true,
        totpSecret: null,
        passkeyCount: 0,
      }),
    ).toEqual(['email-code']);
  });

  it('the invite creation sets loginCodeEnabled — sonst ist das Konto unbenutzbar', () => {
    // Die Absicht am Quelltext festgehalten: Wer die Zeile entfernt, macht
    // eingeladene Konten wieder unbenutzbar.
    const source = require('fs').readFileSync(
      require('path').join(__dirname, 'user.service.ts'),
      'utf8',
    ) as string;
    const createBlock = source.slice(
      source.indexOf('const user = await this.prisma.user.create('),
      source.indexOf('const link = await this.emergency.generateLink('),
    );
    expect(createBlock).toContain('loginCodeEnabled: true');
  });
});
