import { getSetupStatusViaHttp, setupStatusFrom } from './setup-status';

/**
 * Die Setup-Auskunft einer Instanz entscheidet, ob der Einrichtungslink
 * verschwindet. Deshalb zählt nur ein ECHTES `false` als „eingerichtet" —
 * alles andere ist „unbekannt" und ändert nichts.
 */
describe('setupStatusFrom — nur ein echtes boolean zählt', () => {
  it.each<[unknown, string]>([
    [{ benoetigtSetup: false }, 'configured'],
    [{ benoetigtSetup: true }, 'open'],
    [{ benoetigtSetup: 'false' }, 'unknown'],
    [{ benoetigtSetup: 0 }, 'unknown'],
    [{}, 'unknown'],
    [null, 'unknown'],
    ['kein Objekt', 'unknown'],
  ])('%p → %s', (raw, expected) => {
    expect(setupStatusFrom(raw)).toBe(expected);
  });
});

describe('getSetupStatusViaHttp — ein Ausfall ist „unbekannt"', () => {
  const real = global.fetch;
  afterEach(() => {
    global.fetch = real;
  });

  it('liest eine gewöhnliche Antwort', async () => {
    global.fetch = jest.fn().mockResolvedValue(
      new Response(JSON.stringify({ benoetigtSetup: false }), { status: 200 }),
    ) as never;
    expect(await getSetupStatusViaHttp('https://x.test/api/setup/status', 1000)).toBe(
      'configured',
    );
  });

  it('liest einen Fehlerstatus als „unbekannt", nicht als „offen"', async () => {
    global.fetch = jest.fn().mockResolvedValue(new Response('', { status: 502 })) as never;
    expect(await getSetupStatusViaHttp('https://x.test/api/setup/status', 1000)).toBe(
      'unknown',
    );
  });

  it('liest einen Netzfehler als „unbekannt"', async () => {
    global.fetch = jest.fn().mockRejectedValue(new Error('ECONNREFUSED')) as never;
    expect(await getSetupStatusViaHttp('https://x.test/api/setup/status', 1000)).toBe(
      'unknown',
    );
  });
});
