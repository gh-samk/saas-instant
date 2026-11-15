import { describe, expect, it, vi } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import { asMinutesSeconds, asRemainingDuration, useCountdown } from './countdown';

describe('alsMinutenSekunden', () => {
  it('füllt Minuten und Sekunden zweistellig auf', () => {
    expect(asMinutesSeconds(0)).toBe('00:00');
    expect(asMinutesSeconds(9)).toBe('00:09');
    expect(asMinutesSeconds(65)).toBe('01:05');
    expect(asMinutesSeconds(900)).toBe('15:00');
  });

  it('behandelt negative Restzeiten als abgelaufen', () => {
    expect(asMinutesSeconds(-5)).toBe('00:00');
  });
});

describe('useCountdown', () => {
  it('übernimmt eine neu gesetzte Vorgabe', () => {
    const { result, rerender } = renderHook(
      ({ start }: { start: number | null }) => useCountdown(start),
      { initialProps: { start: null as number | null } },
    );
    expect(result.current).toBe(0);

    rerender({ start: 900 });
    expect(result.current).toBe(900);
  });

  it('beginnt bei null ohne Countdown', () => {
    const { result } = renderHook(() => useCountdown(null));
    expect(result.current).toBe(0);
  });

  /**
   * Der Wiederhol-Zähler beim E-Mail-Code läuft immer über dieselben 60
   * Sekunden. Ohne die Runde bliebe er nach dem ersten Durchlauf bei 0 stehen
   * und „Code erneut senden" wäre sofort wieder klickbar.
   */
  it('startet bei gleicher Vorgabe neu, wenn die Runde wechselt', async () => {
    vi.useFakeTimers();
    try {
      const { result, rerender } = renderHook(
        ({ round }: { round: number }) => useCountdown(60, round),
        { initialProps: { round: 0 } },
      );
      await act(async () => {
        vi.advanceTimersByTime(1000);
      });
      expect(result.current).toBe(59);

      rerender({ round: 1 });
      expect(result.current).toBe(60);
    } finally {
      vi.useRealTimers();
    }
  });

  it('zählt im Sekundentakt herunter', async () => {
    vi.useFakeTimers();
    try {
      const { result } = renderHook(() => useCountdown(3));
      expect(result.current).toBe(3);
      await act(async () => {
        vi.advanceTimersByTime(1000);
      });
      expect(result.current).toBe(2);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('alsRestdauer — lange Fristen sind keine mm:ss-Zahlen', () => {
  /**
   * DER FEHLER, GEFUNDEN AM LAUFENDEN SYSTEM: Der Einladungslink gilt sieben
   * Tage, benutzt aber die Seite des 15-Minuten-Notfall-Links. Dort stand
   * „Der Link ist noch 10079:42 gültig". Niemand liest daraus eine Woche.
   */
  it('bleibt unter einer Stunde bei mm:ss — dort zählt jede Sekunde', () => {
    expect(asRemainingDuration(42)).toBe('00:42');
    expect(asRemainingDuration(15 * 60)).toBe('15:00');
    expect(asRemainingDuration(3599)).toBe('59:59');
  });

  it('SAGT AB EINER STUNDE STUNDEN, nicht 60:00', () => {
    expect(asRemainingDuration(3600)).toBe('eine Stunde');
    expect(asRemainingDuration(3 * 3600 + 59)).toBe('3 Stunden');
  });

  it('SAGT AB EINEM TAG TAGE — der Fall aus dem Fehler', () => {
    expect(asRemainingDuration(7 * 24 * 3600)).toBe('7 Tage');
    expect(asRemainingDuration(24 * 3600)).toBe('einen Tag');
    expect(asRemainingDuration(24 * 3600 + 3600)).toBe('einen Tag und eine Stunde');
    expect(asRemainingDuration(2 * 24 * 3600 + 5 * 3600)).toBe('2 Tage und 5 Stunden');
  });

  it('macht aus einer abgelaufenen Frist keine negative Angabe', () => {
    expect(asRemainingDuration(0)).toBe('00:00');
    expect(asRemainingDuration(-90)).toBe('00:00');
  });
});
