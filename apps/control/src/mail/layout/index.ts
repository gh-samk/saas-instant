/**
 * Der Mailrahmen als ein Baustein.
 *
 * Beide Kanäle laden ihn von hier — der Transaktionskanal
 * (`../mail.service.ts`) und der werbliche (`../../broadcast/…`). Getrennt sind
 * die ENTSCHEIDUNGEN der Kanäle (R3), nicht die Typografie: Zwei Abschriften
 * derselben Marke wären zwei Stellen, an denen sie auseinanderläuft.
 * Dieselbe Begründung wie bei `../transport.ts`.
 */
export {
  MAIL_COLOR_VALUES,
  MAIL_FONT,
  MAIL_TOKENS,
} from './brand';
export type {
  FramedMail,
  Body,
  MarketingFooter,
  MarketingBodyParts,
} from './layout';
export {
  LayoutButtonTargetError,
  LayoutWithoutUnsubscribeLinkError,
  bodyFromHtml,
  transactionalLayout,
  marketingFooterText,
  marketingLayout,
  marketingBody,
} from './layout';
export {
  ALLOWED_TAGS,
  escapeContent,
  htmlFromText,
  sanitize,
  textFrom,
} from './sanitizer';
