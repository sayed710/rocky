/**
 * Gambit API load baseline (M14, ADR-0065).
 *
 * The thresholds below are the SLOs from `docs/SLO.md`, expressed directly rather than restated as
 * separate numbers. That is the point of this script: if a target is unachievable, this run fails
 * and the SLO is wrong — the objective and the thing that validates it cannot drift apart.
 *
 * Run through `node scripts/load-test.mjs`, which brings the stack up and passes BASE_URL.
 *
 * Scenarios are split because they stress different things: `read` is I/O against Postgres, while
 * `auth` is deliberately CPU-bound — registration runs scrypt, so a handful of concurrent
 * registrations saturates a core in a way no amount of read traffic does. Mixing them into one
 * scenario would hide which one moved the latency.
 */
import http from 'k6/http';
import { check } from 'k6';
import { Rate } from 'k6/metrics';

const BASE = __ENV.BASE_URL || 'http://host.docker.internal:3000';
const READ_VUS = Number(__ENV.READ_VUS || 20);
const AUTH_VUS = Number(__ENV.AUTH_VUS || 3);
const DURATION = __ENV.DURATION || '30s';

/**
 * Make `http_req_failed` mean what the availability SLO means: 5xx only.
 *
 * By default k6 treats anything outside 2xx-3xx as a failed request, so a 429 from the rate limiter
 * — the service working exactly as designed — counted against availability. The first run of this
 * script reported 76.5% availability for a service that returned zero 5xx.
 */
http.setResponseCallback(http.expectedStatuses({ min: 200, max: 499 }));

/** Registrations that failed for a reason OTHER than rate limiting. */
const authFailures = new Rate('auth_failures');
/** How often the per-IP limiter engaged. Informational — see authPath. */
const authRateLimited = new Rate('auth_rate_limited');

export const options = {
  scenarios: {
    read: {
      executor: 'constant-vus',
      vus: READ_VUS,
      duration: DURATION,
      exec: 'readPath',
      tags: { scenario: 'read' },
    },
    auth: {
      executor: 'constant-vus',
      vus: AUTH_VUS,
      duration: DURATION,
      exec: 'authPath',
      tags: { scenario: 'auth' },
      startTime: '2s',
    },
  },
  // k6 reports avg/min/med/max/p(90)/p(95) by default. The latency SLO is stated at the 99th
  // percentile, so it has to be asked for explicitly or the summary simply has no number for it.
  summaryTrendStats: ['avg', 'min', 'med', 'max', 'p(90)', 'p(95)', 'p(99)'],

  thresholds: {
    // SLO 1 — availability 99.5%. Only 5xx counts, per the responseCallback above.
    http_req_failed: ['rate<0.005'],

    // SLO 2 — 99% of requests under 250 ms. 250 is a real histogram bucket edge in
    // http_request_duration_seconds, which is why the SLO uses it.
    'http_req_duration{scenario:read}': ['p(99)<250'],

    // Registration is scrypt-bound by design (ADR-0012 hardening), so it is held to a separate,
    // explicitly looser bar. Folding it into the API latency SLO would either make that SLO
    // meaningless or make password hashing look like a regression.
    'http_req_duration{scenario:auth}': ['p(95)<2000'],

    // Registration must either succeed or be cleanly rate-limited. Anything else — a 5xx, a
    // timeout, a 422 from a payload this script got wrong — is a real failure.
    auth_failures: ['rate<0.01'],

    // A read URL that stops returning 200 must fail the run rather than quietly changing what the
    // baseline is measuring.
    'checks{scenario:read}': ['rate>0.999'],
  },
};

/**
 * Every URL in `readPath` is a public GET that should succeed, so the check demands 200 — not
 * merely "not a 5xx".
 *
 * Availability is measured separately, by `http_req_failed` via the responseCallback above, and
 * there a 4xx is correctly a valid response. But a *check* that accepts 4xx lets a scenario with a
 * wrong URL look healthy while its latency quietly enters the baseline. That is not hypothetical:
 * the first version of this file requested `/v1/leaderboard/blitz`, got 9,039 validation failures,
 * and passed.
 */
function ok(res) {
  return res.status === 200;
}

export function readPath() {
  const responses = http.batch([
    ['GET', `${BASE}/v1/health`, null, { tags: { name: 'health' } }],
    // `standard` is a VARIANT. `blitz` is a speed — passing it here returns 422, which the first
    // run of this script did 9,039 times while looking like healthy traffic. The two vocabularies
    // are deliberately separate (M11 inc 7, ADR-0055).
    ['GET', `${BASE}/v1/leaderboard/standard?limit=20`, null, { tags: { name: 'leaderboard' } }],
    ['GET', `${BASE}/v1/search?q=defense&limit=20`, null, { tags: { name: 'search' } }],
    ['GET', `${BASE}/v1/tournaments?limit=20`, null, { tags: { name: 'tournaments' } }],
    ['GET', `${BASE}/v1/seeks?limit=20`, null, { tags: { name: 'seeks' } }],
  ]);

  for (const res of responses) {
    check(res, { 'read: 200': ok });
  }
}

/**
 * Registration under load — which, from a single host, is really a rate-limiter probe.
 *
 * `/v1/auth/register` allows 5 requests per IP per hour (ADR-0013). All load here originates from
 * one container, so after five successes every subsequent request is a 429 and this scenario cannot
 * measure registration throughput or scrypt cost at all. The first run of this script asserted that
 * registrations succeed and reported a 99.75% failure rate against a service behaving perfectly.
 *
 * So what it actually verifies is the thing it CAN verify: that the limiter engages, and that it
 * sheds load with a 429 rather than by falling over with a 5xx. Measuring registration latency
 * properly needs distributed load generation, which belongs with the deferred 100k work.
 */
export function authPath() {
  const suffix = `${__VU}-${__ITER}-${Date.now().toString(36)}`;
  const payload = JSON.stringify({
    handle: `load_${suffix}`,
    password: 'load-test-password-123',
  });
  const params = { headers: { 'content-type': 'application/json' }, tags: { name: 'register' } };

  const res = http.post(`${BASE}/v1/auth/register`, payload, params);

  const created = res.status === 201 || res.status === 200;
  const limited = res.status === 429;

  check(res, { 'auth: created or correctly rate-limited': () => created || limited });
  authRateLimited.add(limited);
  authFailures.add(!created && !limited);
}
