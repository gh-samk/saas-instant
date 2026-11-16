import type { Config } from 'jest';

const config: Config = {
  moduleFileExtensions: ['js', 'json', 'ts'],
  rootDir: '.',
  testMatch: ['<rootDir>/src/**/*.spec.ts'],
  // Integrationstests brauchen eine echte Datenbank und laufen getrennt.
  testPathIgnorePatterns: ['\\.integration\\.spec\\.ts$'],
  transform: { '^.+\\.ts$': ['ts-jest', { tsconfig: 'tsconfig.pruefung.json' }] },
  testEnvironment: 'node',
};

export default config;
