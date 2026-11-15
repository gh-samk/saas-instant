// Logging mit Schwaerzung. Es werden nie Request-Bodies geloggt; zusaetzlich
// maskiert der Redactor bekannte Geheimnisse (zur Laufzeit registrierte Werte,
// age-Schluessel, PEM-Bloecke, Passwoerter in URLs) und sensible Feldnamen.

const MASK = '[REDACTED]';
const SENSITIVE_KEY = /secret|password|passwd|private|identity|token|authorization|accesskey|api[-_]?key|backup-key|signature|signaturhex/i;
const PATTERNS: RegExp[] = [
  /AGE-SECRET-KEY-1[0-9A-Za-z]{10,}/g,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
  /(?<=:\/\/[^:@\s/]+:)[^@\s/]+(?=@)/g,
  /Bearer\s+[A-Za-z0-9._~+/=-]{8,}/g,
];

export class Redactor {
  private secrets = new Set<string>();

  add(value: string | undefined): void {
    if (value && value.length >= 6) this.secrets.add(value);
  }

  remove(value: string | undefined): void {
    if (value) this.secrets.delete(value);
  }

  string(s: string): string {
    let out = s;
    for (const secret of this.secrets) out = out.split(secret).join(MASK);
    for (const re of PATTERNS) out = out.replace(re, MASK);
    return out;
  }

  value(v: unknown, depth = 0): unknown {
    if (typeof v === 'string') return this.string(v);
    if (v === null || typeof v !== 'object') return v;
    if (depth > 5) return MASK;
    if (v instanceof Error) return this.string(v.message);
    if (Array.isArray(v)) return v.map((x) => this.value(x, depth + 1));
    const out: Record<string, unknown> = {};
    for (const [k, val] of Object.entries(v)) {
      out[k] = SENSITIVE_KEY.test(k) ? MASK : this.value(val, depth + 1);
    }
    return out;
  }
}

export type LogLevel = 'info' | 'warn' | 'error';

export interface Logger {
  info(msg: string, fields?: Record<string, unknown>): void;
  warn(msg: string, fields?: Record<string, unknown>): void;
  error(msg: string, fields?: Record<string, unknown>): void;
}

export function createLogger(
  redactor: Redactor,
  write: (line: string) => void = (line) => process.stdout.write(line + '\n'),
  now: () => Date = () => new Date(),
): Logger {
  const emit = (level: LogLevel, msg: string, fields?: Record<string, unknown>) => {
    const entry = {
      time: now().toISOString(),
      level,
      msg: redactor.string(msg),
      ...(fields ? (redactor.value(fields) as Record<string, unknown>) : {}),
    };
    write(JSON.stringify(entry));
  };
  return {
    info: (m, f) => emit('info', m, f),
    warn: (m, f) => emit('warn', m, f),
    error: (m, f) => emit('error', m, f),
  };
}

/** Fehlertext fuer Jobs/Antworten: gekappt und ohne Geheimnisse. */
export function safeMessage(redactor: Redactor, err: unknown, max = 400): string {
  const raw = err instanceof Error ? err.message : String(err);
  const s = redactor.string(raw).replace(/\s+/g, ' ').trim();
  return s.length > max ? s.slice(0, max) + '...' : s;
}
