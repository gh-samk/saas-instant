import {
  CanActivate,
  ExecutionContext,
  HttpException,
  HttpStatus,
  Injectable,
} from '@nestjs/common';
import type { Request } from 'express';
import { VaultService } from './vault.service';

interface Rule {
  /** Leer = jede Methode. */
  methods?: string[];
  path: RegExp;
}

/**
 * Was bei gesperrtem Tresor erreichbar bleibt — und nur das.
 *
 * - Health (mit Tresor-Zustand) und Version: Betrieb und Monitoring.
 * - public-config und das öffentliche Logo: die Anmeldeseite braucht beides.
 * - auth/** und access/**: Anmeldung, Sitzung, Abmeldung, zweiter Faktor. Ohne
 *   sie käme niemand zur Entsperrseite.
 * - vault/status, vault/unlock, vault/setup: der Tresor selbst. Weitere
 *   Tresor-Routen (Einträge, Umpacken) brauchen den entsperrten Tresor.
 *
 * Jede andere Route antwortet 423. Das schließt auch die öffentlichen
 * Formulare (Anfrage, Newsletter, Aufnahme): sie schreiben Kundendaten, und
 * die gehören nicht unverschlüsselt in die Datenbank.
 */
const ALLOWED: Rule[] = [
  { methods: ['GET', 'HEAD'], path: /^\/api\/health\/?$/ },
  { methods: ['GET', 'HEAD'], path: /^\/api\/version\/?$/ },
  { methods: ['GET', 'HEAD'], path: /^\/api\/public-config\/?$/ },
  { methods: ['GET', 'HEAD'], path: /^\/api\/public\/logo\/?$/ },
  { path: /^\/api\/auth(\/|$)/ },
  { path: /^\/api\/access(\/|$)/ },
  { methods: ['GET', 'HEAD'], path: /^\/api\/vault\/status\/?$/ },
  { methods: ['POST'], path: /^\/api\/vault\/(unlock|setup)\/?$/ },
];

/** Reine Entscheidung (ohne Nest) — für Tests. */
export function isAllowedWhileLocked(method: string, rawUrl: string): boolean {
  const path = rawUrl.split('?')[0] ?? '';
  // Alles außerhalb von /api (z. B. /robots.txt) ist zustandslos und anonym.
  if (!path.startsWith('/api/') && path !== '/api') return true;
  const m = method.toUpperCase();
  return ALLOWED.some(
    (rule) => (!rule.methods || rule.methods.includes(m)) && rule.path.test(path),
  );
}

@Injectable()
export class VaultLockGuard implements CanActivate {
  constructor(private readonly vault: VaultService) {}

  canActivate(context: ExecutionContext): boolean {
    if (context.getType() !== 'http') return true;
    if (this.vault.isReady()) return true;
    const req = context.switchToHttp().getRequest<Request>();
    if (isAllowedWhileLocked(req.method, req.originalUrl ?? req.url)) return true;
    throw new HttpException(
      {
        errorCode: 'vault_locked',
        message: 'Die Verwaltung ist gesperrt. Bitte mit der Passphrase entsperren.',
      },
      HttpStatus.LOCKED,
    );
  }
}
