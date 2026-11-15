import { Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { MailService } from './mail.service';

/**
 * F6: Der Anmeldecode ist der zweite Faktor. Ohne SMTP_HOST darf er nur
 * außerhalb der Produktion im Log erscheinen, in der Produktion nie.
 */
function service(env: Record<string, string | undefined>): MailService {
  return new MailService({
    get: (key: string, defaultValue?: string) => env[key] ?? defaultValue,
  } as unknown as ConfigService);
}

describe('Anmeldecode im Log', () => {
  const CODE = '48151623';
  let lines: string[];

  beforeEach(() => {
    lines = [];
    const collect = (message: unknown) => {
      lines.push(String(message));
    };
    jest.spyOn(Logger.prototype, 'log').mockImplementation(collect);
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(collect);
    jest.spyOn(Logger.prototype, 'error').mockImplementation(collect);
  });
  afterEach(() => jest.restoreAllMocks());

  it('loggt den Code ohne SMTP_HOST in der Entwicklung', async () => {
    await service({ NODE_ENV: 'development' }).sendLoginCode(
      'a@example.com',
      CODE,
      10,
      false,
    );
    expect(lines.some((l) => l.includes(CODE))).toBe(true);
  });

  it('loggt den Code ohne SMTP_HOST in der PRODUKTION nie', async () => {
    await service({ NODE_ENV: 'production' }).sendLoginCode(
      'a@example.com',
      CODE,
      10,
      false,
    );
    expect(lines.join('\n')).not.toContain(CODE);
  });
});
