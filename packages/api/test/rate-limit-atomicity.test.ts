/**
 * Multi-bucket admission: all buckets are charged, or none is.
 *
 * Six routes used to guard themselves with two sequential `check()` calls — user then IP, or IP
 * then handle. Each call charged its bucket as it answered, so a request the second bucket refused
 * had already spent the first one's quota. On `/v1/analysis` that meant a player behind a shared
 * NAT paid their own private 30/min budget for requests the IP ceiling never let run: the address
 * saturates, and every co-located account drains at full speed while receiving nothing but 429s.
 * Reversing the order does not fix it, it only changes the victim — one abusive account would drain
 * the shared bucket before its own limit stopped it.
 *
 * The invariant these tests hold: for a request guarded by several buckets, either all of them
 * admit and all are charged, or none is — whatever the order, and whatever else is in flight.
 */
import { strict as assert } from 'node:assert';
import { test, describe } from 'node:test';
import type {
  AnalysisProvider,
  AnalysisRequest,
  EngineCapabilities,
  EngineResult,
  PlayRequest,
  PlayResult,
} from '@chess-platform/engine';
import { AnalysisService } from '../src/analysis/service';
import { DEFAULT_RATE_LIMIT } from '../src/config';
import { startHarness } from './helpers';
import { ManualClock } from '../src/ports/clock';
import { InMemoryRateLimiter } from '../src/ports/in-memory-rate-limiter';
import type { RateLimit } from '../src/ports/rate-limiter';

const START_FEN = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';

/** Answers instantly with one line, so the route reaches its end without a real engine. */
class StubAnalysisProvider implements AnalysisProvider {
  async analyze(_request: AnalysisRequest): Promise<readonly EngineResult[]> {
    return [
      {
        multipv: 1,
        evaluation: { type: 'cp', value: 25 },
        principalVariation: ['e2e4'],
        depth: 12,
        nodes: 1000,
        nps: 1000,
        timeMs: 1,
      },
    ];
  }

  async play(_request: PlayRequest): Promise<PlayResult> {
    throw new Error('not implemented in stub');
  }

  capabilitiesFor(_variant: string): EngineCapabilities | undefined {
    return undefined;
  }
}

const MINUTE = 60_000;

describe('InMemoryRateLimiter combined admission', () => {
  test('an empty bucket list admits, because it asks for nothing', () => {
    const limiter = new InMemoryRateLimiter(new ManualClock(1000));
    assert.deepEqual(limiter.admit([]), { allowed: true, retryAfterSeconds: 0 });
    assert.equal(limiter.size, 0, 'and creates no bucket');
  });

  test('when every bucket admits, every bucket is charged', () => {
    const limiter = new InMemoryRateLimiter(new ManualClock(1000));
    const user: RateLimit = { maxRequests: 2, windowMs: MINUTE };
    const ip: RateLimit = { maxRequests: 3, windowMs: MINUTE };

    assert.equal(limiter.admit([{ key: 'u', limit: user }, { key: 'i', limit: ip }]).allowed, true);
    assert.equal(limiter.admit([{ key: 'u', limit: user }, { key: 'i', limit: ip }]).allowed, true);

    // The user bucket is now full at 2/2, so the third combined request is refused...
    assert.equal(limiter.admit([{ key: 'u', limit: user }, { key: 'i', limit: ip }]).allowed, false);
    // ...and the IP bucket really was charged twice by the two that succeeded, not zero or one.
    assert.equal(limiter.admit([{ key: 'i', limit: ip }]).allowed, true, 'ip had exactly one slot left');
    assert.equal(limiter.admit([{ key: 'i', limit: ip }]).allowed, false, 'and now none');
  });

  test('the first bucket refusing charges nothing to the second', () => {
    const limiter = new InMemoryRateLimiter(new ManualClock(1000));
    const full: RateLimit = { maxRequests: 1, windowMs: MINUTE };
    const roomy: RateLimit = { maxRequests: 5, windowMs: MINUTE };

    assert.equal(limiter.admit([{ key: 'full', limit: full }]).allowed, true); // fill it

    for (let i = 0; i < 4; i += 1) {
      assert.equal(
        limiter.admit([{ key: 'full', limit: full }, { key: 'roomy', limit: roomy }]).allowed,
        false,
      );
    }

    // Four refusals. If any of them had charged `roomy` on the way past, fewer than five would be
    // left — this is the exact shape of the defect, measured from the victim's side.
    for (let i = 0; i < 5; i += 1) {
      assert.equal(limiter.admit([{ key: 'roomy', limit: roomy }]).allowed, true, `slot ${i} intact`);
    }
    assert.equal(limiter.admit([{ key: 'roomy', limit: roomy }]).allowed, false);
  });

  test('the second bucket refusing charges nothing to the first', () => {
    const limiter = new InMemoryRateLimiter(new ManualClock(1000));
    const roomy: RateLimit = { maxRequests: 5, windowMs: MINUTE };
    const full: RateLimit = { maxRequests: 1, windowMs: MINUTE };

    assert.equal(limiter.admit([{ key: 'full', limit: full }]).allowed, true);

    for (let i = 0; i < 4; i += 1) {
      assert.equal(
        limiter.admit([{ key: 'roomy', limit: roomy }, { key: 'full', limit: full }]).allowed,
        false,
      );
    }

    for (let i = 0; i < 5; i += 1) {
      assert.equal(limiter.admit([{ key: 'roomy', limit: roomy }]).allowed, true, `slot ${i} intact`);
    }
  });

  test('the answer does not depend on the order the buckets are given in', () => {
    const build = (): InMemoryRateLimiter => {
      const limiter = new InMemoryRateLimiter(new ManualClock(1000));
      limiter.admit([{ key: 'b', limit: { maxRequests: 1, windowMs: MINUTE } }]);
      return limiter;
    };
    const a: RateLimit = { maxRequests: 5, windowMs: MINUTE };
    const b: RateLimit = { maxRequests: 1, windowMs: MINUTE };

    const forwards = build().admit([{ key: 'a', limit: a }, { key: 'b', limit: b }]);
    const backwards = build().admit([{ key: 'b', limit: b }, { key: 'a', limit: a }]);
    assert.deepEqual(forwards, backwards);
    assert.equal(forwards.allowed, false);
  });

  /**
   * `retryAfterSeconds` is the longest of the refusals, not the first one found.
   *
   * A caller told to wait for the shorter bucket would come back, be refused by the longer one,
   * and have burned a request finding that out. The value must also not depend on evaluation
   * order, or the same request would get different advice depending on how the route happens to
   * list its buckets.
   */
  test('retry-after is the longest wait among the buckets that refused', () => {
    const clock = new ManualClock(1000);
    const limiter = new InMemoryRateLimiter(clock);
    const short: RateLimit = { maxRequests: 1, windowMs: 10_000 }; // 10s
    const long: RateLimit = { maxRequests: 1, windowMs: 300_000 }; // 5min

    limiter.admit([{ key: 'short', limit: short }, { key: 'long', limit: long }]);

    const refused = limiter.admit([{ key: 'short', limit: short }, { key: 'long', limit: long }]);
    assert.equal(refused.allowed, false);
    assert.equal(refused.retryAfterSeconds, 300);

    const reversed = limiter.admit([{ key: 'long', limit: long }, { key: 'short', limit: short }]);
    assert.equal(reversed.retryAfterSeconds, 300, 'and is order-independent');
  });

  test('a lapsed window on one bucket is not rolled over by a request another bucket refuses', () => {
    const clock = new ManualClock(1000);
    const limiter = new InMemoryRateLimiter(clock);
    const expiring: RateLimit = { maxRequests: 2, windowMs: 10_000 };
    const full: RateLimit = { maxRequests: 1, windowMs: MINUTE };

    limiter.admit([{ key: 'expiring', limit: expiring }]);
    limiter.admit([{ key: 'full', limit: full }]);
    clock.advance(20_000); // `expiring` has lapsed; `full` has not

    assert.equal(
      limiter.admit([{ key: 'expiring', limit: expiring }, { key: 'full', limit: full }]).allowed,
      false,
    );

    // The refused request must not have opened a fresh window on `expiring`, which would be a
    // write on the rejection path. Its full capacity is still available.
    assert.equal(limiter.admit([{ key: 'expiring', limit: expiring }]).allowed, true);
    assert.equal(limiter.admit([{ key: 'expiring', limit: expiring }]).allowed, true);
    assert.equal(limiter.admit([{ key: 'expiring', limit: expiring }]).allowed, false);
  });

  /**
   * A key may appear at most once, and the reason is the property directly above this test.
   *
   * The rule this replaced charged one unit per entry, which sounds reasonable and is not
   * order-independent: `[{k, max: 5}, {k, max: 1}]` measures a cumulative two units against a
   * limit of one and refuses, while `[{k, max: 1}, {k, max: 5}]` measures two against five and
   * admits. Same list, two orders, two answers. Rather than invent a resolution rule for a case
   * no route has, the port refuses it. Raised in the Qodo review of PR #137.
   */
  test('a key named twice is a programming error, not a double charge', () => {
    const limiter = new InMemoryRateLimiter(new ManualClock(1000));
    const limit: RateLimit = { maxRequests: 3, windowMs: MINUTE };

    assert.throws(
      () => limiter.admit([{ key: 'k', limit }, { key: 'k', limit }]),
      /duplicate bucket key/,
    );
    assert.throws(
      () =>
        limiter.admit([
          { key: 'k', limit: { maxRequests: 5, windowMs: MINUTE } },
          { key: 'k', limit: { maxRequests: 1, windowMs: MINUTE } },
        ]),
      /duplicate bucket key/,
      "the conflicting-limit case is the one that had no order-independent answer",
    );

    // Refused before anything was written: the bucket is untouched.
    assert.equal(limiter.size, 0);
    assert.equal(limiter.admit([{ key: 'k', limit }]).allowed, true);
  });

  /**
   * Concurrency, on a limiter whose atomicity comes from being synchronous.
   *
   * `Promise.all` is not theatre here: it is what catches the regression. If `admit` were made
   * `async` with an `await` between measuring and committing — the shape any "peek then consume"
   * API has — these calls would interleave at that await, every one of them would see the slot
   * free, and every one would win it. The assertion is that exactly one does.
   */
  test('concurrent requests racing for the final slot: exactly one wins', async () => {
    const limiter = new InMemoryRateLimiter(new ManualClock(1000));
    const user: RateLimit = { maxRequests: 1, windowMs: MINUTE };
    const ip: RateLimit = { maxRequests: 50, windowMs: MINUTE };

    const results = await Promise.all(
      Array.from({ length: 20 }, async () =>
        limiter.admit([{ key: 'u', limit: user }, { key: 'i', limit: ip }]),
      ),
    );

    assert.equal(results.filter((r) => r.allowed).length, 1, 'exactly one request may take the slot');
    // The 19 losers must not have charged the IP bucket they passed on the way to being refused.
    for (let i = 0; i < 49; i += 1) {
      assert.equal(limiter.admit([{ key: 'i', limit: ip }]).allowed, true, `ip slot ${i} intact`);
    }
    assert.equal(limiter.admit([{ key: 'i', limit: ip }]).allowed, false);
  });

  test('no bucket ever exceeds its capacity under a burst', () => {
    const limiter = new InMemoryRateLimiter(new ManualClock(1000));
    const user: RateLimit = { maxRequests: 7, windowMs: MINUTE };
    const ip: RateLimit = { maxRequests: 4, windowMs: MINUTE };

    let admitted = 0;
    for (let i = 0; i < 100; i += 1) {
      if (limiter.admit([{ key: 'u', limit: user }, { key: 'i', limit: ip }]).allowed) admitted += 1;
    }
    // Bounded by the tighter of the two, and the looser one cannot have been overspent either.
    assert.equal(admitted, 4);
    for (let i = 0; i < 3; i += 1) {
      assert.equal(limiter.admit([{ key: 'u', limit: user }]).allowed, true, `user slot ${i} intact`);
    }
    assert.equal(limiter.admit([{ key: 'u', limit: user }]).allowed, false, 'user capacity was 7');
  });
});

describe('routes charge no quota for a request another bucket refuses', () => {
  /**
   * The defect end to end, on a route rather than on the limiter.
   *
   * `perIp` is 1 and `perHandle` is 2. One login from address A fills A's IP bucket and takes the
   * handle's first slot. A second login from A is refused by the IP bucket — and under the old
   * sequential code the handle bucket was charged first and would already be full, so the third
   * request, from a *fresh* address, would be refused too. It must be admitted.
   */
  test('a login refused by the per-IP bucket does not spend the handle bucket', async () => {
    const h = await startHarness({
      trustProxy: true,
      rateLimit: {
        ...DEFAULT_RATE_LIMIT,
        login: {
          ...DEFAULT_RATE_LIMIT.login,
          perIp: { maxRequests: 1, windowMs: MINUTE },
          perHandle: { maxRequests: 2, windowMs: MINUTE },
        },
      },
    });
    try {
      const login = (ip: string) =>
        h.json('POST', '/v1/auth/login', {
          body: { handle: 'victim', password: 'wrong-password' },
          headers: { 'x-forwarded-for': ip },
        });

      const first = await login('203.0.113.1');
      assert.notEqual(first.status, 429, 'first request fits both buckets');

      const refused = await login('203.0.113.1');
      assert.equal(refused.status, 429, 'the per-IP bucket is full');

      const fromFreshIp = await login('203.0.113.2');
      assert.notEqual(
        fromFreshIp.status,
        429,
        'the refused request must not have spent the handle bucket',
      );

      // And the handle bucket is genuinely exhausted after two real admissions, so the test is
      // measuring a preserved slot rather than a limit that never applied.
      const third = await login('203.0.113.3');
      assert.equal(third.status, 429, 'the handle bucket really does hold only two');
    } finally {
      await h.close();
    }
  });

  /**
   * The mirror image, and the reason reversing the order is not a fix: an account refused by its
   * own per-user limit must not have spent a slot in the per-IP bucket it shares with everyone
   * else on the same address.
   */
  test('a login refused by the per-handle bucket does not spend the IP bucket', async () => {
    const h = await startHarness({
      trustProxy: true,
      rateLimit: {
        ...DEFAULT_RATE_LIMIT,
        login: {
          ...DEFAULT_RATE_LIMIT.login,
          perIp: { maxRequests: 3, windowMs: MINUTE },
          perHandle: { maxRequests: 1, windowMs: MINUTE },
        },
      },
    });
    try {
      const login = (handle: string) =>
        h.json('POST', '/v1/auth/login', {
          body: { handle, password: 'wrong-password' },
          headers: { 'x-forwarded-for': '198.51.100.7' },
        });

      assert.notEqual((await login('noisy')).status, 429);
      // Two refusals from the exhausted handle bucket, both from the shared address.
      assert.equal((await login('noisy')).status, 429);
      assert.equal((await login('noisy')).status, 429);

      // The shared IP bucket had 3 and has spent 1. Two neighbours must still get through.
      assert.notEqual((await login('neighbour-a')).status, 429, 'neighbour 1 of 2');
      assert.notEqual((await login('neighbour-b')).status, 429, 'neighbour 2 of 2');
      assert.equal((await login('neighbour-c')).status, 429, 'and the IP bucket held exactly three');
    } finally {
      await h.close();
    }
  });

  /**
   * `/v1/analysis` charged before it parsed the body — the ordering PR #134's review fixed for the
   * two endpoints written after it, which this one never got. A malformed request reaches no
   * engine, so it must cost nothing; otherwise a stream of them empties a budget for free.
   */
  test('a malformed analysis request is rejected before any quota is charged', async () => {
    const h = await startHarness(
      {
        trustProxy: true,
        rateLimit: {
          ...DEFAULT_RATE_LIMIT,
          analysis: {
            perUser: { maxRequests: 1, windowMs: MINUTE },
            perIp: { maxRequests: 50, windowMs: MINUTE },
          },
        },
      },
      { analysis: new AnalysisService({ provider: new StubAnalysisProvider() }) },
    );
    try {
      const { token } = await h.makeUser('analyst');
      const post = (body: unknown) =>
        h.json('POST', '/v1/analysis', { body, token, headers: { 'x-forwarded-for': '192.0.2.9' } });

      // An empty FEN fails `reqString(min: 1)`, which is a structural rejection: the request
      // never reaches the engine, so it must never reach the quota either.
      for (let i = 0; i < 5; i += 1) {
        const bad = await post({ fen: '', variant: 'standard' });
        assert.equal(bad.status, 422, `malformed request ${i} is a validation failure`);
      }

      const wellFormed = await post({ fen: START_FEN, variant: 'standard' });
      assert.equal(
        wellFormed.status,
        200,
        'the single per-user slot survived five malformed requests',
      );

      // ...and it really was the only one: the next well-formed request is refused.
      assert.equal((await post({ fen: START_FEN, variant: 'standard' })).status, 429);
    } finally {
      await h.close();
    }
  });
});

/**
 * `refund` gives back a slot a request reserved but turned out not to owe — login's failure budget
 * when the password was right (audit P1-1). It must never mint capacity the bucket did not have,
 * and must only ever touch the window that took the charge.
 */
describe('InMemoryRateLimiter refund', () => {
  const limit: RateLimit = { maxRequests: 2, windowMs: MINUTE };
  const reserve = (limiter: InMemoryRateLimiter, key = 'k') => {
    const result = limiter.admit([{ key, limit, refundable: true }]);
    assert.equal(result.allowed, true);
    return result.reservations ?? [];
  };

  test('only refundable buckets are reserved', () => {
    const limiter = new InMemoryRateLimiter(new ManualClock(1000));
    const result = limiter.admit([
      { key: 'ip', limit },
      { key: 'handle', limit, refundable: true },
    ]);
    assert.deepEqual(result.reservations?.map((r) => r.key), ['handle']);
    assert.equal(limiter.admit([{ key: 'plain', limit }]).reservations, undefined);
  });

  test('a refunded slot can be admitted again, and only that one', () => {
    const limiter = new InMemoryRateLimiter(new ManualClock(1000));
    const first = reserve(limiter);
    reserve(limiter);
    assert.equal(limiter.admit([{ key: 'k', limit }]).allowed, false);

    limiter.refund(first);
    assert.equal(limiter.admit([{ key: 'k', limit }]).allowed, true);
    assert.equal(limiter.admit([{ key: 'k', limit }]).allowed, false);
  });

  test('a refund never takes a bucket below empty', () => {
    const limiter = new InMemoryRateLimiter(new ManualClock(1000));
    const reservation = reserve(limiter);
    limiter.refund(reservation);
    limiter.refund(reservation);
    limiter.refund([{ key: 'absent', window: '1000' }]);

    assert.equal(limiter.admit([{ key: 'k', limit }]).allowed, true);
    assert.equal(limiter.admit([{ key: 'k', limit }]).allowed, true);
    assert.equal(limiter.admit([{ key: 'k', limit }]).allowed, false, 'still exactly two');
  });

  test('a refund against a lapsed window does nothing', () => {
    const clock = new ManualClock(1000);
    const limiter = new InMemoryRateLimiter(clock);
    const reservation = reserve(limiter);
    clock.advance(MINUTE);
    limiter.refund(reservation);

    assert.equal(limiter.admit([{ key: 'k', limit }]).allowed, true);
    assert.equal(limiter.admit([{ key: 'k', limit }]).allowed, true);
    assert.equal(limiter.admit([{ key: 'k', limit }]).allowed, false);
  });

  /**
   * A login admitted just before its window ends finishes after another request has opened the next
   * window. Refunding by key alone would take that other request's charge; the reservation names
   * the old window, so the new one is left as it is. Raised by Qodo and Greptile on PR #63.
   */
  test('a refund from a replaced window leaves the new window alone', () => {
    const clock = new ManualClock(1000);
    const limiter = new InMemoryRateLimiter(clock);
    const stale = reserve(limiter);
    clock.advance(MINUTE);
    reserve(limiter);
    reserve(limiter);

    limiter.refund(stale);
    assert.equal(limiter.admit([{ key: 'k', limit }]).allowed, false, 'the new window keeps both');
  });

  /** Raised by Qodo on PR #63: a replay must not take a later request's charge. */
  test('a replayed or forged reservation refunds nothing', () => {
    const limiter = new InMemoryRateLimiter(new ManualClock(1000));
    const first = reserve(limiter);
    reserve(limiter);
    limiter.refund(first);
    reserve(limiter);

    limiter.refund(first);
    limiter.refund(first.map((r) => ({ ...r })));
    assert.equal(limiter.admit([{ key: 'k', limit }]).allowed, false, 'both live charges survive');
  });

  test('a refund touches only the buckets it names', () => {
    const limiter = new InMemoryRateLimiter(new ManualClock(1000));
    const one: RateLimit = { maxRequests: 1, windowMs: MINUTE };
    const reservations = limiter.admit([
      { key: 'a', limit: one, refundable: true },
      { key: 'b', limit: one, refundable: true },
    ]).reservations ?? [];
    limiter.refund(reservations.filter((r) => r.key === 'a'));

    assert.equal(limiter.admit([{ key: 'a', limit: one }]).allowed, true);
    assert.equal(limiter.admit([{ key: 'b', limit: one }]).allowed, false);
  });

  test('a key named twice in a refund is a programming error', () => {
    const limiter = new InMemoryRateLimiter(new ManualClock(1000));
    const [reservation] = reserve(limiter);
    assert.throws(() => limiter.refund([reservation!, reservation!]), /duplicate bucket key/);
  });
});
