import { BadRequestException } from '@nestjs/common';
import type {
  AuthenticationResponseJSON,
  RegistrationResponseJSON,
} from '@simplewebauthn/server';

/**
 * Prüft die vom Browser gelieferte WebAuthn-Antwort auf ihre Grundstruktur,
 * bevor sie an die Bibliothek weitergereicht wird.
 *
 * Bewusst nur eine Grobprüfung: die eigentliche kryptographische Prüfung macht
 * `@simplewebauthn/server`. Hier geht es darum, offensichtlich falsch geformte
 * Eingaben mit einem klaren 400 abzuweisen statt mit einem Bibliotheksfehler.
 */
function checkBasicStructure(value: unknown, was: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new BadRequestException(`Die ${was} hat kein gültiges Format.`);
  }
  const object = value as Record<string, unknown>;
  if (typeof object['id'] !== 'string' || object['id'].length === 0) {
    throw new BadRequestException(`Der ${was} fehlt die Credential-ID.`);
  }
  if (object['type'] !== 'public-key') {
    throw new BadRequestException(`Die ${was} ist nicht vom Typ "public-key".`);
  }
  const response = object['response'];
  if (typeof response !== 'object' || response === null) {
    throw new BadRequestException(`Der ${was} fehlt der Antwortteil.`);
  }
  return object;
}

/** Nimmt eine Anmeldeantwort entgegen. */
export function asLoginResponse(value: unknown): AuthenticationResponseJSON {
  return checkBasicStructure(
    value,
    'Passkey-Antwort',
  ) as unknown as AuthenticationResponseJSON;
}

/** Nimmt eine Registrierantwort entgegen. */
export function asRegistrationResponse(value: unknown): RegistrationResponseJSON {
  return checkBasicStructure(
    value,
    'Passkey-Registrierung',
  ) as unknown as RegistrationResponseJSON;
}
