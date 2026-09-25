import test from 'node:test';
import assert from 'node:assert/strict';
import { startHarness } from './helpers';
import { BOT_ACCOUNTS } from '../src/bot/catalogue';
import { Game } from '@chess-platform/game';

test('POST /v1/games/bot creates games against each bot level', async () => {
  const h = await startHarness();
  try {
    const human = await h.makeUser('alice-player');

    for (const bot of BOT_ACCOUNTS) {
      const res = await h.json('POST', '/v1/games/bot', {
        token: human.token,
        body: {
          level: bot.level,
          variant: 'standard',
          timeControl: { kind: 'increment', initialMs: 300000, incrementMs: 3000, delayMs: 0 },
          color: 'white',
        },
      });

      assert.equal(res.status, 200);
      assert.equal(res.body.rated, false, 'bot games must be unrated');
      assert.equal(res.body.whiteId, human.userId);
      assert.equal(res.body.blackId, bot.userId);

      // Verify persistence in repos
      const storedGame = await h.repos.games.findById(res.body.id);
      assert.ok(storedGame, 'game row must be created');
      assert.equal(storedGame.whiteId, human.userId);
      assert.equal(storedGame.blackId, bot.userId);
      assert.equal(storedGame.rated, false);

      const events = await h.repos.events.load(res.body.id);
      assert.ok(events.length > 0, 'game events must be created');
      assert.equal(events[0]!.event.type, 'GameCreated');
    }
  } finally {
    await h.close();
  }
});

test('POST /v1/games/bot rejects unknown bot level with 400', async () => {
  const h = await startHarness();
  try {
    const human = await h.makeUser('bob-player');

    const res = await h.json('POST', '/v1/games/bot', {
      token: human.token,
      body: {
        level: 'grandmaster',
        variant: 'standard',
        timeControl: { kind: 'unlimited', initialMs: 0, incrementMs: 0, delayMs: 0 },
      },
    });

    assert.equal(res.status, 400);
    assert.ok(res.body.error.message.includes('novice, club, master'), 'error message names valid levels');
  } finally {
    await h.close();
  }
});

test('InMemoryGameStarter returns false on duplicate gameId and does not duplicate', async () => {
  const h = await startHarness();
  try {
    const gameId = '00000000-0000-7000-8000-000000000099';
    const { events } = Game.create({
      gameId,
      variant: 'standard',
      timeControl: { kind: 'unlimited', initialMs: 0, incrementMs: 0, delayMs: 0 },
      players: { white: 'player-1', black: 'player-2' },
      rated: false,
      at: Date.now(),
    });

    const gameStart = {
      id: gameId,
      variant: 'standard' as const,
      rated: false,
      speed: 'blitz' as const,
      whiteId: 'player-1',
      blackId: 'player-2',
      startedAt: new Date(),
    };

    const first = await h.repos.gameStarter.start(gameId, events, gameStart);
    assert.equal(first, true);

    const second = await h.repos.gameStarter.start(gameId, events, gameStart);
    assert.equal(second, false, 'duplicate gameId must return false');
  } finally {
    await h.close();
  }
});

test('registration refuses a reserved engine bot handle', async () => {
  // Migration 0021 seeds these handles, and `users.handle` is UNIQUE. A human holding one turns
  // that migration into a unique violation that aborts the deploy, so the handles are unclaimable.
  const h = await startHarness();
  try {
    for (const bot of BOT_ACCOUNTS) {
      const res = await h.json('POST', '/v1/auth/register', {
        body: { handle: bot.handle, password: 'correct horse battery', email: `${bot.handle}@example.test` },
      });
      assert.equal(res.status, 409, `${bot.handle} must be reserved`);
      assert.equal(res.body.error.code, 'conflict');
    }

    // Case-insensitively, because the column is CITEXT.
    const upper = await h.json('POST', '/v1/auth/register', {
      body: { handle: BOT_ACCOUNTS[0]!.handle.toUpperCase(), password: 'correct horse battery', email: `${BOT_ACCOUNTS[0]!.handle.toUpperCase()}@example.test` },
    });
    assert.equal(upper.status, 409, 'reservation is case-insensitive');

    // An ordinary handle still registers.
    const ok = await h.json('POST', '/v1/auth/register', {
      body: { handle: 'ordinary-human', password: 'correct horse battery', email: 'ordinary-human@example.test' },
    });
    assert.equal(ok.status, 201);
  } finally {
    await h.close();
  }
});
