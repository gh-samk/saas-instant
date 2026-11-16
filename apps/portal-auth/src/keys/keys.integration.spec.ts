import { FieldCrypto } from '../common/field-crypto';
import { KeysService } from './keys.service';
import { Harness, newPkce } from '../test-support/harness';

describe('Signaturschlüssel (echte Datenbank)', () => {
  const h = new Harness();
  let client: Awaited<ReturnType<Harness['client']>>;
  beforeAll(async () => {
    await h.start();
    client = await h.client(`key-${h.runId}`);
  });
  afterAll(async () => {
    await h.prisma.oidcClient.deleteMany({ where: { id: client.id } });
    await h.cleanup();
    await h.stop();
  });

  async function issueToken(): Promise<string> {
    const acc = await h.account({ roles: { [client.id]: 'admin' } });
    const b = h.browser();
    await h.login(b, acc);
    const pkce = newPkce();
    const hit = await b.get(h.authorizePath(client, pkce).path);
    const { code } = h.codeFrom(hit.location, client);
    return (await h.tokenRequest(b, client, code, pkce.verifier)).body.id_token as string;
  }

  it('der private Schlüssel liegt verschlüsselt in der Datenbank und nur mit PORTAL_KEY_SECRET lesbar', async () => {
    const rows = await h.prisma.signingKey.findMany();
    expect(rows.length).toBeGreaterThanOrEqual(1);
    for (const row of rows) {
      expect(row.privateEnc.startsWith('v1.')).toBe(true);
      expect(row.privateEnc).not.toContain('PRIVATE KEY');
      expect(new FieldCrypto(h.secret).decrypt(row.privateEnc)).toContain('BEGIN PRIVATE KEY');
      expect(() => new FieldCrypto('ein-ganz-anderes-geheimnis-0123456789abcdef').decrypt(row.privateEnc)).toThrow();
    }
  });

  it('Rotation: altes Token bleibt prüfbar, neue Token tragen die neue kid, abgelaufener Schlüssel verschwindet', async () => {
    const before = await issueToken();
    const kidBefore = JSON.parse(Buffer.from(before.split('.')[0], 'base64url').toString()).kid as string;

    const result = await h.app.get(KeysService).rotate();
    expect(result.retiredKids).toContain(kidBefore);
    expect(result.newKid).not.toBe(kidBefore);

    const after = await issueToken();
    const kidAfter = JSON.parse(Buffer.from(after.split('.')[0], 'base64url').toString()).kid as string;
    expect(kidAfter).toBe(result.newKid);

    const jwks = await h.jwks();
    const kids = jwks.keys.map((k) => k.kid);
    expect(kids).toEqual(expect.arrayContaining([kidBefore, kidAfter]));
    expect((await h.verifyIdToken(before, client.id)).kid).toBe(kidBefore);
    expect((await h.verifyIdToken(after, client.id)).kid).toBe(kidAfter);

    // Ablauf des ausgemusterten Schlüssels: er verlässt das JWKS.
    await h.prisma.signingKey.update({ where: { kid: kidBefore }, data: { expiresAt: new Date(Date.now() - 1000) } });
    const later = (await h.jwks()).keys.map((k) => k.kid);
    expect(later).not.toContain(kidBefore);
    expect(later).toContain(kidAfter);
    await expect(h.verifyIdToken(before, client.id)).rejects.toThrow();
  });
});
