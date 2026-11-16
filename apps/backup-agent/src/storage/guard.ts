import { isProtectedKey } from '../keys.js';
import type { Storage } from './types.js';

/**
 * Jede Loeschung laeuft hier durch. Rechnungsarchive (invoices/*) werden vom
 * Agenten nie geloescht, auch nicht auf ausdrueckliche Anweisung irgendeines Jobs.
 */
export function withDeleteGuard(inner: Storage): Storage {
  return {
    put: (k, b, o) => inner.put(k, b, o),
    get: (k) => inner.get(k),
    list: (p) => inner.list(p),
    head: (k) => inner.head(k),
    observedHostKey: () => inner.observedHostKey?.(),
    ...(inner.withTofu ? { withTofu: () => withDeleteGuard(inner.withTofu!()) } : {}),
    delete: async (k) => {
      if (isProtectedKey(k)) throw new Error('Loeschen von Rechnungsarchiven ist nicht erlaubt');
      return inner.delete(k);
    },
  };
}
