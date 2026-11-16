import path from 'node:path';

export interface AgentConfig {
  port: number;
  secret: string;
  stateKey: string;
  stateDir: string;
  workDir: string;
  reportKey: string;
  controlUrl: string;
  controlDatabaseUrl: string | undefined;
  dockerHost: string;
  extraOwnProjects: string[];
  invoiceRetentionYears: number;
  version: string;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AgentConfig {
  const need = (name: string, minLen = 16): string => {
    const v = env[name];
    if (!v || v.length < minLen) throw new Error(`${name} fehlt oder ist zu kurz`);
    return v;
  };
  const stateDir = env['STATE_DIR'] ?? '/state';
  return {
    port: Number(env['PORT'] ?? 8787),
    secret: need('BACKUP_AGENT_SECRET', 32),
    stateKey: need('AGENT_STATE_KEY', 32),
    stateDir,
    workDir: env['WORK_DIR'] ?? path.join(stateDir, 'work'),
    reportKey: env['BACKUP_REPORT_KEY'] ?? '',
    controlUrl: (env['CONTROL_URL'] ?? 'http://control-api:3001').replace(/\/+$/, ''),
    controlDatabaseUrl: env['CONTROL_DATABASE_URL'] || undefined,
    dockerHost: env['DOCKER_HOST'] ?? 'tcp://docker-socket-proxy:2375',
    extraOwnProjects: [env['AGENT_COMPOSE_PROJECT'], env['CONTROL_COMPOSE_PROJECT']].filter((x): x is string => !!x),
    invoiceRetentionYears: Number(env['INVOICE_RETENTION_YEARS'] ?? 10),
    version: env['AGENT_VERSION'] ?? '1.1.0',
  };
}
