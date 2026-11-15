import { Test } from '@nestjs/testing';

/**
 * DIE UNTERGRENZE: LÄSST SICH DIE ANWENDUNG ÜBERHAUPT ZUSAMMENSETZEN?
 *
 * WAS OHNE DIESEN TEST PASSIERT IST ([K6]): Etappe 3 ging mit 419 grünen Unit-
 * und 145 grünen Integrationstests aus der Hand — und die Anwendung startete
 * nicht. `InstanzAufbauService` hatte Konstruktorparameter mit
 * TypeScript-Vorgabewert; NestJS kennt Vorgabewerte nicht, `design:paramtypes`
 * emittiert für einen Funktions-Typalias schlicht `Function`, und der Injector
 * brach beim Hochfahren ab. Der Container lief in einer Neustartschleife.
 *
 * KEIN EINZIGER TEST HAT DAS BEMERKT, weil kein Test das `AppModule`
 * compilierte: Jede Suite baute ihre Dienste selbst mit `new`, und dabei
 * greifen Vorgabewerte ganz normal. Die Tests prüften also eine Bauweise, die
 * es im Betrieb nicht gibt.
 *
 * Dieser Test schliesst die Lücke. Er ist billig (er stellt keine
 * Datenbankverbindung her — `compile()` ruft keine Lebenszyklus-Haken) und
 * findet jeden Verdrahtungsfehler in Sekunden: fehlender Provider, fehlender
 * Import, nicht auflösbarer Typ, Ringschluss zwischen Modulen.
 *
 * ER GILT AB JETZT ALS UNTERGRENZE JEDER ETAPPE. Was sich nicht zusammensetzen
 * lässt, läuft nicht — und dann ist alles andere Makulatur.
 */

/** Die Umgebung, ohne die die Anwendung bewusst gar nicht erst startet. */
const REQUIRED_ENVIRONMENT: Record<string, string> = {
  DATABASE_URL: 'postgresql://niemand:niemand@localhost:1/niemand?schema=public',
  JWT_SECRET: 'test-jwt-geheimnis',
  CONTROL_CONFIG_KEY: 'test-schluessel-mindestens-32-zeichen-lang-x',
  CONTROL_APP_URL: 'http://localhost:5174',
  CONTROL_RP_ID: 'localhost',
  NODE_ENV: 'test',
};

describe('AppModule lässt sich zusammensetzen', () => {
  const before = { ...process.env };

  beforeAll(() => {
    for (const [name, value] of Object.entries(REQUIRED_ENVIRONMENT)) {
      process.env[name] = value;
    }
  });

  afterAll(() => {
    process.env = before;
  });

  it('löst jede Abhängigkeit jedes Providers auf', async () => {
    // Der Import steht ABSICHTLICH hier drin und nicht oben: `AppModule` liest
    // beim Laden `process.env` (Rate-Limit-Tracker), und das soll die oben
    // gesetzte Umgebung sein.
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { AppModule } = require('./app.module') as { AppModule: unknown };

    const module = await Test.createTestingModule({
      imports: [AppModule as never],
    }).compile();

    expect(module).toBeDefined();
    await module.close();
  });

  it('kennt die Dienste der Instanzverwaltung als auflösbare Provider', async () => {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { AppModule } = require('./app.module') as { AppModule: unknown };
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { InstanceService } = require('./instances/instance.service') as never;
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { InstanceProvisioningService } = require('./instances/instance-provisioning.service') as never;
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { MetricsFetchService } = require('./instances/metrics-fetch.service') as never;
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { ReconciliationService } = require('./instances/reconciliation.service') as never;

    const module = await Test.createTestingModule({
      imports: [AppModule as never],
    }).compile();

    // NAMENTLICH, damit beim nächsten Umbau auffällt, worum es ging: Genau
    // diese vier Dienste haben Abhängigkeiten, die NestJS aus dem Typsystem
    // allein nicht auflösen kann (Funktions-Typaliase, Injektionsmarken).
    expect(module.get(InstanceService)).toBeDefined();
    expect(module.get(InstanceProvisioningService)).toBeDefined();
    expect(module.get(MetricsFetchService)).toBeDefined();
    expect(module.get(ReconciliationService)).toBeDefined();
    await module.close();
  });
});
