import { describe, expect, it } from 'vitest';
import { servicePeriodSuggestion } from './service-period';

describe('leistungszeitraumVorschlag', () => {
  it('schlägt bei monatlicher Zahlweise den laufenden Kalendermonat vor', () => {
    expect(servicePeriodSuggestion('monthly', '2026-08-17')).toEqual({
      from: '2026-08-01',
      until: '2026-08-31',
    });
  });

  it('trifft den Februar — auch im Schaltjahr', () => {
    expect(servicePeriodSuggestion('monthly', '2026-02-10')).toEqual({
      from: '2026-02-01',
      until: '2026-02-28',
    });
    expect(servicePeriodSuggestion('monthly', '2028-02-10')).toEqual({
      from: '2028-02-01',
      until: '2028-02-29',
    });
  });

  it('schlägt bei jährlicher Zahlweise das laufende Kalenderjahr vor', () => {
    expect(servicePeriodSuggestion('yearly', '2026-08-17')).toEqual({
      from: '2026-01-01',
      until: '2026-12-31',
    });
  });

  it('schlägt bei halbjährlicher Zahlweise das laufende Kalenderhalbjahr vor', () => {
    expect(servicePeriodSuggestion('half_yearly', '2026-03-17')).toEqual({
      from: '2026-01-01',
      until: '2026-06-30',
    });
    expect(servicePeriodSuggestion('half_yearly', '2026-06-30')).toEqual({
      from: '2026-01-01',
      until: '2026-06-30',
    });
    expect(servicePeriodSuggestion('half_yearly', '2026-07-01')).toEqual({
      from: '2026-07-01',
      until: '2026-12-31',
    });
  });

  it('rät nichts, wenn keine Zahlungsweise hinterlegt ist', () => {
    expect(servicePeriodSuggestion(null, '2026-08-17')).toEqual({
      from: '2026-08-17',
      until: '2026-08-17',
    });
  });
});
