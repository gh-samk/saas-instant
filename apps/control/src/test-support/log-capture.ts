import { ConsoleLogger, Logger } from '@nestjs/common';

/** Fängt ALLE Nest-Logausgaben ab, damit ein Test sie auf Geheimnisse prüfen kann. */
export function captureLogs(): { lines: string[]; restore: () => void } {
  const lines: string[] = [];
  const push = (...args: unknown[]): void => {
    lines.push(args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a))).join(' '));
  };
  Logger.overrideLogger({
    log: push,
    warn: push,
    error: push,
    debug: push,
    verbose: push,
    fatal: push,
  });
  return {
    lines,
    restore: () => Logger.overrideLogger(new ConsoleLogger()),
  };
}
