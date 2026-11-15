import {
  sectionAsObject,
  isObject,
  optionalTextField,
  textField,
  type ErrorList,
} from '../validation';

export interface MailManifest {
  /** Absendername im From-Header. */
  senderName: string;
  /** Absenderadresse. */
  senderAddress: string;
  /** Fußzeile jeder Mail (Klartext, Zeilenumbrüche erlaubt). */
  footer: string;
  /** Impressum-/Anbieterangaben als Rahmen unter der Fußzeile; optional. */
  imprint: string | null;
  /**
   * Maildomäne, auf der alle Absenderadressen liegen müssen (DMARC-
   * Ausrichtung). Fehlt sie, gilt die Domäne von `senderAddress`.
   */
  domain: string | null;
  /** Antwortadresse (Reply-To) der Mails; fehlt sie, gilt `senderAddress`. */
  replyTo: string | null;
  /** Webseite des Betreibers (absolut, https); null, wenn es keine gibt. */
  websiteUrl: string | null;
  /**
   * Verweise der Mail-Fußzeile (z. B. Impressum, Datenschutz), absolut.
   * Ohne Einträge gibt es keine Verweiszeile.
   */
  legalLinks: { text: string; url: string }[];
  /**
   * Öffentlicher Anfrageweg: Adresse, an die Anfragen von der Webseite
   * weitergemeldet werden. Fehlt sie, gilt `senderAddress`.
   */
  inquiryTo: string | null;
}

export const MAIL_PRESET: MailManifest = {
  senderName: 'SAAS Verwaltung',
  senderAddress: 'noreply@example.com',
  footer: '',
  imprint: null,
  domain: null,
  replyTo: null,
  websiteUrl: null,
  legalLinks: [],
  inquiryTo: null,
};

const MAIL_ADDRESS = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const DOMAIN = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/i;
const HTTPS_URL = /^https:\/\/[^\s]+$/i;

function optionalPattern(
  o: Record<string, unknown>,
  key: string,
  pattern: RegExp,
  hint: string,
  error: ErrorList,
): string | null {
  const w = optionalTextField(o, key, 'mail', error);
  if (w === null) return null;
  if (!pattern.test(w.trim())) {
    error.push(`mail.${key}: ${hint}`);
    return null;
  }
  return w.trim();
}

function checkLinks(raw: unknown, error: ErrorList): { text: string; url: string }[] {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw)) {
    error.push('mail.legalLinks: muss eine Liste sein');
    return [];
  }
  const from: { text: string; url: string }[] = [];
  raw.forEach((e, i) => {
    const path = `mail.legalLinks[${i}]`;
    if (!isObject(e) || typeof e['text'] !== 'string' || typeof e['url'] !== 'string') {
      error.push(`${path}: braucht "text" und "url" als Text`);
      return;
    }
    if (e['text'].trim() === '' || !HTTPS_URL.test(e['url'].trim())) {
      error.push(`${path}: "text" darf nicht leer und "url" muss eine https-Adresse sein`);
      return;
    }
    from.push({ text: e['text'].trim(), url: e['url'].trim() });
  });
  return from;
}

export function checkMail(raw: unknown, error: ErrorList): MailManifest {
  const o = sectionAsObject(raw, 'mail', error);
  return {
    senderName: textField(o, 'senderName', 'mail', MAIL_PRESET.senderName, error, { notEmpty: true }),
    senderAddress: textField(o, 'senderAddress', 'mail', MAIL_PRESET.senderAddress, error, {
      pattern: MAIL_ADDRESS,
      patternHint: 'keine gültige E-Mail-Adresse',
    }),
    footer: textField(o, 'footer', 'mail', MAIL_PRESET.footer, error),
    imprint: optionalTextField(o, 'imprint', 'mail', error),
    domain: optionalPattern(o, 'domain', DOMAIN, 'keine gültige Domäne', error)?.toLowerCase() ?? null,
    replyTo: optionalPattern(o, 'replyTo', MAIL_ADDRESS, 'keine gültige E-Mail-Adresse', error),
    websiteUrl: optionalPattern(o, 'websiteUrl', HTTPS_URL, 'muss eine https-Adresse sein', error),
    legalLinks: checkLinks(o['legalLinks'], error),
    inquiryTo: optionalPattern(o, 'inquiryTo', MAIL_ADDRESS, 'keine gültige E-Mail-Adresse', error),
  };
}
