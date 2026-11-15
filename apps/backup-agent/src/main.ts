import { loadConfig } from './config.js';
import { createApp } from './app.js';
import { HttpControlClient } from './control-client.js';
import { localPgDump } from './control-dump.js';
import { DockerodeClient, dockerFromEnv } from './docker/dockerode.js';
import { pgInvoiceSource } from './invoices-pg.js';
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

  const app = await createApp({
    secret: cfg.secret,
    version: cfg.version,
    workDir: cfg.workDir,
    invoiceRetentionYears: cfg.invoiceRetentionYears,
    extraOwnProjects: cfg.extraOwnProjects,
    docker: new DockerodeClient(dockerFromEnv(cfg.dockerHost)),
    control: new HttpControlClient(cfg.controlUrl, cfg.reportKey),
    store: new StateStore(cfg.stateDir, cfg.stateKey),
    storageFactory: defaultStorageFactory,
    redactor,
    log,
    controlDump: () => (dbUrl ? localPgDump(dbUrl) : noDb()),
    invoices: () => (dbUrl ? pgInvoiceSource(dbUrl) : noDb()),
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
