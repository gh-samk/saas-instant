import { reviewDateFrom, REVIEW_AFTER_MONTHS } from './deadlines';

describe('reviewDateFrom', () => {
  it('ist das Beschlussdatum plus sieben Monate', () => {
    expect(REVIEW_AFTER_MONTHS).toBe(7);
    expect(reviewDateFrom('2026-03-12')).toBe('2026-10-12');
  });

  it('ist ohne Beschlussdatum nicht bestimmt', () => {
    expect(reviewDateFrom(null)).toBeNull();
  });
});
