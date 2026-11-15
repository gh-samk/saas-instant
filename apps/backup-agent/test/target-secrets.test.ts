import { afterEach, describe, expect, it } from 'vitest';
import { FakeStorage } from '../src/storage/fake.js';
import { BOX_FP, BOX_PASSWORD, S3_KEY_ID, S3_SECRET, boxBody, s3Body, startHarness, type Harness } from './helpers.js';

class PinStorage extends FakeStorage {
  fp: string | undefined = BOX_FP;
  observedHostKey() {
    return this.fp;
  }
}

let h: Harness;
afterEach(() => h.close());

describe('PUT /v1/target: Geheimfelder optional', () => {
  it('S3: fehlende Geheimnisse bleiben aus dem gespeicherten Ziel erhalten', async () => {
    h = await startHarness();
    expect((await h.call('PUT', '/v1/target', s3Body())).status).toBe(200);
    const body = s3Body({ retentionDays: 90 });
    delete (body.s3 as Record<string, unknown>).secretAccessKey;
    delete (body.s3 as Record<string, unknown>).accessKeyId;
    expect((await h.call('PUT', '/v1/target', body)).status).toBe(200);
    const cur = h.app.targets.current()!.target;
    expect(cur.s3!.secretAccessKey).toBe(S3_SECRET);
    expect(cur.s3!.accessKeyId).toBe(S3_KEY_ID);
    expect(cur.retentionDays).toBe(90);
  });

  it('S3: ohne gespeichertes Ziel gleichen Typs -> 400 mit klarer Meldung, ohne Werte', async () => {
    h = await startHarness();
    const body = s3Body();
    delete (body.s3 as Record<string, unknown>).secretAccessKey;
    const r = await h.call('PUT', '/v1/target', body);
    expect(r.status).toBe(400);
    expect(r.json.error).toContain('s3.secretAccessKey');
    expect(r.text).not.toContain(S3_KEY_ID);
  });

  it('Typwechsel: Geheimnisse des alten Typs werden nicht uebernommen', async () => {
    h = await startHarness();
    await h.call('PUT', '/v1/target', s3Body());
    const body = boxBody();
    delete (body.storagebox as Record<string, unknown>).password;
    const r = await h.call('PUT', '/v1/target', body);
    expect(r.status).toBe(400);
    expect(r.json.error).toContain('storagebox.password');
  });

  it('Storage Box: Passwort darf fehlen, wenn gespeichert; Wechsel der Auth-Art ohne Geheimnis -> 400', async () => {
    h = await startHarness();
    await h.call('PUT', '/v1/target', boxBody());
    const keep = boxBody();
    delete (keep.storagebox as Record<string, unknown>).password;
    expect((await h.call('PUT', '/v1/target', keep)).status).toBe(200);
    expect(h.app.targets.current()!.target.storagebox!.password).toBe(BOX_PASSWORD);
    const sw = boxBody({}, { authType: 'key', password: undefined });
    const r = await h.call('PUT', '/v1/target', sw);
    expect(r.status).toBe(400);
    expect(r.json.error).toContain('storagebox.privateKey');
  });
});

describe('SFTP-Host-Key (TOFU)', () => {
  it('Verbindungstest pinnt den gesehenen Fingerabdruck; GET zeigt ihn, aber keine Geheimnisse', async () => {
    h = await startHarness({ storage: new PinStorage() });
    await h.call('PUT', '/v1/target', boxBody());
    expect((await h.call('GET', '/v1/target')).json.hostKeyFingerprint).toBeNull();
    const t = await h.call('POST', '/v1/target/test');
    expect(t.json.ok).toBe(true);
    expect(t.json.message).toContain(BOX_FP);
    const meta = await h.call('GET', '/v1/target');
    expect(meta.json).toMatchObject({ type: 'storagebox', authType: 'password', hostKeyFingerprint: BOX_FP });
    expect(meta.text).not.toContain(BOX_PASSWORD);
    // bleibt bei erneutem PUT ohne Angabe (gleicher Host) erhalten, auch ohne Passwort
    const again = boxBody({ retentionDays: 40 });
    delete (again.storagebox as Record<string, unknown>).password;
    await h.call('PUT', '/v1/target', again);
    expect((await h.call('GET', '/v1/target')).json.hostKeyFingerprint).toBe(BOX_FP);
  });

  it('anderer Host ohne Vorgabe: Pin verfaellt; vorgegebener Fingerabdruck wird uebernommen und nicht ueberschrieben', async () => {
    const st = new PinStorage();
    h = await startHarness({ storage: st });
    await h.call('PUT', '/v1/target', boxBody());
    await h.call('POST', '/v1/target/test');
    const moved = boxBody({}, { host: 'other.example.com' });
    await h.call('PUT', '/v1/target', moved);
    expect((await h.call('GET', '/v1/target')).json.hostKeyFingerprint).toBeNull();
    const explicit = 'SHA256:' + 'B'.repeat(43);
    await h.call('PUT', '/v1/target', boxBody({}, { hostKeyFingerprint: explicit }));
    await h.call('POST', '/v1/target/test');
    expect((await h.call('GET', '/v1/target')).json.hostKeyFingerprint).toBe(explicit);
  });

  it('lehnt ein ungueltiges Fingerabdruck-Format ab', async () => {
    h = await startHarness();
    const r = await h.call('PUT', '/v1/target', boxBody({}, { hostKeyFingerprint: 'MD5:abc' }));
    expect(r.status).toBe(400);
  });

  it('GET /v1/target liefert prefix und pathStyle (S3)', async () => {
    h = await startHarness();
    await h.call('PUT', '/v1/target', s3Body());
    expect((await h.call('GET', '/v1/target')).json).toMatchObject({ prefix: 'saas', pathStyle: true });
  });
});
