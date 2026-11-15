import { CanActivate, ExecutionContext, Injectable, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHash, timingSafeEqual } from 'crypto';
import type { Request } from 'express';
import { BackupRejectedError } from './instance.errors';

/** Mindestlänge des gemeinsamen Geheimnisses mit dem Sicherungswerkzeug. */
export const BACKUP_KEY_MIN_LENGTH = 32;

/**
 * Schützt den einzigen Weg, auf dem etwas OHNE Sitzung ins CRM geschrieben
 * wird — die Meldung einer gelungenen Sicherung.
 *
 * Dasselbe Muster wie `AnfrageSchluesselGuard` beim öffentlichen Anfrageweg:
 * IST DIE VARIABLE NICHT GESETZT, EXISTIERT DIE ROUTE NICHT (404). Ein CRM,
 * das keine Sicherungsmeldungen erwartet, hat auch keinen offenen Weg dafür.
 * Der Vergleich ist zeitkonstant über SHA-256-Abdrücke.
 */
@Injectable()
export class BackupKeyGuard implements CanActivate {
  constructor(private readonly config: ConfigService) {}

  canActivate(context: ExecutionContext): boolean {
    const expected = this.config.get<string>('CONTROL_BACKUP_KEY')?.trim();
    if (!expected || expected.length < BACKUP_KEY_MIN_LENGTH) {
      throw new NotFoundException(
        'Sicherungsmeldungen sind auf dieser Anwendung nicht aktiv.',
      );
    }
    const inquiry = context.switchToHttp().getRequest<Request>();
    const header = inquiry.headers['x-backup-key'];
    const offered = typeof header === 'string' ? header : null;
    if (offered === null || !same(offered, expected)) {
      throw new BackupRejectedError();
    }
    return true;
  }
}

/** Zeitkonstanter Vergleich über gleich lange Abdrücke. */
export function same(a: string, b: string): boolean {
  return timingSafeEqual(
    createHash('sha256').update(a, 'utf8').digest(),
    createHash('sha256').update(b, 'utf8').digest(),
  );
}
