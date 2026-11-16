import { SetMetadata } from '@nestjs/common';

/** Metadatenschlüssel der verlangten Rolle. */
export const REQUIRED_ROLE = 'requiredRole';

/**
 * Verlangt für eine Route (oder einen ganzen Controller) die Rolle `admin`.
 *
 * Wirkt nur zusammen mit dem `RoleGuard` in der `@UseGuards`-Liste des
 * Controllers — und zwar ZWISCHEN `SessionGuard` und `SecondFactorGuard`: wer
 * ohnehin abgewiesen wird, soll vorher keinen Nachweis eintippen müssen.
 * `controller-protection.spec.ts` hält diese Verdrahtung fest.
 *
 * Im Modus `single` ist jedes Konto `admin`; die Markierung ändert dort nichts.
 */
export const RequireAdmin = () => SetMetadata(REQUIRED_ROLE, 'admin');
