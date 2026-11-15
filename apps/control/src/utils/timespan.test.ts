import { describe, expect, it } from 'vitest';
import { runtimeInWords, minutesSince, beforeTimespan } from './timespan';

describe('vorZeitspanne', () => {
  it('formuliert die Spanne seit einem vergangenen Tag', () => {
    expect(beforeTimespan('2026-08-31', '2026-08-31')).toBe('Heute');
    expect(beforeTimespan('2026-08-30', '2026-08-31')).toBe('Gestern');
    expect(beforeTimespan('2026-08-01', '2026-08-31')).toBe('Vor 30 Tagen');
  });

  it('behandelt ein Datum in der Zukunft nicht als negative Spanne', () => {
    expect(beforeTimespan('2026-09-05', '2026-08-31')).toBe('Heute');
  });
});

describe('laufzeitInWorten', () => {
  const start = Date.parse('2026-08-31T10:00:00.000Z');

  it('bleibt grob — kein sekundengenauer Countdown', () => {
    expect(runtimeInWords('2026-08-31T10:00:00.000Z', start + 30_000)).toBe(
      'seit weniger als einer Minute',
    );
    expect(runtimeInWords('2026-08-31T10:00:00.000Z', start + 60_000)).toBe(
      'seit 1 Minute',
    );
    expect(runtimeInWords('2026-08-31T10:00:00.000Z', start + 12 * 60_000)).toBe(
      'seit 12 Minuten',
    );
    expect(runtimeInWords('2026-08-31T10:00:00.000Z', start + 130 * 60_000)).toBe(
      'seit 2 Stunden',
    );
  });

  it('erfindet bei unlesbarem Zeitstempel keine Dauer', () => {
    expect(runtimeInWords('kein datum')).toBe('seit unbekannter Dauer');
    expect(minutesSince('kein datum')).toBe(0);
  });
});
