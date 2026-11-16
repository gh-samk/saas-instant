import type { Config } from 'jest';

/** Integrationstests gegen eine ECHTE Postgres-Datenbank (portal_auth_test). */
const config: Config = {
  moduleFileExtensions: ['js', 'json', 'ts'],
  rootDir: '.',
  testMatch: ['<rootDir>/src/**/*.integration.spec.ts'],
  transform: { '^.+\\.ts$': ['ts-jest', { tsconfig: 'tsconfig.pruefung.json' }] },
  testEnvironment: 'node',
  // Die Suiten teilen sich eine Datenbank: strikt seriell.
  maxWorkers: 1,
  testTimeout: 60_000,
};

export default config;
