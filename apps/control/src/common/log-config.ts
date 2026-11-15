import type { IncomingMessage, ServerResponse } from 'http';
import { maskReferer, maskUrl } from './log-masking';
import { KEY_HEADER } from '../public/key';

/**
 * DIE REDAKTIONSLISTE DES ANWENDUNGSLOGS — bewusst hier und nicht inline im
 * `AppModule`.
 *
 * WARUM ALS EIGENE DATEI ([Log-Leck 07.09.2026]): Solange die Liste im
 * `LoggerModule.forRoot(…)` stand, liess sie sich nicht pruefen — kein Test
 * kam an sie heran, und die Luecke fiel erst im Produktionslog auf. Der
 * `x-anfrage-schluessel` stand dort bei JEDEM `POST /api/oeffentlich/anfrage`
 * im Klartext. Getrennt liegend ist sie testbar: `log-redaktion.spec.ts`
 * schickt eine echte Anfrage durch einen echten pino-Logger und liest mit,
 * was herauskommt.
 *
 * Gleiche Liste wie in der Kunden-API (`apps/api/src/app.module.ts`).
 */
export const LOG_REDACT: readonly string[] = [
  'req.headers.cookie',
  'req.headers["x-csrf-token"]',
  'req.headers.authorization',
  // DER AUSWEIS DES WEBSEITEN-NGINX gegenüber der Verwaltung
  // (`AnfrageSchluesselGuard`, `oeffentlich/schluessel.ts`). Wer ihn hat, kann
  // beliebige Anfragen einliefern. Genau deshalb liegt er ausserhalb des
  // Repositorys — im Log lag er trotzdem, und Logs sind über die
  // Coolify-Oberfläche einsehbar.
  `req.headers["${KEY_HEADER}"]`,
  // Dasselbe Muster, derselbe Rang: das gemeinsame Geheimnis mit dem
  // Sicherungswerkzeug (`SicherungSchluesselGuard`).
  'req.headers["x-backup-key"]',
  'res.headers["set-cookie"]',
];

/**
 * Der Anfrage-Serializer.
 *
 * Der Standard-Serializer protokolliert `req.url` samt Pfad — dort stehen die
 * Bestätigungs- und Abmelde-Token der Einwilligung, die einzige Absicherung
 * dieser Routen. Dieser bildet dieselben Felder ab und maskiert nur die URL.
 *
 * Bewusst selbst geschrieben statt `pino/stdSerializers` zu importieren: pino
 * ist eine transitive Abhängigkeit von nestjs-pino, kein direkter Eintrag in
 * package.json — ein Import daraus wäre unter pnpm nicht auflösbar.
 *
 * `headers` wird UNVERÄNDERT durchgereicht, damit `LOG_REDACT` weiter greift.
 * Wer hier zu filtern beginnt, hebelt die Redaktion aus.
 */
function maskRefererHeader(
  headers: IncomingMessage['headers'] | undefined,
): IncomingMessage['headers'] | undefined {
  const value = headers?.['referer'];
  if (!headers || typeof value !== 'string') return headers;
  return { ...headers, referer: maskReferer(value) };
}

export function serializeInquiry(
  inquiry: IncomingMessage & {
    id?: unknown;
    remoteAddress?: string;
    remotePort?: number;
  },
): Record<string, unknown> {
  return {
    id: inquiry.id,
    method: inquiry.method,
    url: maskUrl(inquiry.url ?? ''),
    headers: maskRefererHeader(inquiry.headers),
    // pino-http reicht dem eigenen Serializer das BEREITS serialisierte
    // Objekt, nicht die IncomingMessage (wrapRequestSerializer). `socket` gibt
    // es dort nicht mehr, `remoteAddress` schon.
    remoteAddress: inquiry.remoteAddress,
    remotePort: inquiry.remotePort,
  };
}

/** Die vollständige `pinoHttp`-Konfiguration des `AppModule`. */
export function buildLogConfig(): Record<string, unknown> {
  return {
    transport:
      process.env['NODE_ENV'] !== 'production'
        ? { target: 'pino-pretty' }
        : undefined,
    customProps: (req: IncomingMessage, _res: ServerResponse) => ({
      requestId: req.headers['x-request-id'] ?? '',
    }),
    redact: [...LOG_REDACT],
    serializers: { req: serializeInquiry },
  };
}
