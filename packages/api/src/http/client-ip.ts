/**
 * @packageDocumentation
 * Unified client identity and IP resolution for the trusted edge boundary.
 *
 * Implements an explicit trusted-hop proxy contract that:
 * 1. Resolves client identity from socket peer address for direct (unproxied) requests.
 * 2. Resolves client identity from `X-Forwarded-For` using right-to-left hop traversal
 *    when operating behind trusted reverse proxies (e.g. nginx, ingress-nginx).
 * 3. Rejects attacker-supplied prefixes in forwarded chains to guarantee spoof resistance.
 * 4. Canonicalizes IPv6 spellings and unmaps IPv4-mapped IPv6 addresses so one
 *    network identity cannot be split across multiple rate-limit buckets.
 */

import { isIP } from 'node:net';
import type { IncomingHttpHeaders } from 'node:http';

/** Trusted proxy configuration: boolean toggle (true = 1 hop, false = direct socket) or non-negative integer hop count. */
export type TrustProxy = boolean | number;

/** Minimal HTTP request interface containing headers and TCP socket peer address needed for IP resolution. */
export interface ClientIpRequestLike {
  readonly headers: IncomingHttpHeaders;
  readonly socket: {
    readonly remoteAddress?: string | undefined;
  };
}

/** Converts a canonical IPv4-mapped IPv6 literal to dotted IPv4 when applicable. */
function unmapIpv4(canonicalIpv6: string): string | null {
  const mapped = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(canonicalIpv6);
  if (!mapped) return null;
  const upper = Number.parseInt(mapped[1]!, 16);
  const lower = Number.parseInt(mapped[2]!, 16);
  return `${upper >>> 8}.${upper & 0xff}.${lower >>> 8}.${lower & 0xff}`;
}

/** Returns the WHATWG canonical spelling for a validated IPv6 literal. */
function canonicalIpv6(ip: string): string | null {
  try {
    const hostname = new URL(`http://[${ip}]/`).hostname;
    return hostname.slice(1, -1);
  } catch {
    return null;
  }
}

/**
 * Normalizes an IP address into a canonical string representation:
 * - Unmaps IPv4-mapped IPv6 addresses (e.g. `::ffff:192.0.2.1` -> `192.0.2.1`).
 * - Trims whitespace and strips surrounding IPv6 brackets (`[2001:db8::1]` -> `2001:db8::1`).
 * - Compresses and lowers IPv6 hex according to the WHATWG host serializer.
 * - Preserves a validated IPv6 zone identifier used by link-local socket addresses.
 * - Returns null if input is undefined, empty, or not a valid IPv4/IPv6 address.
 *
 * @param raw - Raw IP string from socket or forwarded header.
 * @returns Canonical IP string, or null if the input is missing or invalid.
 */
export function normalizeIp(raw: string | undefined | null): string | null {
  if (!raw) return null;
  let ip = raw.trim();
  if (ip.length === 0) return null;

  // Unbracket IPv6 literal if present
  if (ip.startsWith('[') && ip.endsWith(']')) {
    ip = ip.slice(1, -1).trim();
  }

  const ver = isIP(ip);
  if (ver === 4) return ip;
  if (ver === 6) {
    const zoneIndex = ip.indexOf('%');
    const address = zoneIndex === -1 ? ip : ip.slice(0, zoneIndex);
    const zone = zoneIndex === -1 ? '' : ip.slice(zoneIndex);
    const canonical = canonicalIpv6(address);
    return canonical ? (unmapIpv4(canonical) ?? `${canonical}${zone}`) : null;
  }
  return null;
}

/** Rejects typed trusted-proxy values that cannot represent a safe hop count. */
export function validateTrustProxy(value: TrustProxy): void {
  if (typeof value === 'boolean') return;
  if (Number.isSafeInteger(value) && value >= 0) return;
  throw new Error(
    `TRUST_PROXY must be a boolean or non-negative integer (received ${String(value)})`,
  );
}

/**
 * Splits an X-Forwarded-For header into trimmed IP entries from left to right.
 *
 * @param header - Raw header value from request headers (string, array of strings, or undefined).
 * @returns Array of non-empty, trimmed IP strings in leftmost-to-rightmost order.
 */
export function parseForwardedFor(header: string | string[] | undefined): string[] {
  if (!header) return [];
  const raw = Array.isArray(header) ? header.join(',') : header;
  return raw
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

/**
 * Resolves a TRUST_PROXY environment variable value into a boolean or hop count.
 * - undefined, "", "0", "false" -> false (0 hops, direct connection)
 * - "true" -> true (1 hop)
 * - "1", "2", ... -> number (exact hop count)
 *
 * @param val - Environment variable string value.
 * @returns Parsed TrustProxy configuration (boolean or non-negative hop count).
 * @throws Error if the value is not a boolean string or non-negative integer.
 */
export function resolveTrustProxyEnv(val: string | undefined): TrustProxy {
  if (val === undefined || val === '') return false;
  const lower = val.trim().toLowerCase();
  if (lower === 'false' || lower === '0') return false;
  if (lower === 'true') return true;
  const num = Number(lower);
  if (Number.isSafeInteger(num) && num >= 0) return num === 0 ? false : num;
  throw new Error(
    `TRUST_PROXY must be "true", "false", or a non-negative integer (received ${JSON.stringify(val)})`,
  );
}

/**
 * Resolves the authentic client IP address according to the explicit trusted-hop contract.
 *
 * Security & Trust-boundary semantics:
 * - Direct connection (`trustProxy` is false or 0):
 *   Derives identity strictly from the direct TCP peer socket (`socket.remoteAddress`).
 *   Any forwarded headers are ignored to prevent forged client identity.
 * - Reverse proxy (`trustProxy` is true or > 0):
 *   Trusts `hops` proxy layers (where `true` means 1 hop).
 *   Reads `X-Forwarded-For` from right to left, selecting the entry `hops` places
 *   from the socket peer (`entries[entries.length - hops]`).
 *   Entries to the left of the trusted boundary are discarded as untrusted client input.
 * - Short forged chain defense:
 *   If the header is absent, empty, or has fewer entries than configured hops (`entries.length < hops`),
 *   the chain could not have traversed the required trusted reverse proxies.
 *   `null` is returned so the caller can decide the appropriate fallback; using `socketIp` here would
 *   misidentify the proxy address as the client and allow per-IP rate-limit bypass.
 *
 * @param req - HTTP request-like object containing headers and socket peer address.
 * @param trustProxy - Trusted proxy configuration (boolean or non-negative hop count, default: false).
 * @returns Canonical client IP string, or null if unresolvable.
 */
export function resolveClientIp(
  req: ClientIpRequestLike,
  trustProxy: TrustProxy = false,
): string | null {
  const socketIp = normalizeIp(req.socket.remoteAddress);
  validateTrustProxy(trustProxy);
  const hops = typeof trustProxy === 'number' ? trustProxy : trustProxy ? 1 : 0;

  if (hops === 0) {
    return socketIp;
  }

  const entries = parseForwardedFor(req.headers['x-forwarded-for']);
  // Reject short forged chains: if fewer entries than expected hops are present,
  // the request did not traverse all required trusted proxies. Returning null
  // (instead of socketIp) prevents callers from misidentifying the proxy's address
  // as the client, which would undermine per-IP rate limiting.
  if (entries.length < hops) {
    return null;
  }

  const targetIndex = entries.length - hops;
  const candidate = entries[targetIndex];
  return normalizeIp(candidate);
}
