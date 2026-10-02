import { classifySpeed } from '@chess-platform/game';
import type { RatingRow, RatingsRepository, SeekRow } from '@chess-platform/persistence';
import { seekView, type SeekView } from './presenters';

/** Compose current persisted pool ratings with seeks in one bounded batch read. */
export async function seekViews(rows: readonly SeekRow[], ratings: RatingsRepository): Promise<SeekView[]> {
  const pools = rows.filter((row) => row.creatorHandle != null).map((row) => ({
    userId: row.creatorId, variant: row.variant, speed: classifySpeed(row.timeControl),
  }));
  const key = (pool: Pick<RatingRow, 'userId' | 'variant' | 'speed'>): string =>
    `${pool.userId}:${pool.variant}:${pool.speed}`;
  const byPool = new Map((pools.length ? await ratings.getMany(pools) : []).map((r) => [key(r), r]));
  return rows.map((row) => seekView(row, byPool.get(key({
    userId: row.creatorId, variant: row.variant, speed: classifySpeed(row.timeControl),
  })) ?? null));
}
