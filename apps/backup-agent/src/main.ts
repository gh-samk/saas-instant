import { loadConfig } from './config.js';
import { createApp } from './app.js';
import { ResilientControlClient } from './control-cache.js';
import { HttpControlClient } from './control-client.js';
import { localPgDump } from './control-dump.js';
import { DockerodeClient, dockerFromEnv } from './docker/dockerode.js';
import { controlInvoiceSource } from './invoices-http.js';
import { Redactor, createLogger } from './log.js';
import { StateStore } from './state.js';
import { defaultStorageFactory } from './storage/index.js';

async function main(): Promise<void> {
  const cfg = loadConfig();
  const redactor = new Redactor();
  for (const s of [cfg.secret, cfg.stateKey, cfg.reportKey, cfg.controlDatabaseUrl]) redactor.add(s);
  if (cfg.controlDatabaseUrl) {
    try {
      redactor.add(decodeURIComponent(new URL(cfg.controlDatabaseUrl).password));
    } catch {
      /* URL nicht parsebar: wird beim Dump gemeldet */
    }
  }
  const log = createLogger(redactor);
  const dbUrl = cfg.controlDatabaseUrl;
  const noDb = () => {
    throw new Error('CONTROL_DATABASE_URL ist nicht gesetzt');
  };

  const store = new StateStore(cfg.stateDir, cfg.stateKey);
  // Merkt sich den letzten gueltigen Plan und haelt Meldungen vor, solange die Verwaltung nicht antwortet.
  const control = new ResilientControlClient(new HttpControlClient(cfg.controlUrl, cfg.reportKey, fetch, { log }), store, log, redactor);
  const app = await createApp({
    secret: cfg.secret,
    version: cfg.version,
    workDir: cfg.workDir,
    invoiceRetentionYears: cfg.invoiceRetentionYears,
    extraOwnProjects: cfg.extraOwnProjects,
    deniedProjects: cfg.deniedProjects,
    jobTimeoutMs: cfg.jobTimeoutMs,
    docker: new DockerodeClient(dockerFromEnv(cfg.dockerHost)),
    control,
    store,
    storageFactory: defaultStorageFactory,
    redactor,
    log,
    controlDump: (signal) => (dbUrl ? localPgDump(dbUrl, signal) : noDb()),
    invoices: () => controlInvoiceSource(control),
  });
  app.scheduler.start();
  app.server.listen(cfg.port, '0.0.0.0', () => log.info('backup-agent gestartet', { port: cfg.port, version: cfg.version }));

  const stop = () => {
    app.scheduler.stop();
    app.server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 5000).unref();
  };
  process.on('SIGTERM', stop);
  process.on('SIGINT', stop);
}

main().catch((e: unknown) => {
  // Fehlertext ohne Werte: loadConfig nennt nur Variablennamen.
  process.stderr.write(`Start fehlgeschlagen: ${e instanceof Error ? e.message : 'unbekannt'}\n`);
  process.exit(1);
});
