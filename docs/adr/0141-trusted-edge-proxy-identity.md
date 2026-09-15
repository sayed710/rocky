# ADR-0141 — Trusted Edge Contract: Proxy-Aware Client Identity

**Status:** Accepted
**Date:** 2026-09-06
**Context:** Launch-readiness audit (PR-1), following ADR-0010, ADR-0011, and ADR-0075.

## Context

Gambit's production deployments front the backend services with reverse proxies:
1. In Docker Compose: `web` (nginx) listens on `:8080` (mapped to `:3000`) and reverse-proxies `/v1/` to `api:8080` and `/ws` to `gateway:4175` via `docker/web/nginx.conf.template`.
2. In Kubernetes (Helm): an ingress controller (`ingress-nginx`) terminates public traffic and routes to the `web` Service, which in turn proxies `/v1/` and `/ws` to `api` and `gateway` cluster Services.

Prior to this change, client identity across the trusted edge boundary had two critical defects in the same trust perimeter:

1. **WebSocket Gateway Per-IP Limit Collapse:**
   In `services/gateway/src/serve.ts`, connection admission derived client identity solely from `request.socket.remoteAddress`. Behind `web` (nginx), every browser connection arrived from the proxy's IP. Consequently, `WS_MAX_CONNECTIONS_PER_IP` (default 20) was enforced against the proxy itself, collapsing the entire platform's capacity for all users behind that proxy into a shared bucket of 20 concurrent sockets. Under test with 25 distinct client connections behind nginx, 20 were admitted and 5 were rejected with close code 1013 (`connection limit exceeded`).

2. **API Rate Limiting Spoof Vulnerability:**
   In `packages/api/src/http/router.ts`, client identity was resolved by taking the leftmost entry of `X-Forwarded-For` (`fwd.split(',')[0]`). However, standard reverse proxies (including our own `docker/web/nginx.conf.template`) configure `proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;`, which *appends* the socket remote address to the end (right) of any incoming header. An attacker could prepend arbitrary forged IPs in `X-Forwarded-For` (e.g. `X-Forwarded-For: <spoofed>, <real_ip>`). The API blindly trusted the leftmost `<spoofed>` IP, allowing attackers to completely bypass per-IP rate limits on sensitive endpoints such as `/v1/auth/register`.

## Decision

### 1. Explicit Trusted-Hop Contract (`TRUST_PROXY`)

Instead of trusting arbitrary headers or hardcoding proxy behavior, we implement an explicit trusted-hop proxy model in `packages/api/src/http/client-ip.ts`:
- Direct / local development (`TRUST_PROXY=false` or `0`, default):
  Client identity is derived strictly from the TCP peer socket (`request.socket.remoteAddress`). All forwarded headers are ignored.
- Reverse proxy deployments (`TRUST_PROXY=<hops>` or `"true"` meaning 1):
  Hop count specifies the number of trusted proxy layers between the internet and the application service. Client IP is extracted by reading `X-Forwarded-For` from **right to left** at index `entries.length - hops`.
  - For Docker Compose: Browser -> `web` (nginx) -> `api`/`gateway` (1 hop: `TRUST_PROXY=1`).
  - For Helm (Kubernetes): Browser -> Ingress -> `web` (nginx) -> `api`/`gateway` (2 hops: `TRUST_PROXY=2`).

Any entries to the left of the trusted boundary are treated as untrusted user input and discarded.

### 2. Robust IP Normalization

`normalizeIp` canonicalizes IP addresses:
- Unmaps IPv4-mapped IPv6 literals (`::ffff:192.0.2.1` -> `192.0.2.1`).
- Strips surrounding brackets from IPv6 literals (`[2001:db8::1]` -> `2001:db8::1`).
- Validates syntax using `node:net isIP`.
- Serializes equivalent IPv6 spellings to one compressed, lowercase identity.
- Rejects malformed or non-IP strings. The API uses its fail-closed `unknown` bucket; the Gateway
  rejects the connection with close code 1008 rather than falling back to a trusted proxy's socket.

### 3. Unified Adoption in API and Gateway

- `packages/api/src/http/client-ip.ts` provides `resolveClientIp(req, trustProxy)` and `resolveTrustProxyEnv(envVal)`.
- `packages/api/src/http/router.ts` resolves `ctx.ip` via `resolveClientIp(req, runtime.trustProxy ?? false)`.
- `services/gateway/src/serve.ts` imports `resolveClientIp` and `resolveTrustProxyEnv` from `@chess-platform/api` and resolves the connection IP for per-IP tracking and limits.
- `docker-compose.yml` configures `TRUST_PROXY: "1"` for both `api` and `gateway`, and exposes them
  only through the published web nginx port. The explicit chaos/developer override publishes
  loopback-only direct ports and switches those services to direct-socket mode.
- `deploy/helm/gambit` derives one or two trusted hops from whether Ingress is rendered and isolates
  web/API/Gateway ingress with default-on NetworkPolicies. Arbitrary workload pods therefore cannot
  bypass the web edge and supply trusted forwarded identity.

## Verification & Acceptance

1. **API Spoof Resistance (TDD RED -> GREEN):**
   `packages/api/test/rate-limit-spoofing.test.ts` proves that sending 6 registration requests with varying forged `X-Forwarded-For` prefixes fails to bypass rate limiting and is blocked with HTTP 429 on request 6.
2. **Gateway Admission & Limits (TDD RED -> GREEN):**
   `services/gateway/test/gateway-proxy-admission.test.ts` verifies:
   - 25 distinct proxied clients are all admitted (0 rejected with 1013).
   - 25 connections from the same client IP are capped at 20 (connections 21-25 rejected with 1013).
   - Spoofed XFF prefixes do not bypass the per-IP connection limit.
   - Connection closure decrements the active count and allows new connections.
   - Direct socket mode (`TRUST_PROXY=false`) ignores forwarded headers.
3. **Real Nginx Acceptance Suite:**
   `scripts/nginx-trusted-edge-acceptance.mjs` executes an automated integration suite against a real container running `nginxinc/nginx-unprivileged:alpine` with `docker/web/nginx.conf.template`:
   - Preserves the one-hop Compose path and separately exercises an ingress-like hop before real Nginx with `TRUST_PROXY=2` for the Helm topology.
   - Enforces per-client WebSocket limits and defeats forwarded-header spoofing through both trusted hops.
   - Keeps API registration rate limits per client through both trusted hops, without collapsing distinct clients into a proxy bucket.
   - Rejects or safely bounds malformed and insufficient two-hop identity chains.
   - Verifies Nginx path security rules (`/v1/metrics` blocked with 404 while `/v1/health` routes).
   This suite is a required gateway CI step; CI fails rather than skipping when Docker is absent.

## Consequences

- Reverse-proxied deployments no longer suffer from false-positive connection limit rejections or rate limit bypasses.
- The platform maintains zero drift in `packages/api/openapi.json` and strict package boundaries (Gateway depends on API; API does not depend on Gateway).
- Ingress topology is explicitly declared in deployment manifests rather than guessed from request headers.
- Deployments need a NetworkPolicy-enforcing CNI. Monitoring outside the release must add a narrow,
  additive policy for direct API scraping rather than disabling the trusted edge boundary.
