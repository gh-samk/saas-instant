import type { Request } from 'express';
import { inquiryClientIp, inquiryHopsFrom } from './inquiry-tracker';

/** Herkunft einer Anfrage für das Audit-Log. */
export interface InquirySource {
  ip: string | null;
  userAgent: string | null;
}

/**
 * Liest IP und User-Agent für das Audit-Log.
 *
 * `req.ip` wertet `X-Forwarded-For` aus — aber nur so viele Einträge, wie
 * `CONTROL_TRUST_PROXY` erlaubt (siehe main.ts). Bei 0 ist es die reine
 * Peer-Adresse und damit nicht fälschbar; jeder höhere Wert vertraut genau so
 * vielen Proxys von außen nach innen. Alles, was ein Client darüber hinaus
 * selbst in den Header schreibt, ignoriert Express.
 *
 * Steht der Wert zu hoch, landet eine frei erfundene Adresse im Nachweis.
 * Deshalb gehört er zur Betriebsart und nicht in den Code.
 */
export function sourceFrom(req: Request): InquirySource {
  const userAgent = req.headers['user-agent'] as string | undefined;
  return {
    ip: req.ip ?? null,
    userAgent: truncated(userAgent),
  };
}

/**
 * Herkunft auf den ÖFFENTLICHEN Wegen: Formular der Webseite (Anfrage,
 * AGB-Zustimmung, Newsletter-Häkchen) und Newsletter-Eintragung.
 *
 * Diese Wege laufen über VIER Proxys statt zwei (siehe `anfrage-tracker.ts`),
 * und `req.ip` nennt dort die Adresse eines Proxys. Deshalb gilt hier die
 * Adresse, die unser erster Traefik als Gegenstelle gesehen hat – aber NUR
 * mit gültigem Anfrage-Schlüssel. Ohne ihn, ohne eingerichtete Kettenlänge
 * oder bei zu kurzer Kette bleibt es bei `herkunftAus`.
 *
 * Die Werte kommen aus derselben Umgebung wie beim Rate-Limit
 * (`app.module.ts`); `main.ts` prüft die Kettenlänge schon beim Start.
 */
export function sourceFromInquiry(
  req: Request,
  inquiryHops: number | null = inquiryHopsFrom(process.env['CONTROL_INQUIRY_TRUST_PROXY']),
  expectedKey: string | undefined = process.env['CONTROL_INQUIRY_KEY'],
): InquirySource {
  const base = sourceFrom(req);
  const real = inquiryClientIp(req, inquiryHops, expectedKey);
  return real === null ? base : { ...base, ip: real };
}

/**
 * Höchstlänge des User-Agent im Audit-Log.
 *
 * Der Header ist frei wählbar und unbegrenzt lang; ungekürzt lässt sich damit
 * beliebiger Text in den Nachweis schreiben und dessen Tabelle aufblähen
 * ([H2]). 200 Zeichen reichen für jede echte Browserkennung.
 */
export const USER_AGENT_MAX = 200;

function truncated(value: string | undefined): string | null {
  if (value === undefined) return null;
  if (value.length <= USER_AGENT_MAX) return value;
  return `${value.slice(0, USER_AGENT_MAX)}…`;
}
