// Die Logik wohnt seit W5c in `@saas-instant/auth-core` (geteilt mit dem
// Portal-Anmeldedienst). Diese Datei hält die bisherigen Importpfade stabil.
export {
  FACTOR_LABEL,
  isSetUp,
  setUpFactors,
  factorsAfterRemoval,
} from '@saas-instant/auth-core';
export type { FactorKind, FactorBase } from '@saas-instant/auth-core';
