import { useCallback, useEffect, useState } from 'react';
import { fetchBroadcastCounter } from './api';
import type { BroadcastNumbers } from '../components/BroadcastTabs';

/**
 * Die drei Zahlen der Reiterleiste, geladen und nachladbar.
 *
 * SIE REISST DIE SEITE NICHT MIT. Schlägt der Zähler fehl, bleiben die Zahlen
 * auf `null` und die Leiste zeigt nur die Beschriftungen — der eigentliche
 * Inhalt des Reiters ist davon unberührt. Eine Seite, die wegen einer Zahl in
 * der Navigation nicht erscheint, wäre die falsche Abhängigkeit.
 *
 * `aktualisiere` gibt es, weil sich die Zahlen durch eine Handlung AUF der
 * Seite ändern: Wer eine Adresse sperrt, sieht den Zähler sonst erst beim
 * nächsten Seitenwechsel steigen.
 */
export function useBroadcastNumbers(): {
  numbers: BroadcastNumbers;
  update: () => void;
} {
  const [numbers, setNumbers] = useState<BroadcastNumbers>({
    templates: null,
    confirmed: null,
    blocked: null,
  });

  const update = useCallback(() => {
    let lives = true;
    void fetchBroadcastCounter()
      .then((z) => {
        if (lives) setNumbers(z);
      })
      .catch(() => {
        // Bewusst still: Die Zahlen sind Beiwerk. Ein Fehlerbanner über der
        // Sperrliste, weil ein Zähler nicht kam, verwirrte mehr, als es hilft.
      });
    return () => {
      lives = false;
    };
  }, []);

  useEffect(() => update(), [update]);

  return { numbers, update };
}
