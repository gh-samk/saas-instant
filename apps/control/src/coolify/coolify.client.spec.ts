import { CoolifyHttpClient, domainsFrom, listFrom } from './coolify.client';
import { CONTRACT_PRESET, type CoolifyConfig } from './coolify.config';

const CONFIG: CoolifyConfig = {
  ...CONTRACT_PRESET,
  apiUrl: 'https://coolify.test/api/v1',
  token: 'geheim',
  projectUuid: 'p',
  serverUuid: 's',
  deployKeyUuid: 'k',
  repository: 'git@example:repo.git',
  branch: 'main',
  composePath: '/docker-compose.coolify.yml',
  environmentName: 'production',
  baseDomain: 'example.com',
  ownApplications: [],
  instanceSmtp: null,
};

function withResponse(status: number, body: unknown): CoolifyHttpClient {
  globalThis.fetch = jest.fn().mockResolvedValue({
    status,
    ok: status >= 200 && status < 300,
    text: () => Promise.resolve(JSON.stringify(body)),
  }) as never;
  return new CoolifyHttpClient(CONFIG);
}

describe('listFrom — welche Antwortformen als Liste gelten ([K2])', () => {
  it('liest das nackte Array', () => {
    expect(listFrom([{ uuid: 'a' }])).toEqual([{ uuid: 'a' }]);
    expect(listFrom([])).toEqual([]);
  });

  it('liest die paginierte Form `{ data: [...] }`', () => {
    expect(listFrom({ data: [{ uuid: 'a' }] })).toEqual([{ uuid: 'a' }]);
    expect(listFrom({ data: [] })).toEqual([]);
  });

  it('gibt für jede andere Form null zurück — das ist ein Ausfall', () => {
    expect(listFrom(null)).toBeNull();
    expect(listFrom('etwas')).toBeNull();
    expect(listFrom({ items: [] })).toBeNull();
    expect(listFrom({ message: 'Unauthenticated.' })).toBeNull();
    expect(listFrom({ data: { uuid: 'a' } })).toBeNull();
  });
});

describe('applications() — eine unerwartete Form ist kein leerer Bestand', () => {
  const oldFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = oldFetch;
  });

  it('liest die Liste aus dem nackten Array', async () => {
    const client = withResponse(200, [
      {
        uuid: 'u1',
        name: 'instanz-musterverein',
        status: 'running',
        docker_compose_domains: [{ name: 'web', domain: 'https://musterverein.example.com' }],
      },
    ]);

    const applications = await client.applications();

    expect(applications).toHaveLength(1);
    expect(applications[0].domains).toContain('musterverein.example.com');
  });

  it('liest die Liste auch aus der paginierten Form', async () => {
    const client = withResponse(200, {
      data: [
        {
          uuid: 'u1',
          name: 'instanz-musterverein',
          status: 'running',
          docker_compose_domains: '[{"name":"web","domain":"https://musterverein.example.com"}]',
        },
      ],
    });

    const applications = await client.applications();

    expect(applications).toHaveLength(1);
    expect(applications[0].domains).toContain('musterverein.example.com');
  });

  it('WIRFT bei einer unbekannten Form, statt einen leeren Bestand zu melden', async () => {
    // DER FALL, DER DEN DATENVERLUST ERZEUGT HÄTTE: 200, aber keine Liste.
    // Eine leere Liste hiesse „die Subdomain ist frei" — und das Anlegen
    // überschriebe ein bestehendes Deployment.
    const client = withResponse(200, { message: 'Unauthenticated.' });

    await expect(client.applications()).rejects.toThrow(/keine lesbare Liste/);
  });

  it('wirft auch bei einer leeren Antwort', async () => {
    globalThis.fetch = jest.fn().mockResolvedValue({
      status: 200,
      ok: true,
      text: () => Promise.resolve(''),
    }) as never;
    const client = new CoolifyHttpClient(CONFIG);

    await expect(client.applications()).rejects.toThrow(/keine lesbare Liste/);
  });

  it('meldet eine wirklich leere Liste als leer — kein Fehlalarm', async () => {
    const client = withResponse(200, []);
    await expect(client.applications()).resolves.toEqual([]);
  });
});

describe('domainsFrom', () => {
  it('liest Domänen aus Liste, Objekt und JSON-Zeichenkette', () => {
    expect(domainsFrom([{ domain: 'https://a.example.com' }])).toContain(
      'a.example.com',
    );
    expect(domainsFrom('[{"domain":"https://b.example.com"}]')).toContain(
      'b.example.com',
    );
    expect(domainsFrom(null)).toEqual([]);
  });
});

/**
 * Regressionstest: Coolify hat den Stop-Endpunkt von GET auf POST umgestellt.
 * Gegen 4.3.17 antwortet ein GET mit 405 („This endpoint has changed to a POST
 * request") — das Archivieren waere still gescheitert. Es ist neben dem
 * Anlegen die einzige erlaubte Schreiboperation gegen eine Kundeninstanz (R1).
 */
describe('stopApplication spricht POST', () => {
  it('ruft den Stop-Endpunkt mit POST auf, nicht mit GET', async () => {
    const client = withResponse(200, {});
    await client.stopApplication('abc123');

    const [url, options] = (globalThis.fetch as jest.Mock).mock.calls[0] as [
      string,
      { method: string },
    ];
    expect(options.method).toBe('POST');
    expect(url).toContain('/applications/abc123/stop');
  });
});

describe('setEnvironmentVariable — anlegen, und wenn es sie schon gibt: ändern', () => {
  const oldFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = oldFetch;
  });

  function withOutcome(...respond: { status: number; body: unknown }[]) {
    const fetchMock = jest.fn();
    for (const a of respond) {
      fetchMock.mockResolvedValueOnce({
        status: a.status,
        ok: a.status >= 200 && a.status < 300,
        text: () => Promise.resolve(JSON.stringify(a.body)),
      });
    }
    globalThis.fetch = fetchMock as never;
    return { client: new CoolifyHttpClient(CONFIG), fetchMock };
  }

  it('legt per POST an, wenn es die Variable noch nicht gibt — und nur das', async () => {
    const { client, fetchMock } = withOutcome({ status: 201, body: { uuid: 'e1' } });
    await client.setEnvironmentVariable('app', 'SMTP_HOST', 'mail.test');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][1].method).toBe('POST');
  });

  it('ändert per PATCH, wenn Coolify „gibt es schon" (409) antwortet', async () => {
    const sha = 'a'.repeat(40);
    const { client, fetchMock } = withOutcome(
      { status: 409, body: { message: 'Environment variable already exists. Use PATCH request to update it.' } },
      { status: 201, body: { uuid: 'e1' } },
    );
    await client.setEnvironmentVariable('app', 'SOURCE_COMMIT', sha);
    expect(fetchMock.mock.calls.map((c) => c[1].method)).toEqual(['POST', 'PATCH']);
    expect(JSON.parse(fetchMock.mock.calls[1][1].body)).toEqual({
      key: 'SOURCE_COMMIT',
      value: sha,
      is_preview: false,
    });
  });

  it('wirft bei jedem anderen Fehler, statt still weiterzumachen', async () => {
    const { client } = withOutcome({ status: 422, body: { message: 'kaputt' } });
    await expect(client.setEnvironmentVariable('app', 'X', 'y')).rejects.toThrow(/422/);
  });
});

describe('getDeployment liefert den ausgecheckten Commit', () => {
  const oldFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = oldFetch;
  });

  it('übernimmt einen echten Commit', async () => {
    const sha = 'a09027da1a6a6cb1b5e9df60dfa2373d92967b17';
    const client = withResponse(200, { status: 'finished', commit: sha });
    expect(await client.getDeployment('d1')).toEqual({ uuid: 'd1', status: 'finished', commit: sha });
  });

  it.each(['HEAD', '', null, 'abc123'])('macht aus %p keinen Commit', async (value) => {
    const client = withResponse(200, { status: 'finished', commit: value });
    expect((await client.getDeployment('d1')).commit).toBeNull();
  });
});
