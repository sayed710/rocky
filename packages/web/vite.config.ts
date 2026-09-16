import { defineConfig } from 'vite';
import { fileURLToPath, URL } from 'node:url';

// Static SPA build. When running e2e tests with GAMBIT_E2E_BACKEND=1, the
// vite preview server proxies /v1 (REST), /e2e (harness bridge), and /ws
// (WebSocket) to the e2e harness backend. This lets the frontend talk to
// real backends without CORS configuration.
export default defineConfig({
  resolve: {
    alias: {
      // The browser needs only the shared first-party bot identity helper. The package emits
      // CommonJS, so point Vite at its TypeScript source just as the latency helper below does.
      '@chess-platform/game': fileURLToPath(new URL('../game/src/bot-accounts.ts', import.meta.url)),
      // The clock-interpolation helpers are authored once, in the gateway, and shared with the
      // browser (ADR-0103). That package emits CommonJS, and Vite only applies its CommonJS
      // interop inside `node_modules` — so bundling the compiled `dist/latency.js` fails with
      // "estimateSkewMs is not exported". Pointing at the TypeScript source lets Vite compile it
      // as ordinary ESM. `tsc` still resolves the same import through the package `exports` map,
      // and both routes originate from this one file, so the arithmetic exists in one place only.
      '@chess-platform/realtime-gateway/latency': fileURLToPath(new URL('../realtime-gateway/src/latency.ts', import.meta.url)),
    },
  },
  build: {
    target: 'es2022',
    outDir: 'dist',
    sourcemap: true,
  },
  // The dev server needs the same proxy as `preview` below, for the same reason.
  // `resolveEndpoints` in src/app/config.ts derives the API origin from `location.origin`, so on
  // `vite dev` the app posts to http://localhost:5173/v1/auth/register — a path the dev server does
  // not serve. Registering answered 404, which reads as a broken backend rather than a missing
  // proxy. Defaults match `docker compose up` (API on 8080, gateway on 4175); override with
  // GAMBIT_DEV_API_URL / GAMBIT_DEV_WS_URL to point at a backend running elsewhere.
  server: {
    proxy: {
      '/v1': {
        target: process.env['GAMBIT_DEV_API_URL'] ?? 'http://127.0.0.1:8080',
        changeOrigin: true,
      },
      '/ws': {
        target: process.env['GAMBIT_DEV_WS_URL'] ?? 'ws://127.0.0.1:4175',
        ws: true,
        changeOrigin: true,
      },
    },
  },
  preview: {
    proxy: {
      // Proxy REST API requests to the e2e harness
      '/v1': {
        target: process.env['E2E_API_URL'] ?? 'http://127.0.0.1:4174',
        changeOrigin: true,
      },
      // Proxy harness bridge routes (POST /e2e/games) to the e2e harness
      '/e2e': {
        target: process.env['E2E_API_URL'] ?? 'http://127.0.0.1:4174',
        changeOrigin: true,
      },
      // Proxy WebSocket connections to the e2e harness gateway
      '/ws': {
        target: process.env['E2E_WS_URL'] ?? 'ws://127.0.0.1:4175',
        ws: true,
        changeOrigin: true,
      },
    },
  },
});
