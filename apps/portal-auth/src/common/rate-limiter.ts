import { Injectable } from '@nestjs/common';

/**
 * Gleitendes Fenster je Schlüssel (Adresse + Bereich), im Speicher. Reicht für
 * einen einzelnen Dienstprozess; die Kontosperre ist der eigentliche Schutz.
 */
@Injectable()
export class RateLimiter {
  private readonly hits = new Map<string, number[]>();

  /** true, wenn der Aufruf noch erlaubt ist (und wird dann mitgezählt). */
  take(key: string, limit: number, windowMs: number, now: number = Date.now()): boolean {
    const recent = (this.hits.get(key) ?? []).filter((t) => now - t < windowMs);
    if (recent.length >= limit) {
      this.hits.set(key, recent);
      return false;
    }
    recent.push(now);
    this.hits.set(key, recent);
    if (this.hits.size > 10_000) this.prune(windowMs, now);
    return true;
  }

  reset(): void {
    this.hits.clear();
  }

  private prune(windowMs: number, now: number): void {
    for (const [key, times] of this.hits) {
      if (times.every((t) => now - t >= windowMs)) this.hits.delete(key);
    }
  }
}
