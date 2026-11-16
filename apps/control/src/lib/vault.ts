import { ApiError, ERROR_CODE, errorText } from './api-client';
import { asRemainingDuration } from './countdown';
import { MIN_LENGTH_PASSWORD } from './password-strength';
import { t } from '../i18n';

/**
 * Mindestlänge einer Passphrase. Wortgleich mit `PASSPHRASE_MIN_LENGTH` im
 * Backend (`vault/vault.service.ts`) und mit der Passwortregel; die
 * Stärkeanzeige (`passwordStrength`) gilt deshalb unverändert mit.
 */
export const MIN_LENGTH_PASSPHRASE = MIN_LENGTH_PASSWORD;

/** Passt ein neuer Satz Passphrase + Wiederholung zusammen, und ist er lang genug? */
export function passphrasePairValid(passphrase: string, repeat: string): boolean {
  return passphrase.length >= MIN_LENGTH_PASSPHRASE && passphrase === repeat;
}

/** Sekunden bis zur nächsten erlaubten Eingabe aus `vault_rate_limited`, sonst null. */
function retryAfterSeconds(error: unknown): number | null {
  if (!(error instanceof ApiError)) return null;
  if (error.error.code !== ERROR_CODE.vaultRateLimited) return null;
  const detail = error.error.detail;
  if (typeof detail !== 'object' || detail === null) return null;
  const value = (detail as Record<string, unknown>)['retryAfterSeconds'];
  return typeof value === 'number' && value > 0 ? Math.ceil(value) : null;
}

/** Verständlicher Text zu einem gescheiterten Entsperren. */
export function unlockErrorText(error: unknown, mode: 'passphrase' | 'key'): string {
  if (error instanceof ApiError) {
    if (error.error.code === ERROR_CODE.vaultWrongSecret) {
      return mode === 'key' ? t('vault.unlockWrongKey') : t('vault.unlockWrongPassphrase');
    }
    if (error.error.code === ERROR_CODE.vaultRateLimited) {
      const seconds = retryAfterSeconds(error);
      return seconds === null
        ? errorText(error, t('vault.unlockFailed'))
        : t('vault.unlockRateLimited', { time: asRemainingDuration(seconds) });
    }
  }
  return errorText(error, t('vault.unlockFailed'));
}

/** Inhalt der TXT-Datei mit dem Wiederherstellungsschlüssel. */
export function recoveryKeyFileText(
  recoveryKey: string,
  productName: string,
  date: string,
): string {
  return [
    t('vault.keyFileHeading', { product: productName }),
    t('vault.keyFileDate', { date }),
    '',
    recoveryKey,
    '',
    t('vault.keyFileNote'),
    '',
  ].join('\n');
}

/** Löst im Browser den Download einer Textdatei aus. */
export function downloadTextFile(fileName: string, text: string): void {
  const url = URL.createObjectURL(new Blob([text], { type: 'text/plain;charset=utf-8' }));
  const link = document.createElement('a');
  link.href = url;
  link.download = fileName;
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}
