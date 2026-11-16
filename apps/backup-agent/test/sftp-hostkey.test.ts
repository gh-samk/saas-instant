import { afterEach, describe, expect, it } from 'vitest';
import ssh2 from 'ssh2';
import { SftpStorage, hostKeyFingerprint } from '../src/storage/sftp.js';

const { Server, utils } = ssh2;

// Fake-SSH-Server: bietet nur den Handshake mit eigenem Host-Key; der SFTP-Teil
// fehlt bewusst (der Host-Key wird vor der Anmeldung geprueft).
function startServer(): Promise<{ port: number; fp: string; close: () => void }> {
  const kp = utils.generateKeyPairSync('ed25519');
  const pub = utils.parseKey(kp.public) as ssh2.ParsedKey;
  const fp = hostKeyFingerprint(pub.getPublicSSH());
  const server = new Server({ hostKeys: [kp.private] }, (client) => {
    client.on('authentication', (ctx) => ctx.accept());
    client.on('error', () => undefined);
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      resolve({ port: (server.address() as { port: number }).port, fp, close: () => server.close() });
    });
  });
}

const closers: (() => void)[] = [];
afterEach(() => closers.splice(0).forEach((c) => c()));

const cfg = (port: number, fp?: string) => ({
  host: '127.0.0.1', port, username: 'u', path: '/b', authType: 'password' as const, password: 'pw-test-value',
  ...(fp ? { hostKeyFingerprint: fp } : {}),
});

describe('SFTP Host-Key-Pinning', () => {
  it('Fingerabdruck hat OpenSSH-Format', async () => {
    const s = await startServer();
    closers.push(s.close);
    expect(s.fp).toMatch(/^SHA256:[A-Za-z0-9+/]{43}$/);
  });

  it('ohne Pin: jede Verbindung wird verweigert, es wird nicht einmal der Host kontaktiert', async () => {
    const s = await startServer();
    closers.push(s.close);
    const st = new SftpStorage(cfg(s.port));
    await expect(st.head('x')).rejects.toThrow(/nicht gepinnt/);
    await expect(st.put('x', Buffer.from('a'))).rejects.toThrow(/nicht gepinnt/);
    await expect(st.get('x')).rejects.toThrow(/nicht gepinnt/);
    expect(st.observedHostKey()).toBeUndefined();
  });

  it('nur im Verbindungstest (TOFU): der Fingerabdruck wird gemerkt, danach gilt wieder die Sperre', async () => {
    const s = await startServer();
    closers.push(s.close);
    const st = new SftpStorage(cfg(s.port));
    const t = st.withTofu();
    await t.head('x').catch(() => undefined); // SFTP-Teil fehlt im Fake, egal
    expect(t.observedHostKey()).toBe(s.fp);
    await expect(st.head('x')).rejects.toThrow(/nicht gepinnt/);
  });

  it('TOFU gilt nur im Verbindungstest: gleichzeitige Verbindungen der urspruenglichen Instanz akzeptieren keinen ungepinnten Schluessel', async () => {
    const s = await startServer();
    closers.push(s.close);
    const st = new SftpStorage(cfg(s.port));
    const t = st.withTofu();
    const [, , other] = await Promise.all([t.head('x').catch(() => undefined), t.head('y').catch(() => undefined), st.head('z').then(() => null, (e: Error) => e)]);
    expect(other?.message).toMatch(/nicht gepinnt/);
    expect(t.observedHostKey()).toBe(s.fp);
    expect(st.observedHostKey()).toBeUndefined();
  });

  it('TOFU: der erste gesehene Schluessel bleibt fuer den Rest des Tests verbindlich (Wechsel mitten im Test wird abgelehnt)', async () => {
    const a = await startServer();
    closers.push(a.close);
    const b = await startServer();
    closers.push(b.close);
    const base = new SftpStorage(cfg(a.port));
    const st = base.withTofu();
    await st.head('x').catch(() => undefined);
    expect(st.observedHostKey()).toBe(a.fp);
    // Dieselbe Instanz, nun spricht ein anderer Host (anderer Schluessel) am selben Ziel
    (st as unknown as { cfg: { port: number } }).cfg = { ...(st as unknown as { cfg: object }).cfg, port: b.port } as never;
    await expect(st.head('x')).rejects.toThrow(/Host-Key weicht/);
  });

  it('mit richtigem Pin: Host-Key wird akzeptiert', async () => {
    const s = await startServer();
    closers.push(s.close);
    const st = new SftpStorage(cfg(s.port, s.fp));
    const err = await st.head('x').then(() => null, (e: Error) => e);
    expect(err?.message ?? '').not.toContain('Host-Key');
    expect(st.observedHostKey()).toBe(s.fp);
  });

  it('mit abweichendem Pin: Verbindung abgelehnt, klare Meldung', async () => {
    const s = await startServer();
    closers.push(s.close);
    const wrong = 'SHA256:' + 'C'.repeat(43);
    const st = new SftpStorage(cfg(s.port, wrong));
    await expect(st.head('x')).rejects.toThrow(/Host-Key weicht vom gespeicherten Fingerabdruck ab.*abgelehnt/);
    await expect(st.get('x')).rejects.toThrow(/Host-Key weicht/);
  });
});

