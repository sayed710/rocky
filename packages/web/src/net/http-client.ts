/**
 * HTTP client — the transport-facing core of the networking layer.
 *
 * Responsibilities (all auth-agnostic): build the URL (base + path + query),
 * apply default + per-request headers, JSON-encode the body, enforce a per-request
 * timeout via AbortController, retry safe requests on transient failures, decode
 * the JSON response, and map every failure onto the {@link ApiError} taxonomy.
 *
 * It knows nothing about tokens or sessions — authentication and refresh-retry
 * live one layer up in the typed API client, so this piece stays small and
 * reusable.
 */
import type { HttpMethod, HttpRequest, HttpResponse, HttpTransport } from '../ports/http.js';
import { FetchTransport } from '../ports/http.js';
import type { ApiErrorEnvelope } from '../api/models.js';
import {
  ApiError,
  DecodeError,
  HttpError,
  NetworkError,
  RequestAbortedError,
  TimeoutError,
  httpErrorFrom,
  parseRetryAfterMs,
} from './errors.js';
import { DEFAULT_RETRY_POLICY, RETRIABLE_METHODS, withRetry } from './retry.js';
import type { RetryPolicy } from './retry.js';

export type QueryValue = string | number | boolean | undefined;

export interface RequestSpec {
  readonly method: HttpMethod;
  /** Path beginning with `/` (joined onto the client's base URL). */
  readonly path: string;
  readonly query?: Readonly<Record<string, QueryValue>>;
  readonly headers?: Readonly<Record<string, string>>;
  /** JSON-encodable request body; omit for bodyless requests. */
  readonly body?: unknown;
  /** Caller cancellation signal (in addition to the client's own timeout). */
  readonly signal?: AbortSignal;
  /** Override the method-based retry-safety decision. */
  readonly idempotent?: boolean;
  /**
   * Statuses this endpoint answers permanently, overriding the transport's transient
   * classification. Retrying them can only produce the same answer, so they fail on the first
   * attempt; every other retryable failure still retries as normal.
   *
   * Narrower than `idempotent: false`, which suppresses retries for *all* failure classes — a
   * network blip included — and so trades away transient recovery to save a repeat that was only
   * ever pointless for one status.
   */
  readonly permanentStatuses?: readonly number[];
  /**
   * Whether to send credentials (cookies) with this request. Default `false`.
   * Set to `'include'` for cookie-based auth (M12 inc 2: refresh/logout).
   */
  readonly credentials?: 'include' | 'omit' | 'same-origin';
  /**
   * Read a 2xx body as a text document of this media type instead of as JSON: it is asked for in
   * `accept`, a 2xx of any other media type is a {@link DecodeError} (an HTML fallback page is not a
   * PGN), and the body is returned exactly as received. Error statuses still read the JSON envelope.
   */
  readonly text?: { readonly mediaType: string };
}

export interface HttpClientOptions {
  readonly baseUrl: string;
  readonly transport?: HttpTransport;
  readonly retry?: RetryPolicy;
  /** Per-request timeout in ms. Default 15000. */
  readonly timeoutMs?: number;
  readonly defaultHeaders?: Readonly<Record<string, string>>;
  readonly sleep?: (ms: number) => Promise<void>;
  readonly rng?: () => number;
}

function isAbortLike(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'name' in error &&
    (error as { name?: unknown }).name === 'AbortError'
  );
}

export class HttpClient {
  private readonly baseUrl: string;
  private readonly transport: HttpTransport;
  private readonly retry: RetryPolicy;
  private readonly timeoutMs: number;
  private readonly defaultHeaders: Readonly<Record<string, string>>;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly rng: () => number;

  constructor(options: HttpClientOptions) {
    this.baseUrl = options.baseUrl;
    this.transport = options.transport ?? new FetchTransport();
    this.retry = options.retry ?? DEFAULT_RETRY_POLICY;
    this.timeoutMs = options.timeoutMs ?? 15_000;
    this.defaultHeaders = options.defaultHeaders ?? {};
    this.sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    this.rng = options.rng ?? Math.random;
  }

  /** Send a request and decode the JSON response as `T` (or `undefined` for 204). */
  async request<T>(spec: RequestSpec): Promise<T> {
    const url = this.buildUrl(spec.path, spec.query);
    const idempotent = spec.idempotent ?? RETRIABLE_METHODS.has(spec.method);
    const permanent = spec.permanentStatuses;

    const response = await withRetry((): Promise<HttpResponse> => this.sendOnce(spec.method, url, spec), {
      policy: this.retry,
      sleep: this.sleep,
      rng: this.rng,
      isRetriable: (error): boolean =>
        idempotent &&
        error instanceof ApiError &&
        error.retryable &&
        !(permanent?.includes(error.status) ?? false),
      delayHintMs: (error): number | undefined =>
        error instanceof HttpError ? error.retryAfterMs : undefined,
    });

    return spec.text ? (this.decodeText(response, spec.text.mediaType) as T) : this.decode<T>(response);
  }

  private async sendOnce(method: HttpMethod, url: string, spec: RequestSpec): Promise<HttpResponse> {
    const controller = new AbortController();
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, this.timeoutMs);

    const external = spec.signal;
    const onExternalAbort = (): void => controller.abort();
    if (external) {
      if (external.aborted) controller.abort();
      else external.addEventListener('abort', onExternalAbort, { once: true });
    }

    const hasBody = spec.body !== undefined;
    const request: HttpRequest = {
      method,
      url,
      headers: this.buildHeaders(spec.text ? { accept: spec.text.mediaType, ...spec.headers } : spec.headers, hasBody),
      signal: controller.signal,
      ...(hasBody ? { body: JSON.stringify(spec.body) } : {}),
      ...(spec.credentials !== undefined ? { credentials: spec.credentials } : {}),
    };

    let response: HttpResponse;
    try {
      response = await this.transport.send(request);
    } catch (error) {
      if (timedOut) throw new TimeoutError(this.timeoutMs, error);
      if (external?.aborted) throw new RequestAbortedError('request aborted by caller', error);
      if (isAbortLike(error)) throw new RequestAbortedError('request aborted', error);
      throw new NetworkError('network request failed', error);
    } finally {
      clearTimeout(timer);
      if (external) external.removeEventListener('abort', onExternalAbort);
    }

    if (response.status >= 200 && response.status < 300) return response;
    throw httpErrorFrom(response.status, this.parseEnvelope(response.body), {
      retryAfterMs: parseRetryAfterMs(response.headers['retry-after']),
    });
  }

  private decode<T>(response: HttpResponse): T {
    if (response.status === 204 || response.body.length === 0) return undefined as T;
    try {
      return JSON.parse(response.body) as T;
    } catch (error) {
      throw new DecodeError(
        `failed to parse JSON response body (status ${response.status})`,
        response.status,
        error,
      );
    }
  }

  private decodeText(response: HttpResponse, mediaType: string): string {
    const received = (response.headers['content-type'] ?? '').split(';')[0]!.trim().toLowerCase();
    if (received !== mediaType) {
      throw new DecodeError(
        `expected a ${mediaType} response body, got ${received || 'no content type'} (status ${response.status})`,
        response.status,
      );
    }
    return response.body;
  }

  private parseEnvelope(body: string): ApiErrorEnvelope | undefined {
    if (body.length === 0) return undefined;
    try {
      const parsed: unknown = JSON.parse(body);
      if (
        typeof parsed === 'object' &&
        parsed !== null &&
        'error' in parsed &&
        typeof (parsed as { error: unknown }).error === 'object'
      ) {
        const err = (parsed as { error: Record<string, unknown> }).error;
        if (typeof err['code'] === 'string' && typeof err['message'] === 'string') {
          return parsed as ApiErrorEnvelope;
        }
      }
    } catch {
      /* non-JSON error body; fall through to a synthesized error */
    }
    return undefined;
  }

  private buildUrl(path: string, query: Readonly<Record<string, QueryValue>> | undefined): string {
    const base = this.baseUrl.replace(/\/+$/, '');
    const suffix = path.startsWith('/') ? path : `/${path}`;
    let url = `${base}${suffix}`;
    if (query) {
      const pairs = Object.entries(query)
        .filter((entry): entry is [string, string | number | boolean] => entry[1] !== undefined)
        .map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(String(value))}`);
      if (pairs.length > 0) url += `?${pairs.join('&')}`;
    }
    return url;
  }

  private buildHeaders(
    extra: Readonly<Record<string, string>> | undefined,
    hasBody: boolean,
  ): Record<string, string> {
    const headers: Record<string, string> = { accept: 'application/json', ...this.defaultHeaders };
    if (hasBody) headers['content-type'] = 'application/json';
    if (extra) {
      for (const [key, value] of Object.entries(extra)) headers[key.toLowerCase()] = value;
    }
    return headers;
  }
}
