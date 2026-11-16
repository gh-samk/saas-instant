/** So lange gilt ein gelungener Step-up als Nachweis: fünf Minuten. */
export const STEP_UP_VALID_MS = 5 * 60 * 1000;

/** Ist der Step-up-Zeitpunkt jung genug (und nicht aus der Zukunft)? */
export function stepUpFresh(
  stepUpAt: Date | null,
  now: Date = new Date(),
): boolean {
  if (stepUpAt === null) return false;
  const age = now.getTime() - stepUpAt.getTime();
  return age >= 0 && age < STEP_UP_VALID_MS;
}
