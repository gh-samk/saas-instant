/// <reference types="vitest" />
import { defineConfig, loadEnv } from 'vite';
import { fileURLToPath } from 'node:url';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

export default defineConfig(({ mode }) => {
  // Ziel des Dev-Proxys aus VITE_API_TARGET (z. B. aus apps/control/.env.local),
  // Default :3001 — der Port des Control-Backends.
  const env = loadEnv(mode, process.cwd(), '');
  const apiTarget = env.VITE_API_TARGET || 'http://localhost:3001';
  return {
    // Workspace-Pakete aus der TS-Quelle bündeln — identisch zu apps/web.
    // Die Reihenfolge zählt: der Unterpfad muss vor dem Paketnamen stehen,
    // sonst greift die kürzere Regel zuerst und schreibt den @import in
    // index.css auf `src/index.ts/tokens.css` um.
    resolve: {
      alias: [
        {
          find: '@saas-instant/ui/tokens.css',
          replacement: fileURLToPath(
            new URL('../../packages/ui/src/tokens.css', import.meta.url),
          ),
        },
        {
          find: '@saas-instant/ui/fonts',
          replacement: fileURLToPath(
            new URL('../../packages/ui/src/fonts.ts', import.meta.url),
          ),
        },
        {
          find: '@saas-instant/ui',
          replacement: fileURLToPath(
            new URL('../../packages/ui/src/index.ts', import.meta.url),
          ),
        },
        {
          find: '@saas-instant/shared',
          replacement: fileURLToPath(
            new URL('../../packages/shared/src/index.ts', import.meta.url),
          ),
        },
      ],
    },
    plugins: [react(), tailwindcss()],
    build: {
      // Nicht `dist`: dort liegt das Nest-Backend, und `nest build` leert das
      // Verzeichnis bei jedem Lauf (deleteOutDir).
      outDir: 'dist-web',
      emptyOutDir: true,
      // [Review B3] Keine data:-URIs — die CSP erlaubt font-src nur 'self'.
      assetsInlineLimit: 0,
    },
    server: {
      port: 5174,
      proxy: {
        '/api': {
          target: apiTarget,
          changeOrigin: true,
        },
      },
    },
    test: {
      environment: 'jsdom',
      setupFiles: ['./src/setupTests.ts'],
      globals: true,
      // Nur die Frontend-Tests. Die Backend-Tests (*.spec.ts) laufen unter Jest
      // und würden hier ohne Nest-Testumgebung scheitern.
      include: ['src/**/*.test.{ts,tsx}'],
    },
  };
});
