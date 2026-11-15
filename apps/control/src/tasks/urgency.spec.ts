import { urgencyFrom } from './urgency';

describe('urgencyFrom', () => {
  const todayDay = '2026-08-31';

  it('nennt Überfälliges „hoch" — auch um einen Tag', () => {
    expect(urgencyFrom('2026-08-30', todayDay)).toBe('high');
    expect(urgencyFrom('2026-08-31', todayDay)).toBe('high');
  });

  it('nennt die kommende Woche „mittel"', () => {
    expect(urgencyFrom('2026-09-01', todayDay)).toBe('medium');
    expect(urgencyFrom('2026-09-07', todayDay)).toBe('medium');
  });

  it('nennt alles Spätere „niedrig"', () => {
    expect(urgencyFrom('2026-09-08', todayDay)).toBe('low');
  });
});
