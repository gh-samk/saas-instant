import 'reflect-metadata';
import { PATH_METADATA, METHOD_METADATA } from '@nestjs/common/constants';
import { RequestMethod } from '@nestjs/common';
import { GUARDS_METADATA } from '@nestjs/common/constants';
import { SessionGuard } from '../common/guards/session.guard';
import { SecondFactorGuard } from '../common/guards/second-factor.guard';
import { WITHOUT_SECOND_FACTOR } from '../common/decorators/without-second-factor.decorator';
import { AccessController } from './access.controller';

// Der Konstantenname ist nicht Teil der öffentlichen Oberfläche des Pakets;
// der Wert ist seit Version 2 unverändert und wird hier festgehalten.
const THROTTLER_LIMIT = 'THROTTLER:LIMIT';

/**
 * DER TEST, DER [K4] KÜNFTIG VERHINDERT.
 *
 * Die Nachweispflicht wurde dreimal an einzelnen Routen nachgezogen, und jedes
 * Mal blieb eine übrig — zuletzt `totp/einrichten` und
 * `wiederherstellungscodes`, über die zusammen eine vollständige
 * Kontoübernahme lief. Aufmerksamkeit hat als Schutz erkennbar nicht getragen.
 *
 * Deshalb zählt dieser Test ALLE Routen des Controllers auf und verlangt für
 * jede eine Entscheidung: geschützt (Standard) oder ausdrücklich ausgenommen
 * mit Begründung. Wer eine Route hinzufügt und nichts markiert, bekommt eine
 * geschützte Route; wer sie ausnehmen will, muss es hier eintragen und
 * begründen. Beides fällt auf.
 */

/**
 * Die ABGENOMMENEN Ausnahmen. Diese Liste ist die eigentliche Aussage des
 * Tests: sie darf nur wachsen, wenn jemand die Begründung geprüft hat.
 */
const ALLOWED_EXCEPTIONS: Record<string, string> = {
  'GET factors': 'lesend',
  'GET outbox': 'lesend',
  'GET devices': 'lesend',
  'POST password':
    'prüft das aktuelle Passwort selbst; ohne Passwort nur aus frischer Anmeldung ([H2])',
  'DELETE devices/:id': 'Merk-Gerät; Passkey-Zweig prüft selbst',
  'POST devices/sign-out-all': 'macht die Anmeldung strenger, Notbremse',
  'POST passkey/complete': 'zweiter Schritt, erster Schritt hat geprüft',
  'POST factors/email-code/confirm': 'zweiter Schritt',
  // Nicht bloß „zweiter Schritt": mit einem liegenden vorläufigen Geheimnis
  // ist die Route eine Ratestrecke auf einen zweiten Faktor. Getragen wird die
  // Ausnahme erst durch @Throttle, Kontosperre samt Audit-Eintrag und die
  // Frist auf dem vorläufigen Geheimnis ([K5]).
  'POST totp/confirm':
    'zweiter Schritt, zusätzlich gebremst durch Limit, Kontosperre und Frist',
};

/**
 * Routen, an denen sich ein GEHEIMNIS raten lässt. Sie brauchen ein eigenes,
 * strenges Limit — das globale von 100/min je IP ist dafür keine Bremse.
 *
 * `totp/bestaetigen` stand hier nicht und war deshalb [K5]: gemessen gingen
 * 100 Rateversuche durch, lautlos, ohne Sperre und ohne Logzeile. Ein Treffer
 * macht das geratene vorläufige Geheimnis sofort zum aktiven zweiten Faktor.
 */
const GUESSABLE_ROUTES = [
  'POST password',
  'POST factors/email-code/confirm',
  'POST totp/confirm',
];

/** Alle Routen des Controllers samt ihrer Ausnahme-Begründung. */
function routes(): {
  key: string;
  exception: string | undefined;
  limit: number | undefined;
}[] {
  const prototype = AccessController.prototype as unknown as Record<
    string,
    (...args: unknown[]) => unknown
  >;
  const names = Object.getOwnPropertyNames(prototype).filter(
    (name) =>
      name !== 'constructor' &&
      Reflect.hasMetadata(PATH_METADATA, prototype[name]),
  );
  return names.map((name) => {
    const path = Reflect.getMetadata(PATH_METADATA, prototype[name]) as string;
    const method = Reflect.getMetadata(
      METHOD_METADATA,
      prototype[name],
    ) as RequestMethod;
    return {
      key: `${RequestMethod[method]} ${path}`,
      exception: Reflect.getMetadata(WITHOUT_SECOND_FACTOR, prototype[name]) as
        | string
        | undefined,
      // `@Throttle({ default: … })` legt die Metadaten unter dem Suffix des
      // Limit-Namens ab.
      limit: Reflect.getMetadata(`${THROTTLER_LIMIT}default`, prototype[name]) as
        | number
        | undefined,
    };
  });
}

describe('Alle Routen unter /zugang sind entschieden', () => {
  it('findet überhaupt Routen (sonst prüft der Test nichts)', () => {
    expect(routes().length).toBeGreaterThanOrEqual(12);
  });

  it('hängt beide Guards am Controller — in dieser Reihenfolge', () => {
    // Der ZweitfaktorGuard braucht `req.benutzer` vom SitzungGuard. Stünde er
    // davor, bräche er bei jeder Anfrage ab.
    const guards = Reflect.getMetadata(
      GUARDS_METADATA,
      AccessController,
    ) as unknown[];
    expect(guards).toEqual([SessionGuard, SecondFactorGuard]);
  });

  it('lässt keine Route ohne Entscheidung: geschützt ODER begründet ausgenommen', () => {
    const unauthorized = routes()
      .filter((r) => r.exception !== undefined)
      .filter((r) => ALLOWED_EXCEPTIONS[r.key] === undefined)
      .map((r) => r.key);

    expect(unauthorized).toEqual([]);
  });

  it('verlangt für jede Ausnahme eine tragfähige Begründung', () => {
    for (const route of routes()) {
      if (route.exception === undefined) continue;
      // Kein leerer Platzhalter, sondern ein Satz, den man prüfen kann.
      expect(route.exception.length).toBeGreaterThan(30);
    }
  });

  it('hat für jede eingetragene Ausnahme auch wirklich eine Route', () => {
    // Sonst verwaist die Liste und behauptet Ausnahmen, die es nicht gibt.
    const existing = new Set(
      routes()
        .filter((r) => r.exception !== undefined)
        .map((r) => r.key),
    );
    for (const key of Object.keys(ALLOWED_EXCEPTIONS)) {
      expect(existing.has(key)).toBe(true);
    }
  });

  it('bremst jede Route, an der sich ein Geheimnis raten lässt ([K5])', () => {
    const byKey = Object.fromEntries(
      routes().map((r) => [r.key, r.limit]),
    );
    for (const key of GUESSABLE_ROUTES) {
      // Nicht bloß „irgendein Limit": das globale 100/min ist keine Bremse
      // gegen sechs Ziffern.
      expect(byKey[key]).toBe(5);
    }
  });

  it('schützt insbesondere die Routen aus [K4] und [W6]', () => {
    const byKey = Object.fromEntries(
      routes().map((r) => [r.key, r.exception]),
    );
    expect(byKey['POST totp/setup']).toBeUndefined();
    expect(byKey['POST recovery-codes']).toBeUndefined();
    expect(byKey['POST passkey/start']).toBeUndefined();
    expect(byKey['POST factors/email-code/setup']).toBeUndefined();
    expect(byKey['DELETE factors/:kind']).toBeUndefined();
  });
});
