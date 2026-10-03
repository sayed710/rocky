import assert from 'node:assert/strict';
import { test } from 'node:test';
import { InMemoryEventStore, type StoredEvent } from '@chess-platform/persistence';
import { InMemoryAntiCheatReportRepository, InMemoryBotBehaviorReportRepository } from '@chess-platform/anti-cheat';
import { AntiCheatAnalysisService } from '../src/anti-cheat/analysis-service';
import { EventStoreGameSource } from '../src/anti-cheat/source';
import { BotAnalysisService } from '../src/bot-detection/analysis-service';
import { EventStoreBotTimingSource } from '../src/bot-detection/source';

for (const consumer of ['bot', 'anti-cheat'] as const) {
  test(`${consumer} lease cancellation prevents replay and analysis after a delayed source read`, async () => {
    const store = new InMemoryEventStore();
    let loads = 0;
    let replayReads = 0;
    let release!: (events: StoredEvent[]) => void;
    store.load = async () => {
      loads++;
      return new Promise<StoredEvent[]>((resolve) => { release = resolve; });
    };
    const analyze = consumer === 'bot'
      ? (() => {
        const service = new BotAnalysisService(new EventStoreBotTimingSource(store), new InMemoryBotBehaviorReportRepository());
        return (signal: AbortSignal) => service.analyzeAndStore('leased-game', signal);
      })()
      : (() => {
        const service = new AntiCheatAnalysisService(new EventStoreGameSource(store), () => {
          assert.fail('a lost lease must never construct an engine evaluator');
        }, new InMemoryAntiCheatReportRepository());
        return (signal: AbortSignal) => service.analyzeAndStore('leased-game', { signal });
      })();

    const alreadyLost = new AbortController();
    alreadyLost.abort(new Error('lease lost before loading'));
    await assert.rejects(analyze(alreadyLost.signal), /lease lost before loading/);
    assert.equal(loads, 0);

    const lease = new AbortController();
    const pending = analyze(lease.signal);
    assert.equal(loads, 1);
    lease.abort(new Error('lease lost during loading'));
    // Touching this event would begin replay. A late read must be discarded before that boundary.
    const event = Object.defineProperty({}, 'event', { get: () => { replayReads++; throw new Error('replay began'); } });
    release([event as StoredEvent]);
    await assert.rejects(pending, /lease lost during loading/);
    assert.equal(replayReads, 0);
  });
}
