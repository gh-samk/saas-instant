import 'reflect-metadata';
import { GUARDS_METADATA, HEADERS_METADATA } from '@nestjs/common/constants';
import { FlagPublicController } from './flag-public.controller';

/**
 * Die öffentliche Schalterroute: anonym, nicht zwischenspeicherbar, und sie
 * gibt genau das weiter, was der Dienst liefert.
 */
describe('SchalterOeffentlichController', () => {
  it('hängt an keinem Guard — die Instanzen haben kein Konto', () => {
    expect(Reflect.getMetadata(GUARDS_METADATA, FlagPublicController)).toBeUndefined();
    expect(
      Reflect.getMetadata(GUARDS_METADATA, FlagPublicController.prototype.state),
    ).toBeUndefined();
  });

  it('verbietet jedes Zwischenspeichern der Antwort', () => {
    const header = Reflect.getMetadata(
      HEADERS_METADATA,
      FlagPublicController.prototype.state,
    ) as { name: string; value: string }[];
    expect(header).toContainEqual({ name: 'Cache-Control', value: 'no-store' });
  });

  it('reicht den Stand des Dienstes unverändert durch', async () => {
    const service = { publicState: jest.fn().mockResolvedValue({ feedback: false }) };
    const controller = new FlagPublicController(service as never);
    await expect(controller.state()).resolves.toEqual({ feedback: false });
  });
});
