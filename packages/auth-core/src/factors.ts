/**
 * Die drei Arten von zweitem Faktor, die die Verwaltung kennt.
 *
 * Der Benutzer wählt, welche davon er einrichtet — aber MINDESTENS EINE muss
 * es sein. Eine Anmeldung mit Passwort allein gibt es nicht, und deshalb ist
 * `pruefeNichtLetzterFaktor` in `zugang.service.ts` eine serverseitige Regel
 * und keine Höflichkeit der Oberfläche.
 *
 * Der Passkey zählt mit, obwohl er einstufig ist: er ersetzt Passwort UND
 * zweiten Faktor zugleich, ein Konto mit Passkey ist also nicht ausgesperrt.
 */
export type FactorKind = 'email-code' | 'totp' | 'passkey';

/** Anzeigenamen, damit Oberfläche und Audit-Log dieselben Wörter benutzen. */
export const FACTOR_LABEL: Record<FactorKind, string> = {
  'email-code': 'Code per E-Mail',
  totp: 'Authenticator-App',
  passkey: 'Passkey',
};

/** Was am Konto hinterlegt ist — die Grundlage jeder Faktor-Aussage. */
export interface FactorBase {
  loginCodeEnabled: boolean;
  totpSecret: string | null;
  passkeyCount: number;
}

/** Ist dieser Faktor eingerichtet? */
export function isSetUp(
  base: FactorBase,
  kind: FactorKind,
): boolean {
  switch (kind) {
    case 'email-code':
      return base.loginCodeEnabled;
    case 'totp':
      return base.totpSecret !== null;
    case 'passkey':
      return base.passkeyCount > 0;
  }
}

/** Alle eingerichteten Faktoren, in fester Reihenfolge. */
export function setUpFactors(base: FactorBase): FactorKind[] {
  const alle: FactorKind[] = ['email-code', 'totp', 'passkey'];
  return alle.filter((kind) => isSetUp(base, kind));
}

/**
 * Wie viele Faktoren bleiben übrig, wenn `art` entfernt wird?
 *
 * Zählt Passkeys EINZELN: wer zwei Passkeys hat und einen widerruft, behält
 * einen — das ist kein Aussperren. Erst der letzte Passkey ist bei sonst leerem
 * Konto der letzte Faktor.
 */
export function factorsAfterRemoval(
  base: FactorBase,
  kind: FactorKind,
): number {
  const total =
    (base.loginCodeEnabled ? 1 : 0) +
    (base.totpSecret !== null ? 1 : 0) +
    base.passkeyCount;
  if (!isSetUp(base, kind)) return total;
  return total - 1;
}
