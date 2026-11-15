import { emailCodeReasonFrom } from './api-client';
import type { EmailCodeReason } from './api-client';
import { t } from '../i18n';

/**
 * Was die Oberfläche zu einem gescheiterten E-Mail-Code anzeigt — und ob dabei
 * ein NEUER Code nötig ist.
 *
 * Der Unterschied ist im Alltag erheblich: Bei einem Tippfehler tippt man
 * nochmal, bei einem verbrannten oder abgelaufenen Code muss man einen neuen
 * anfordern. Wer das nicht erfährt, tippt denselben toten Code, bis das Konto
 * gesperrt ist — genau der Befund [DW1].
 */
export interface EmailCodeMessage {
  /**
   * `null`, wenn der Server keinen Grund mitgeschickt hat (nie angefordert,
   * weggeräumt, falscher Zweck). Der Aufrufer entscheidet dann selbst, was er
   * zeigt — und das ist je Route verschieden: Beim Bestätigen liefert der
   * Server einen brauchbaren Wortlaut, beim Anmelden bewusst nur das
   * nichtssagende „Anmeldung fehlgeschlagen.".
   */
  text: string | null;
  /** Weiterprobieren ist zwecklos: Es braucht einen frischen Code. */
  newCodeRequired: boolean;
}

/** Die drei Meldungen aus Abschnitt 10 der Spezifikation, im Wortlaut. */
const TEXT_TO_REASON: Record<EmailCodeReason, string> = {
  wrong: t('common.emailCodeError.wrong'),
  burned:
    t('common.emailCodeError.burned'),
  expired: t('common.emailCodeError.expired'),
};

/**
 * Bildet `detail.grund` auf Anzeigetext und Folgeschritt ab.
 *
 * Die Texte stehen hier und nicht beim Server: Sie sind Produktsprache, und
 * beide Routen sollen denselben Wortlaut zeigen. Geraten wird nichts — ohne
 * Grund gibt es keinen Text.
 */
export function emailCodeMessageFrom(error: unknown): EmailCodeMessage {
  const reason = emailCodeReasonFrom(error);
  if (reason === null) return { text: null, newCodeRequired: false };
  return { text: TEXT_TO_REASON[reason], newCodeRequired: reason !== 'wrong' };
}
