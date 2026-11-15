import { InstanceController } from './instance.controller';
import { InstanceConfidentialController } from './instance-confidential.controller';
import { SessionGuard } from '../common/guards/session.guard';
import { SecondFactorGuard } from '../common/guards/second-factor.guard';
import { EVIDENCE_ALWAYS } from '../common/decorators/evidence-always.decorator';
import { invitationOpenFrom, invitationLinkFrom } from './instance.response';
import type { InstanceMetrics } from './instance.types';

function guardsFrom(target: unknown): unknown[] {
  return Reflect.getMetadata('__guards__', target as object) ?? [];
}

/**
 * Regressionstests zu A.7: Der fertige Einrichtungslink stand in der Antwort
 * von `GET :id/instanz` — hinter blosser Sitzung, ohne zweiten Faktor, ohne
 * eigene Drosselung, ohne Nachweis. Ein erbeutetes Sitzungs-Cookie haette
 * genuegt, um bei jeder noch nicht eingerichteten Kundeninstanz Administrator
 * zu werden.
 */
describe('[A.7] Schutz des Einrichtungslinks', () => {
  it('der Link liegt hinter Sitzung UND zweitem Faktor', () => {
    const guards = guardsFrom(InstanceConfidentialController);
    expect(guards).toContain(SessionGuard);
    expect(guards).toContain(SecondFactorGuard);
  });

  it('der Versand per Mail verlangt den Nachweis IMMER, auch in frischer Sitzung', () => {
    // Die Empfaengeradresse ist ohne zweiten Faktor aenderbar. Ohne diesen
    // Riegel liesse sich der Link mit einem erbeuteten Cookie an sich selbst
    // lenken — dieselbe Luecke wie [A.7], nur ueber den Postweg.
    const send = InstanceConfidentialController.prototype.invitationLinkSend;
    const reveal = InstanceConfidentialController.prototype.invitationLink;
    expect(Reflect.getMetadata(EVIDENCE_ALWAYS, send)).toEqual(expect.any(String));
    expect(Reflect.getMetadata(EVIDENCE_ALWAYS, reveal)).toEqual(expect.any(String));
  });

  it('die alltaegliche Instanzverwaltung bleibt bei der blossen Sitzung', () => {
    const guards = guardsFrom(InstanceController);
    expect(guards).toContain(SessionGuard);
    expect(guards).not.toContain(SecondFactorGuard);
  });

  it('die Detailantwort kennt kein Feld mehr, das den Link tragen koennte', () => {
    const source = require('fs').readFileSync(
      require('path').join(__dirname, 'instance.types.ts'),
      'utf8',
    ) as string;
    expect(source).not.toContain('einladungslink:');
    expect(source).toContain('invitationOpen: boolean;');
  });
});

/**
 * Die Ja/Nein-Auskunft muss GENAU dann wahr sein, wenn es auch einen Link gibt
 * — sonst bietet die Oberflaeche einen Knopf an, hinter dem nichts liegt.
 */
describe('invitationOpenFrom deckt sich mit invitationLinkFrom', () => {
  const withPersons = (count: number) =>
    ({ activePersons: { current: count } } as unknown as InstanceMetrics);

  const cases: Array<[string, Parameters<typeof invitationOpenFrom>]> = [
    ['aktiv, Geheimnis, niemand drin', ['active', withPersons(0), true, false]],
    ['aktiv, Geheimnis, schon jemand drin', ['active', withPersons(3), true, false]],
    ['aktiv, kein Geheimnis', ['active', withPersons(0), false, false]],
    ['noch im Aufbau', ['provisioning', null, true, false]],
    ['stopped', ['stopped', null, true, false]],
    ['archived', ['archived', null, true, false]],
    ['aktiv, keine Kennzahlen', ['active', null, true, false]],
    // Der vermerkte Abschluss sticht alles — auch fehlende Kennzahlen.
    ['aktiv, niemand gemeldet, aber eingerichtet', ['active', withPersons(0), true, true]],
    ['aktiv, keine Kennzahlen, eingerichtet', ['active', null, true, true]],
  ];

  it.each(cases)('%s', (_name, args) => {
    const [status, values, hasSecret, isConfigured] = args;
    const open = invitationOpenFrom(status, values, hasSecret, isConfigured);
    const link = invitationLinkFrom(
      status,
      values,
      'musterverein',
      'example.com',
      hasSecret ? 'ein-geheimnis' : null,
      isConfigured,
    );
    expect(open).toBe(link !== null);
  });
});
