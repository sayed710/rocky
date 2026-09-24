/**
 * @packageDocumentation
 * A minimal production entrypoint that serves the API over Postgres. Requires
 * `ACCESS_TOKEN_SECRET` and `DATABASE_URL` in the environment. Run with
 * `npm run serve` after building. Respects `TRUST_PROXY` from the environment
 * (defaults to direct socket mode when unset). Graceful shutdown drains the
 * HTTP server, stops any engine subprocesses, and closes the connection pool.
 */

import { createPgApiServer } from '../bootstrap';

/**
 * Bootstraps and starts the Gambit API HTTP listener on the configured port.
 *
 * @returns Promise that resolves when the HTTP server starts listening.
 */
async function main(): Promise<void> {
  const port = Number(process.env['PORT'] ?? 8080);
  const { server, pool, shutdownAnalysis } = createPgApiServer();
  const http = await server.listen(port);
  // eslint-disable-next-line no-console
  console.log(`Gambit API listening on :${port}`);

  /**
   * Gracefully shuts down the API process upon receiving an OS termination signal.
   *
   * @param signal - The POSIX signal name (e.g. SIGINT, SIGTERM) triggering the shutdown.
   */
  const shutdown = (signal: string): void => {
    // eslint-disable-next-line no-console
    console.log(`${signal} received — shutting down`);
    http.close(() => {
      // The legacy-named shutdown handle drains engine subprocesses (ADR-0113) and the
      // independent player-lock pool before the primary query pool closes. A failure must not
      // prevent primary-pool closure, or the container could remain alive until SIGKILL.
      void shutdownAnalysis()
        .catch((err: unknown) => {
          // eslint-disable-next-line no-console
          console.error('API resource shutdown failed', err);
        })
        .then(() => pool.end())
        .then(() => process.exit(0));
    });
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

void main();
