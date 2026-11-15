import { useEffect, useState } from 'react';
import { t } from '../i18n';

/**
 * Formatiert Sekunden als `mm:ss`. Wird an zwei Stellen gebraucht: für die
 * Restzeit einer Kontosperre (Anmeldeseite) und für die Restgültigkeit eines
 * Notfall-Links.
 *
 * NUR FÜR KURZE SPANNEN. Ab einer Stunde nimm `alsRestdauer` — `mm:ss` zeigte
 * sonst „10079:42", und das ist keine Zeitangabe mehr, sondern eine Zahl.
 */
export function asMinutesSeconds(seconds: number): string {
  const capped = seconds > 0 ? Math.ceil(seconds) : 0;
  const minutes = Math.floor(capped / 60);
  const rest = capped % 60;
  return `${String(minutes).padStart(2, '0')}:${String(rest).padStart(2, '0')}`;
}

/**
 * Eine Restdauer in Worten — `mm:ss` unter einer Stunde, darüber Tage und
 * Stunden.
 *
 * DER FEHLER, DER SIE AUSGELÖST HAT: Der Einladungslink der Nutzerverwaltung
 * gilt sieben Tage, benutzt aber dieselbe Seite wie der 15-Minuten-Notfall-
 * Link. Dort stand dann „Der Link ist noch 10079:42 gültig". Niemand liest
 * daraus eine Woche; die meisten lesen daraus einen Fehler.
 *
 * SEKUNDENGENAU NUR, WO ES DARAUF ANKOMMT. Bei fünfzehn Minuten zählt jede
 * Sekunde, bei sieben Tagen niemand. Deshalb ab einer Stunde volle Stunden
 * und ab einem Tag volle Tage — eine Angabe, die sich nicht jede Sekunde
 * ändert, liest sich ruhiger und ist genauso wahr.
 */
export function asRemainingDuration(seconds: number): string {
  const capped = seconds > 0 ? Math.ceil(seconds) : 0;
  if (capped < 3600) return asMinutesSeconds(capped);

  const hours = Math.floor(capped / 3600);
  if (hours < 24) {
    return hours === 1 ? t('common.countdown.text') : t('common.countdown.text2', { hours: hours });
  }
  const days = Math.floor(hours / 24);
  const restHours = hours % 24;
  const daysWord = days === 1 ? t('common.countdown.daysWord') : t('common.countdown.daysWord2', { days: days });
  if (restHours === 0) return daysWord;
  return `${daysWord} und ${restHours === 1 ? t('common.countdown.text') : t('common.countdown.text3', { restHours: restHours })}`;
}

/**
 * Zählt clientseitig im Sekundentakt herunter. Die Startzeit kommt als Anzahl
 * Sekunden vom Server (kein Zeitstempel — der Client kann falsch gehen), bei
 * `null` läuft kein Countdown.
 *
 * Wichtig: Eine geänderte Vorgabe gilt **sofort in diesem Renderdurchlauf**,
 * nicht erst im nächsten. Ein Nachziehen per `useEffect` hatte einen Fehler
 * zur Folge, der teuer war: Der Aufrufer las im ersten Durchlauf noch die 0,
 * hielt den frisch gesetzten Countdown für abgelaufen und räumte ihn wieder
 * ab — die Sperrmeldung der Anmeldeseite erschien deshalb nie (Finding K3).
 * Deshalb hier das dokumentierte React-Muster „Zustand beim Rendern
 * anpassen": React verwirft den Durchlauf und rendert sofort neu, bevor
 * Effekte laufen.
 *
 * `runde` startet den Countdown neu, obwohl `startSekunden` gleich bleibt. Das
 * braucht der Wiederhol-Zähler beim E-Mail-Code: dort sind es jedes Mal
 * dieselben 60 Sekunden, und ohne diesen Wert liefe der zweite Klick auf
 * „Code erneut senden" in einen Zähler, der nie neu beginnt.
 */
export function useCountdown(
  startSeconds: number | null,
  round = 0,
): number {
  const [rest, setRest] = useState(startSeconds ?? 0);
  const [defaultValue, setDefault] = useState(startSeconds);
  const [defaultRound, setDefaultRound] = useState(round);

  if (defaultValue !== startSeconds || defaultRound !== round) {
    setDefault(startSeconds);
    setDefaultRound(round);
    setRest(startSeconds ?? 0);
  }

  useEffect(() => {
    if (rest <= 0) return;
    const id = window.setTimeout(() => setRest((s) => s - 1), 1000);
    return () => window.clearTimeout(id);
  }, [rest]);

  // Beim Anpassen während des Renderns steht in `rest` noch der alte Wert;
  // der Aufrufer bekommt trotzdem sofort den richtigen.
  return defaultValue !== startSeconds || defaultRound !== round
    ? (startSeconds ?? 0)
    : rest;
}
