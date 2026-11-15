import '@testing-library/jest-dom/vitest';

// jsdom implementiert kein Canvas; axe-core (Farbkontrast) fragt es ab und
// jsdom meldet sonst "Not implemented" auf stderr. Ein leerer Kontext reicht.
if (typeof HTMLCanvasElement !== 'undefined') {
  HTMLCanvasElement.prototype.getContext = (() =>
    null) as unknown as HTMLCanvasElement['getContext'];
}
