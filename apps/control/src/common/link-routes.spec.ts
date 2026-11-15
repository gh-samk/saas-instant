import { PATH_METADATA } from '@nestjs/common/constants';
import { ConsentPublicController } from '../consent/consent-public.controller';
import { IntakePublicController } from '../intake/intake-public.controller';
import { ConsentService } from '../consent/consent.service';
import { stepPage } from '../intake/form-pages';
import { maskUrl } from './log-masking';

/**
 * Links aus Mails und Formularen muessen auf REGISTRIERTE Routen zeigen und
 * dort vom Log maskiert werden. Ein alter Pfad liefert 404 und legt den Token
 * unmaskiert ins Log.
 */
function routes(controller: new (...a: never[]) => unknown): string[] {
  const prefix = Reflect.getMetadata(PATH_METADATA, controller) as string;
  return Object.getOwnPropertyNames(controller.prototype)
    .map((n) => Reflect.getMetadata(PATH_METADATA, controller.prototype[n]))
    .filter((p): p is string => typeof p === 'string')
    .map((p) => `/api/${prefix}/${p}`.replace(/\/+$/, ''));
}

function matches(route: string, url: string): boolean {
  const re = new RegExp(`^${route.replace(/:[^/]+/g, '[^/]+')}$`);
  return re.test(url);
}

describe('Links gegen registrierte Routen', () => {
  const consent = routes(ConsentPublicController as never);
  const intake = routes(IntakePublicController as never);
  const service = Object.create(ConsentService.prototype) as ConsentService;
  service.baseUrl = () => 'https://verwaltung.example';

  it.each(['confirmationLink', 'unsubscribeLink'] as const)(
    '%s trifft eine Route und wird maskiert',
    (name) => {
      const path = new URL(service[name]('GEHEIM')).pathname;
      expect(consent.some((r) => matches(r, path))).toBe(true);
      expect(maskUrl(path)).not.toContain('GEHEIM');
    },
  );

  it('die action des Aufnahmeformulars trifft eine Route und wird maskiert', () => {
    const html = stepPage({ step: 1, token: 'GEHEIM', companyName: 'X', inputs: {} });
    const actions = [...html.matchAll(/action="([^"]+)"/g)].map((m) => m[1]!);
    expect(actions.length).toBeGreaterThan(0);
    for (const a of actions) {
      expect(intake.some((r) => matches(r, a))).toBe(true);
      expect(maskUrl(a)).not.toContain('GEHEIM');
    }
  });
});
