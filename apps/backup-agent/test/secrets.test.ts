import { describe, expect, it } from 'vitest';
import { Redactor, createLogger } from '../src/log.js';
import { S3_KEY_ID, S3_SECRET, SECRET, STATE_KEY, instance, s3Body, startHarness } from './helpers.js';

describe('Logging ohne Geheimnisse', () => {
  it('Redactor maskiert registrierte Werte, age-Schluessel, PEM, URL-Passwoerter und sensible Felder', () => {
    const r = new Redactor();
    r.add('mein-geheimer-wert');
    const lines: string[] = [];
    const log = createLogger(r, (l) => lines.push(l));
    log.info('x mein-geheimer-wert AGE-SECRET-KEY-1QQQQQQQQQQQQQQQQQQQQQQQQQQ', {
      url: 'postgresql://user:passw0rtXY@host:5432/db',
      pem: '-----BEGIN OPENSSH PRIVATE KEY-----\nabc\n-----END OPENSSH PRIVATE KEY-----',
      password: 'klartext',
      nested: { secretAccessKey: 'abc', ok: 'sichtbar mein-geheimer-wert' },
      objectKey: 'a/b',
    });
    const out = lines.join('\n');
    for (const bad of ['mein-geheimer-wert', 'AGE-SECRET-KEY-1QQQ', 'passw0rtXY', 'BEGIN OPENSSH', 'klartext', '"abc"']) expect(out).not.toContain(bad);
    expect(out).toContain('sichtbar');
    expect(out).toContain('a/b');
  });

  it('ueber den ganzen Ablauf tauchen Geheimnisse weder in Logs noch in Antworten auf', async () => {
    const h = await startHarness();
    try {
      const all: string[] = [];
      const put = await h.call('PUT', '/v1/target', s3Body());
      const identity = put.json.ageIdentity as string;
      all.push((await h.call('GET', '/v1/target')).text, (await h.call('GET', '/v1/health')).text);
      h.docker.add({ id: 'd', project: 'p', service: 'db', running: true, db: 'x' });
      const j = await h.call('POST', '/v1/jobs', { kind: 'backup', instance: instance({ composeProject: 'p', uploadsService: undefined, uploadsPath: undefined }) });
      await h.app.queue.whenIdle();
      all.push(JSON.stringify(h.app.queue.get(j.json.jobId)));
      // Fehlerfall mit Geheimnis im Fehlertext: fehlerhafter Schluessel/Anfrage
      await h.call('PUT', '/v1/target', s3Body({ retentionDays: -1 }));
      await fetch(h.base + '/v1/target'); // unsigniert
      all.push(h.logs.join('\n'));
      const joined = all.join('\n');
      for (const secret of [S3_SECRET, S3_KEY_ID, SECRET, STATE_KEY, identity]) expect(joined).not.toContain(secret);
      expect(h.logs.length).toBeGreaterThan(0);
    } finally {
      await h.close();
    }
  });

  it('ein Geheimnis im Fehlertext eines Jobs wird geschwaerzt', async () => {
    const h = await startHarness();
    try {
      await h.call('PUT', '/v1/target', s3Body());
      h.app.targets.current()!.storage.put = async () => {
        throw new Error(`Zugriff verweigert fuer ${S3_SECRET} und ${S3_KEY_ID}`);
      };
      h.docker.add({ id: 'd', project: 'p', service: 'db', running: true, db: 'x' });
      const j = await h.call('POST', '/v1/jobs', { kind: 'backup', instance: instance({ composeProject: 'p', uploadsService: undefined, uploadsPath: undefined }) });
      await h.app.queue.whenIdle();
      const rec = h.app.queue.get(j.json.jobId)!;
      expect(rec.status).toBe('failed');
      expect(rec.message).not.toContain(S3_SECRET);
      expect(rec.message).not.toContain(S3_KEY_ID);
    } finally {
      await h.close();
    }
  });
});
