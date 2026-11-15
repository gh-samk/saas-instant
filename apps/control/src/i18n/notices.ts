import { t } from './index';
/**
 * Wiederkehrende Hinweistexte, die an mehr als einer Stelle wortgleich stehen
 * müssen. Eine Konstante statt zweier Kopien, damit die Formulierungen nicht
 * auseinanderlaufen.
 */

/**
 * Zwangsfolge jeder Passwortänderung.
 *
 * Der Server entwertet dabei alle Merk-Geräte UND zählt die Sitzungsgeneration
 * hoch (`entwerteAlleSitzungen` in `zugang.service.ts`) — es endet also auch
 * jede laufende Sitzung, die eigene eingeschlossen. Der frühere Wortlaut nannte
 * nur die Merk-Geräte und war damit unvollständig; außerdem nannte er die
 * Authenticator-App als einzigen zweiten Faktor, was seit dem E-Mail-Code nicht
 * mehr stimmt.
 */
export const NOTICE_TRUSTED_DEVICES =
  t('common.notices.noticeTrustedDevices');

/**
 * Zwangsfolge des Entfernens eines zweiten Faktors. Sitzungen bleiben dabei
 * bestehen, nur die Merk-Geräte fallen weg (siehe `faktorEntfernen`).
 */
export const NOTICE_FACTOR_REMOVE =
  t('common.notices.noticeFactorRemove');

/** Gültigkeitsdauer eines E-Mail-Codes, in Worten. */
export const NOTICE_CODE_VALID = t('common.notices.noticeCodeValid');
