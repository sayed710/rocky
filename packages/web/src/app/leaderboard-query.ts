import { OFFERED_VARIANTS, SPEEDS } from '../api/models.js';
import type { Speed, Variant } from '../api/models.js';

export interface LeaderboardPool {
  readonly variant: Variant;
  readonly speed: Speed | null;
}

function isOfferedVariant(value: string): value is Variant {
  return (OFFERED_VARIANTS as readonly string[]).includes(value);
}

function isSpeed(value: string): value is Speed {
  return (SPEEDS as readonly string[]).includes(value);
}

export function parseLeaderboardQuery(search: string): LeaderboardPool {
  const params = new URLSearchParams(search);
  const rawVariant = params.get('variant');
  const rawSpeed = params.get('speed');

  const variant: Variant = rawVariant !== null && isOfferedVariant(rawVariant) ? rawVariant : 'standard';
  const speed: Speed | null = rawSpeed !== null && isSpeed(rawSpeed) ? rawSpeed : null;

  return { variant, speed };
}

export function leaderboardPoolUrl(href: string, pool: LeaderboardPool): string {
  const url = new URL(href);
  url.searchParams.set('variant', pool.variant);
  if (pool.speed !== null) {
    url.searchParams.set('speed', pool.speed);
  } else {
    url.searchParams.delete('speed');
  }
  if (url.pathname.startsWith('//')) {
    return url.href;
  }
  return `${url.pathname}${url.search}${url.hash}`;
}
