/**
 * Alle Funktionsschalter, die es gibt — mit ihrer Vorgabe.
 *
 * DER KATALOG IST DIE QUELLE, NICHT DIE TABELLE. Die Tabelle hält nur, was
 * jemand ausdrücklich umgestellt hat; fehlt eine Zeile, gilt `defaultValue`. So
 * braucht ein neuer Schalter keine Datenmigration, und ein unbekannter
 * Schlüssel lässt sich gar nicht erst setzen.
 */
export const FeatureFlag = {
  feedback: {
    // Pilotphase: an.
    defaultValue: true,
    label: 'Feedback in den Instanzen',
    description:
      'Zeigt in jeder Kundeninstanz und in der Demo den Punkt „Feedback geben" ' +
      'in der Seitenleiste. Das Feedback geht per Mail an das Team.',
  },
} as const;

export type FlagKey = keyof typeof FeatureFlag;

export function isFlagKey(value: string): value is FlagKey {
  return Object.prototype.hasOwnProperty.call(FeatureFlag, value);
}
