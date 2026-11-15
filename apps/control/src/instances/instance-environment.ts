import { randomBytes } from 'crypto';
import type { InstanceSmtp } from '../coolify/coolify.config';
import { fillEnvTemplate } from '../manifest/sections/provisioning';

export interface InstanceEnvironmentInput {
  /** Hostname der Instanz (ohne Schema). */
  host: string;
  subdomain: string;
  /** Versanddaten; fehlen sie, wird NICHTS angelegt (Wurf). */
  smtp: InstanceSmtp | null;
  /** Kommen von aussen, weil beide im CRM verschlüsselt abgelegt werden. */
  secrets: { metricsToken: string; setupToken: string };
  /** Umgebungsvorlagen aus dem Manifest (`provisioning.instanceEnv`). */
  templates: Readonly<Record<string, string>>;
}

/**
 * Die Umgebung einer neuen Instanz.
 *
 * Frische Geheimnisse je Instanz — nichts wird zwischen Kunden geteilt. Die
 * Vorlagen aus dem Manifest kommen NACH den Grundwerten (sie dürfen sie
 * ergänzen oder überschreiben), `SETUP_TOKEN` und `METRICS_TOKEN` setzt
 * immer die Verwaltung (Instanz-Vertrag, `docs/instance-contract.md`).
 *
 * WURF STATT STUMMER INSTANZ: Diese Funktion läuft VOR dem Anlegen beim
 * Anbieter. Fehlen die Versanddaten, entsteht dort nichts.
 */
export function buildInstanceEnvironment(input: InstanceEnvironmentInput): Record<string, string> {
  const { smtp } = input;
  if (smtp === null) {
    throw new Error(
      'Die Versanddaten für neue Instanzen fehlen ' +
        '(CONTROL_INSTANCE_SMTP_HOST und CONTROL_INSTANCE_SMTP_FROM). ' +
        'In Coolify wurde nichts angelegt',
    );
  }
  const sender: Record<string, string> = {
    SMTP_HOST: smtp.host,
    SMTP_PORT: smtp.port,
    SMTP_FROM: smtp.from,
  };
  // Leere Werte gar nicht erst setzen: die Compose hat für beide eine leere Vorgabe.
  if (smtp.user !== '') sender['SMTP_USER'] = smtp.user;
  if (smtp.pass !== '') sender['SMTP_PASS'] = smtp.pass;

  const fromManifest: Record<string, string> = {};
  for (const [name, template] of Object.entries(input.templates)) {
    fromManifest[name] = fillEnvTemplate(template, {
      subdomain: input.subdomain,
      domain: input.host,
      setupToken: input.secrets.setupToken,
      metricsToken: input.secrets.metricsToken,
    });
  }

  return {
    ...sender,
    APP_URL: `https://${input.host}`,
    COOKIE_SECURE: '1',
    NODE_ENV: 'production',
    POSTGRES_PASSWORD: randomBytes(24).toString('hex'),
    JWT_SECRET: randomBytes(32).toString('hex'),
    SESSION_SECRET: randomBytes(32).toString('hex'),
    CONFIG_KEY: randomBytes(32).toString('hex'),
    ...fromManifest,
    // Immer die der Verwaltung: Das Setup-Token schützt das Erst-Setup ([K4]),
    // das Lesetoken den Kennzahlen-Endpunkt. Als UMGEBUNGSVARIABLE, nicht als
    // Zeile im Kundenschema — R1 kennt genau zwei Schreibvorgänge.
    METRICS_TOKEN: input.secrets.metricsToken,
    SETUP_TOKEN: input.secrets.setupToken,
  };
}
