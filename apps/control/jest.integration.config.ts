import type { Config } from 'jest';

/**
 * Integrationstests gegen eine ECHTE Postgres-Datenbank.
 *
 * Nötig für alles, was sich mit einer In-Memory-Attrappe nicht belegen lässt —
 * allen voran die Rennfestigkeit des Sperrzählers: JavaScript ist einfädig,
 * ein Rennen kann dort gar nicht entstehen.
 *
 * Start:  docker compose --profile control up -d control-db
 *         DATABASE_URL=… pnpm --filter @saas-instant/control test:integration
 */
const config: Config = {
  moduleFileExtensions: ['js', 'json', 'ts'],
  rootDir: '.',
  testMatch: ['<rootDir>/src/**/*.integration.spec.ts'],
  transform: {
    '^.+\\.(t|j)s$': ['ts-jest', { tsconfig: 'tsconfig.json' }],
  },
  testEnvironment: 'node',
  // Tresor der Test-Datenbank einrichten und entsperren (Feldverschlüsselung).
  setupFilesAfterEnv: ['<rootDir>/src/test-support/integration-setup.ts'],
  // Die Suiten teilen sich eine Datenbank — strikt seriell, damit sie sich
  // nicht gegenseitig die Zählerstände verfälschen.
  maxWorkers: 1,
};

export default config;
