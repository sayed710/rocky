/**
 * @packageDocumentation
 * `@chess-platform/api` — the stateless REST + identity service. The root entry
 * is driver-free: it exposes {@link createApiServer}, the HTTP/router primitives,
 * the auth building blocks (password hashing, HMAC access tokens, refresh
 * rotation), the injectable ports, presenters, the OpenAPI generator, and the
 * in-memory fakes. Postgres wiring lives behind the `@chess-platform/api/pg`
 * subpath so consumers that only need the interfaces never pull in `pg`.
 */

export * from './config';
export * from './deps';
export * from './server';
export * from './routes';
export * from './domain';
export * from './presenters';
export * from './tournament/launcher';
export * from './tournament/durable-launcher';
export * from './tournament/durable-live-view';
export * from './ports/pg-rate-limiter';
export * from './tournament/service';
export * from './tournament/arena.service';
export * from './tournament/live-view';
export * from './tournament/reporter';
export * from './anti-cheat/source';
export * from './anti-cheat/analysis-service';
export * from './anti-cheat/auto-analyzer';
export * from './anti-cheat/engine-provider';
export * from './bot-detection/source';
export * from './bot-detection/analysis-service';
export * from './bot-detection/auto-analyzer';

export * from './search/reindex';
export * from './search/index-worker';
export * from './achievements/award-worker';
export * from './studies/position-reader';
export * from './analysis/index';
export * from './ai/index';



export * from './auth/password';
export * from './auth/tokens';
export * from './auth/refresh';
export * from './auth/service';

export * from './ports/chess960';
export * from './ports/clock';
export * from './ports/ids';
export * from './ports/audit';
export * from './ports/rate-limiter';
export * from './ports/in-memory-rate-limiter';
export * from './ports/email';
export * from './ports/logger';
export * from './ports/metrics';
export * from './ports/tracer';
export * from './ports/span-export';
export * from './ports/otlp-span-exporter';
export * from './ports/batch-span-processor';

export * from './http/errors';
export * from './http/context';
export * from './http/router';
export * from './http/validate';
export * from './http/cookie';
export * from './http/traceparent';
export * from './http/client-ip';

export * from './openapi/types';
export * from './openapi/spec';
export * from './openapi/schemas';

export * from './graphql';

export * from './bot/catalogue';

export * from './fakes';

