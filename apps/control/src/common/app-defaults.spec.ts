import { readFileSync } from 'fs';
import { join } from 'path';
import { APP_NAME_DEFAULT, APP_URL_DEFAULT } from './app-defaults';

describe('Vorgaben im Code stimmen mit docker-compose.yml überein', () => {
  const compose = readFileSync(
    join(__dirname, '..', '..', '..', '..', 'docker-compose.yml'),
    'utf8',
  );

  it.each([
    ['CONTROL_APP_URL', APP_URL_DEFAULT],
    ['CONTROL_RP_NAME', APP_NAME_DEFAULT],
    ['CONTROL_TOTP_ISSUER', APP_NAME_DEFAULT],
  ])('%s', (name, preset) => {
    expect(compose).toContain(`${name}: \${${name}:-${preset}}`);
  });
});
