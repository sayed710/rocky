/**
 * @packageDocumentation
 * A tiny, typed, dependency-free HTTP router built on Node's `http` module. It
 * compiles `/v1/users/:handle`-style patterns into segment matchers, resolves
 * path parameters, applies authentication + RBAC declaratively per route, and
 * normalizes every outcome into the JSON error envelope. Handlers never touch
 * the raw socket — they receive a {@link RequestContext} and return a
 * {@link HandlerResult}.
 */

import type { IncomingMessage, RequestListener, ServerResponse } from 'node:http';
import type { Role } from '@chess-platform/persistence';
import { HttpError } from './errors';
import { readJsonBody, DEFAULT_MAX_BODY_BYTES } from './body';
import type { Handler, HandlerResult, Identity, RequestContext } from './context';
import type { RouteDoc } from '../openapi/types';
import type { Logger } from '../ports/logger';
import type { Metrics } from '../ports/metrics';
import type { Tracer } from '../ports/tracer';
import { parseTraceparent, generateTraceId, formatTraceparent, isSampled } from './traceparent';
import { resolveClientIp, type TrustProxy } from './client-ip';

/** HTTP methods the router dispatches. */
export type HttpMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';

/** Per-route authentication policy. */
export interface AuthPolicy {
  /** If true, a valid access token is required (401 otherwise). */
  readonly required: boolean;
  /** If set, the caller must hold at least one of these roles (403 otherwise). */
  readonly anyRole?: readonly Role[];
}

/** A route registration. */
export interface RouteDef {
  readonly method: HttpMethod;
  readonly path: string;
  readonly doc: RouteDoc;
  readonly auth: AuthPolicy;
  readonly handler: Handler;
}

interface CompiledRoute extends RouteDef {
  readonly segments: readonly string[];
  readonly paramNames: readonly string[];
}

/** Runtime collaborators the listener needs (all injected — no globals). */
export interface RouterRuntime {
  /**
   * Resolve an {@link Identity} from the `Authorization` header. Returns null for
   * an absent token and throws {@link HttpError} (401) for a malformed/expired
   * one.
   */
  readonly authenticate: (authorization: string | undefined) => Identity | null;
  readonly maxBodyBytes?: number;
  readonly newRequestId: () => string;
  /** Whether to trust `X-Forwarded-For` for the client IP (behind a proxy). */
  readonly trustProxy?: TrustProxy;
  /** Sink for uncaught (non-HttpError) failures; defaults to `console.error`. */
  readonly onInternalError?: (err: unknown, requestId: string) => void;
  readonly logger: Logger;
  readonly metrics: Metrics;
  readonly tracer: Tracer;
}

const METHODS_WITH_BODY = new Set<HttpMethod>(['POST', 'PUT', 'PATCH', 'DELETE']);

/** Known HTTP methods, plus HEAD/OPTIONS which reach the router before matching. */
const KNOWN_METHODS = new Set(['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS']);

/** Latency histogram buckets (seconds) shared by every request path. */
const LATENCY_BUCKETS = [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10];

/**
 * Normalizes an HTTP method string into one of the known method tokens or `OTHER`.
 *
 * Bounds metric-label cardinality: `req.method` is client-controlled, so an
 * attacker could otherwise mint an unbounded number of `method="…"` series on
 * the failure path. Maps any unrecognized token to `OTHER`.
 *
 * @param method - Raw HTTP method string from the incoming request (may be undefined).
 * @returns Uppercase known method name, or `"OTHER"` for unrecognized tokens.
 */
function normalizeMethod(method: string | undefined): string {
  if (method === undefined) return 'OTHER';
  const upper = method.toUpperCase();
  return KNOWN_METHODS.has(upper) ? upper : 'OTHER';
}

/**
 * Splits a URL pathname into non-empty path segments, discarding leading/trailing slashes.
 *
 * @param path - The URL pathname to split (e.g. `/v1/users/:handle`).
 * @returns Array of path segments in order (e.g. `["v1", "users", ":handle"]`).
 */
function splitPath(path: string): string[] {
  return path.split('/').filter((s) => s.length > 0);
}

/** A declarative, typed HTTP router. */
export class Router {
  private readonly routes: CompiledRoute[] = [];

  /** Register a route. Returns `this` for chaining. */
  add(def: RouteDef): this {
    const segments = splitPath(def.path);
    const paramNames = segments
      .filter((s) => s.startsWith(':'))
      .map((s) => s.slice(1));
    this.routes.push({ ...def, segments, paramNames });
    return this;
  }

  /** Shorthand for {@link add} with method `GET`. */
  get(path: string, doc: RouteDoc, auth: AuthPolicy, handler: Handler): this {
    return this.add({ method: 'GET', path, doc, auth, handler });
  }
  /** Shorthand for {@link add} with method `POST`. */
  post(path: string, doc: RouteDoc, auth: AuthPolicy, handler: Handler): this {
    return this.add({ method: 'POST', path, doc, auth, handler });
  }
  /** Shorthand for {@link add} with method `PUT`. */
  put(path: string, doc: RouteDoc, auth: AuthPolicy, handler: Handler): this {
    return this.add({ method: 'PUT', path, doc, auth, handler });
  }
  /** Shorthand for {@link add} with method `PATCH`. */
  patch(path: string, doc: RouteDoc, auth: AuthPolicy, handler: Handler): this {
    return this.add({ method: 'PATCH', path, doc, auth, handler });
  }
  /** Shorthand for {@link add} with method `DELETE`. */
  delete(path: string, doc: RouteDoc, auth: AuthPolicy, handler: Handler): this {
    return this.add({ method: 'DELETE', path, doc, auth, handler });
  }

  /** All registered routes, for OpenAPI generation. */
  list(): readonly RouteDef[] {
    return this.routes;
  }

  /**
   * Match a method + pathname. Returns the matched route with captured params,
   * or reports whether the path exists under other methods (for 405 vs 404).
   */
  match(
    method: string,
    pathname: string,
  ): { route: CompiledRoute; params: Record<string, string> } | { allow: HttpMethod[] } {
    const segments = splitPath(pathname);
    const allow = new Set<HttpMethod>();
    for (const route of this.routes) {
      if (route.segments.length !== segments.length) continue;
      const params: Record<string, string> = {};
      let ok = true;
      for (let i = 0; i < route.segments.length; i += 1) {
        const pat = route.segments[i]!;
        const val = segments[i]!;
        if (pat.startsWith(':')) {
          try {
            params[pat.slice(1)] = decodeURIComponent(val);
          } catch (error) {
            if (error instanceof URIError) throw HttpError.badRequest('path contains invalid percent encoding');
            throw error;
          }
        } else if (pat !== val) {
          ok = false;
          break;
        }
      }
      if (!ok) continue;
      allow.add(route.method);
      if (route.method === method) return { route, params };
    }
    return { allow: [...allow] };
  }

  /** Build a Node `http` request listener bound to this route table. */
  toListener(runtime: RouterRuntime): RequestListener {
    const maxBody = runtime.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES;
    const onInternal =
      runtime.onInternalError ??
      ((err: unknown, requestId: string): void => {
        // eslint-disable-next-line no-console
        console.error(`[api] internal error (request ${requestId}):`, err);
      });

    return (req: IncomingMessage, res: ServerResponse): void => {
      void this.dispatch(req, res, runtime, maxBody, onInternal);
    };
  }

  private async dispatch(
    req: IncomingMessage,
    res: ServerResponse,
    runtime: RouterRuntime,
    maxBody: number,
    onInternal: (err: unknown, requestId: string) => void,
  ): Promise<void> {
    const requestId = headerString(req.headers['x-request-id']) ?? runtime.newRequestId();
    res.setHeader('X-Request-Id', requestId);
    
    const parsedTrace = parseTraceparent(headerString(req.headers['traceparent']));
    const traceId = parsedTrace?.traceId ?? generateTraceId();
    res.setHeader('trace-id', traceId); // Echo trace-id on response

    const inboundSampled = parsedTrace ? isSampled(parsedTrace.flags) : undefined;

    const method = normalizeMethod(req.method);

    const span = runtime.tracer.startSpan('http.server', {
      traceId,
      parentId: parsedTrace?.parentId,
      kind: 'server',
      sampledFlag: inboundSampled,
      attributes: { 'http.method': method },
    });

    // Propagate the tracer's RESOLVED sampling decision, not a default — a trace
    // the sampler rejected must not be advertised as sampled to downstream services.
    res.setHeader(
      'traceparent',
      formatTraceparent({ traceId, spanId: span.spanId, sampled: span.sampled }),
    );

    const startMs = Date.now();
    let resolvedRoutePath = 'unknown';

    try {
      const host = headerString(req.headers.host) ?? 'localhost';
      const url = new URL(req.url ?? '/', `http://${host}`);

      const matched = this.match(method, url.pathname);
      if ('allow' in matched) {
        if (matched.allow.length > 0) {
          res.setHeader('Allow', matched.allow.join(', '));
          throw new HttpError(405, 'bad_request', `method ${method} not allowed`);
        }
        throw HttpError.notFound(`no route for ${method} ${url.pathname}`);
      }
      const { route, params } = matched;
      resolvedRoutePath = route.path;
      span.setAttribute('http.route', route.path);

      const body = METHODS_WITH_BODY.has(route.method)
        ? await readJsonBody(req, maxBody)
        : undefined;

      const auth = runtime.authenticate(headerString(req.headers.authorization));
      if (route.auth.required && !auth) {
        res.setHeader('WWW-Authenticate', 'Bearer');
        throw HttpError.unauthorized();
      }
      if (auth && route.auth.anyRole && route.auth.anyRole.length > 0) {
        const permitted = route.auth.anyRole.some((r) => auth.roles.includes(r));
        if (!permitted) throw HttpError.forbidden();
      }

      const logger = runtime.logger.child({ requestId, traceId, method, path: route.path });

      // Fires when the connection closes before the response is complete.
      //
      // Bound to the *response*, not the request: `req`'s `close` fires when the request body has
      // been fully received, which for every route here happens long before the handler finishes,
      // so aborting on it would cancel every request the instant its body arrived. `res.close`
      // fires once, when the exchange is over either way, and `writableFinished` is what tells a
      // completed response apart from an abandoned one.
      const disconnect = new AbortController();
      /** Abort the request's signal, but only when the exchange ended without a full response. */
      const onClose = (): void => {
        if (!res.writableFinished) disconnect.abort();
      };
      res.once('close', onClose);

      const ctx: RequestContext = {
        method: route.method,
        path: url.pathname,
        params,
        query: url.searchParams,
        headers: req.headers,
        body,
        requestId,
        traceId,
        logger,
        ip: resolveClientIp(req, runtime.trustProxy ?? false),
        userAgent: headerString(req.headers['user-agent']) ?? null,
        auth,
        signal: disconnect.signal,
      };

      let result;
      try {
        result = await route.handler(ctx);
      } finally {
        // The listener holds the controller, and the controller is reachable from any signal the
        // handler passed downstream. Removing it here keeps a long-lived socket from accumulating
        // one per request on a keep-alive connection.
        res.removeListener('close', onClose);
      }
      writeResult(res, result);

      const durationMs = Date.now() - startMs;
      logger.info('request completed', { status: result.status, durationMs });
      runtime.metrics.counter('http_requests_total', { method, route: route.path, status: String(result.status) }).inc();
      runtime.metrics.histogram('http_request_duration_seconds', LATENCY_BUCKETS, { route: route.path }).observe(durationMs / 1000);
      span.setAttribute('http.status_code', result.status);
      span.setStatus(result.status >= 500 ? 'error' : 'ok');
      span.end();
    } catch (err) {
      const durationMs = Date.now() - startMs;
      const reqPath = req.url ? req.url.split('?')[0] ?? '/' : '/';
      const logger = runtime.logger.child({ requestId, traceId, method, path: reqPath });

      if (err instanceof HttpError) {
        logger[err.status >= 500 ? 'error' : 'warn']('request failed', { status: err.status, durationMs, code: err.code, err: err.message });
        runtime.metrics.counter('http_requests_total', { method, route: resolvedRoutePath, status: String(err.status) }).inc();
        runtime.metrics.histogram('http_request_duration_seconds', LATENCY_BUCKETS, { route: resolvedRoutePath }).observe(durationMs / 1000);
        span.setAttribute('http.route', resolvedRoutePath);
        span.setAttribute('http.status_code', err.status);
        span.setStatus(err.status >= 500 ? 'error' : 'ok');
        span.end();

        writeResult(res, {
          status: err.status,
          headers: err.headers,
          body: {
            error: {
              code: err.code,
              message: err.message,
              ...(err.details ? { details: err.details } : {}),
              requestId,
            },
          },
        });
        return;
      }
      
      logger.error('internal server error', { status: 500, durationMs, err: err instanceof Error ? err.stack ?? err.message : String(err) });
      runtime.metrics.counter('http_requests_total', { method, route: resolvedRoutePath, status: '500' }).inc();
      runtime.metrics.histogram('http_request_duration_seconds', LATENCY_BUCKETS, { route: resolvedRoutePath }).observe(durationMs / 1000);
      span.setAttribute('http.route', resolvedRoutePath);
      span.setAttribute('http.status_code', 500);
      span.setStatus('error');
      span.end();

      onInternal(err, requestId);
      writeResult(res, {
        status: 500,
        body: { error: { code: 'internal', message: 'internal server error', requestId } },
      });
    }
  }
}

/** Serialize a handler result to the Node response while preserving status and declared headers. */
function writeResult(res: ServerResponse, result: HandlerResult): void {
  if (result.headers) {
    for (const [k, v] of Object.entries(result.headers)) res.setHeader(k, v);
  }
  if (result.status === 204 || result.body === undefined) {
    res.writeHead(result.status);
    res.end();
    return;
  }
  if (typeof result.body === 'string') {
    const payload = Buffer.from(result.body, 'utf-8');
    if (!res.hasHeader('content-type')) {
      res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    }
    res.setHeader('Content-Length', payload.byteLength);
    res.writeHead(result.status);
    res.end(payload);
    return;
  }

  const payload = Buffer.from(JSON.stringify(result.body), 'utf-8');
  if (!res.hasHeader('content-type')) {
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
  }
  res.setHeader('Content-Length', payload.byteLength);
  res.writeHead(result.status);
  res.end(payload);
}

/**
 * Normalizes an HTTP header value that may be a single string, array of strings, or undefined.
 *
 * @param value - Raw header value from IncomingHttpHeaders.
 * @returns The first header string if present, or undefined if absent.
 */
function headerString(value: string | string[] | undefined): string | undefined {
  if (value === undefined) return undefined;
  return Array.isArray(value) ? value[0] : value;
}
