import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  MAX_GAMES_PER_IMPORT,
  MAX_PGN_BYTES,
  MAX_VARIATION_DEPTH,
  PgnParseError,
  StudyRuleError,
  parsePgn,
  serializePgn,
  serializePgnGames,
  tagValue,
  type PgnGame,
} from '../src';

/** parse → serialize → parse must reach the same tree. Byte equality is not promised; games are. */
function roundTrip(pgn: string): { first: PgnGame; second: PgnGame } {
  const first = parsePgn(pgn)[0];
  assert.ok(first, 'expected at least one game');
  const second = parsePgn(serializePgn(first))[0];
  assert.ok(second, 'expected the serialized game to parse');
  return { first, second };
}

describe('PGN parsing', () => {
  it('reads the seven tag roster and the movetext', () => {
    const pgn = [
      '[Event "Test Event"]',
      '[Site "Cairo"]',
      '[Date "2026.08.02"]',
      '[Round "1"]',
      '[White "Alice"]',
      '[Black "Bob"]',
      '[Result "1-0"]',
      '',
      '1. e4 e5 2. Nf3 Nc6 3. Bb5 a6 1-0',
    ].join('\n');

    const [game] = parsePgn(pgn);
    assert.ok(game);
    assert.equal(game.tags.length, 7);
    assert.equal(tagValue(game, 'White'), 'Alice');
    assert.equal(tagValue(game, 'white'), 'Alice', 'tag lookup is case-insensitive per the spec');
    assert.equal(game.result, '1-0');
    assert.deepEqual(
      game.moves.map((m) => m.san),
      ['e4', 'e5', 'Nf3', 'Nc6', 'Bb5', 'a6']
    );
  });

  it('keeps comments, NAGs and nested variations attached to the right move', () => {
    const pgn = '1. e4 {best by test} $1 e5 (1... c5 {Sicilian} 2. Nf3 (2. Nc3 d6)) 2. Nf3 *';
    const [game] = parsePgn(pgn);
    assert.ok(game);

    assert.deepEqual(game.moves[0]?.comments, ['best by test']);
    assert.deepEqual(game.moves[0]?.nags, [1]);

    // The variation is an alternative to e5, so it hangs off e5 — not off e4, and not off the game.
    const e5 = game.moves[1];
    assert.equal(e5?.san, 'e5');
    assert.equal(e5?.variations.length, 1);

    const sicilian = e5?.variations[0];
    assert.equal(sicilian?.[0]?.san, 'c5');
    assert.deepEqual(sicilian?.[0]?.comments, ['Sicilian']);

    // And the nested alternative to Nf3 sits one level deeper again.
    assert.equal(sicilian?.[1]?.san, 'Nf3');
    assert.equal(sicilian?.[1]?.variations[0]?.[0]?.san, 'Nc3');
  });

  it('reads several games from one file', () => {
    const pgn = '[White "A"]\n\n1. e4 1-0\n\n[White "B"]\n\n1. d4 0-1\n';
    const games = parsePgn(pgn);
    assert.equal(games.length, 2);
    assert.equal(tagValue(games[0]!, 'White'), 'A');
    assert.equal(games[1]?.result, '0-1');
  });

  it('accepts a game with no moves', () => {
    const [game] = parsePgn('[White "A"]\n[Result "*"]\n\n*\n');
    assert.ok(game);
    assert.equal(game.moves.length, 0);
    assert.equal(game.result, '*');
  });

  it('reads CRLF the same as LF', () => {
    const lf = '[White "A"]\n\n1. e4 e5 1-0\n';
    const crlf = lf.replace(/\n/g, '\r\n');
    assert.deepEqual(parsePgn(crlf), parsePgn(lf));
  });

  it('unescapes the two escapes PGN defines, and leaves other backslashes alone', () => {
    const [game] = parsePgn('[Annotator "say \\"hi\\" \\\\ C:\\path"]\n\n*\n');
    // A Windows path in a tag is common in real exports; rejecting a lone backslash would fail on
    // files that are otherwise perfectly good.
    assert.equal(tagValue(game!, 'Annotator'), 'say "hi" \\ C:\\path');
  });

  it('drops move numbers rather than trusting them', () => {
    // The tree already knows the order. A number that disagrees is the file's problem.
    const [game] = parsePgn('1. e4 1... e5 7. Nf3 *');
    assert.deepEqual(game?.moves.map((m) => m.san), ['e4', 'e5', 'Nf3']);
  });

  it('converts all six PGN move suffix annotations to their equivalent NAGs ($1-$6)', () => {
    const pgn = '1. e4! e5? 2. Nf3!! Nc6?? 3. d4!? c5?! *';
    const [game] = parsePgn(pgn);
    assert.ok(game);

    assert.deepEqual(
      game.moves.map((m) => ({ san: m.san, nags: m.nags })),
      [
        { san: 'e4', nags: [1] },
        { san: 'e5', nags: [2] },
        { san: 'Nf3', nags: [3] },
        { san: 'Nc6', nags: [4] },
        { san: 'd4', nags: [5] },
        { san: 'c5', nags: [6] },
      ]
    );
  });

  it('handles check/mate markers, castling, promotion, and explicit NAGs with suffixes', () => {
    const pgn = '1. e8=Q! Qh5+! 2. O-O! Rxe8#?? 3. O-O-O?! Nf3! $16 *';
    const [game] = parsePgn(pgn);
    assert.ok(game);

    assert.deepEqual(
      game.moves.map((m) => ({ san: m.san, nags: m.nags })),
      [
        { san: 'e8=Q', nags: [1] },
        { san: 'Qh5+', nags: [1] },
        { san: 'O-O', nags: [1] },
        { san: 'Rxe8#', nags: [4] },
        { san: 'O-O-O', nags: [6] },
        { san: 'Nf3', nags: [1, 16] },
      ]
    );
  });

  it('converts suffix annotations on moves inside variations', () => {
    const pgn = '1. e4 e5 (1... c5! $16) 2. Nf3! *';
    const [game] = parsePgn(pgn);
    assert.ok(game);

    const e5 = game.moves[1];
    assert.equal(e5?.san, 'e5');
    const c5 = e5?.variations[0]?.[0];
    assert.equal(c5?.san, 'c5');
    assert.deepEqual(c5?.nags, [1, 16]);
  });
});

describe('PGN rejection', () => {
  const cases: ReadonlyArray<readonly [name: string, pgn: string, needle: string]> = [
    ['an unterminated tag value', '[White "Alice\n\n*\n', 'not closed'],
    ['a tag with no value', '[White]\n\n*\n', 'no quoted value'],
    ['a tag that is never closed', '[White "Alice"\n\n*\n', 'not closed'],
    ['an unterminated comment', '1. e4 {never ends *\n', 'Comment is not closed'],
    ['a variation with no parent move', '(1. e4) *\n', 'Variation before any move'],
    ['an unmatched close paren', '1. e4 ) *\n', 'Unmatched closing parenthesis'],
    ['a NAG with no number', '1. e4 $ *\n', 'NAG has no number'],
    ['a token that cannot be a move', '1. e4 hello *\n', 'Not a move'],
    ['a null move', '1. e4 -- *\n', 'Null moves are not supported'],
    ['an unrecognised suffix annotation', '1. e4!!! *\n', 'Unrecognised move annotation'],
  ];

  for (const [name, pgn, needle] of cases) {
    it(`rejects ${name} with a located error`, () => {
      assert.throws(
        () => parsePgn(pgn),
        (err: unknown) => {
          assert.ok(err instanceof PgnParseError, `expected PgnParseError, got ${String(err)}`);
          assert.match(err.message, new RegExp(needle, 'i'));
          // The offset is the point of the error type: "invalid PGN" is unusable against a
          // thousand-line upload, and a location turns a rejected import into a fixable one.
          assert.ok(err.offset >= 0 && err.offset <= pgn.length, 'offset must point into the input');
          return true;
        }
      );
    });
  }

  it('refuses input over the byte cap without parsing it', () => {
    // This is an upload path. An unbounded parser over untrusted input is a denial-of-service
    // primitive, so the cap is checked before a single token is read.
    const huge = 'a'.repeat(MAX_PGN_BYTES + 1);
    assert.throws(
      () => parsePgn(huge),
      (err: unknown) => err instanceof StudyRuleError && err.code === 'too_large'
    );
  });

  it('refuses more games than one import may carry', () => {
    const many = '[White "A"]\n\n1. e4 1-0\n\n'.repeat(MAX_GAMES_PER_IMPORT + 1);
    assert.throws(
      () => parsePgn(many),
      (err: unknown) => err instanceof StudyRuleError && err.code === 'too_large'
    );
  });

  it('refuses variations nested past the depth limit instead of overflowing the stack', () => {
    // Recursive descent over untrusted input needs this: without a depth limit a file of nothing
    // but open parens produces a RangeError from inside the parser, which is a crash, not a
    // rejection.
    const deep = '1. e4' + ' (1. d4'.repeat(MAX_VARIATION_DEPTH + 5);
    assert.throws(
      () => parsePgn(deep),
      (err: unknown) => err instanceof PgnParseError && /nested deeper/i.test(err.message)
    );
  });
});

describe('PGN serialization', () => {
  it('round-trips a game with comments, NAGs and nested variations', () => {
    const { first, second } = roundTrip(
      '[Event "X"]\n[White "A"]\n\n1. e4 {good} $1 e5 (1... c5 2. Nf3 (2. Nc3 d6)) 2. Nf3 Nc6 1-0\n'
    );
    assert.deepEqual(second, first);
  });

  it('round-trips a game with no moves', () => {
    const { first, second } = roundTrip('[White "A"]\n[Result "*"]\n\n*\n');
    assert.deepEqual(second, first);
  });

  it('numbers a black move after a variation so it re-parses onto the right side', () => {
    // Without the `2...` ellipsis the black move binds to the previous move number and the game
    // comes back different — the one formatting detail that is load-bearing rather than cosmetic.
    const { first, second } = roundTrip('1. e4 e5 2. Nf3 (2. Nc3) Nc6 3. Bb5 *');
    assert.deepEqual(second.moves.map((m) => m.san), first.moves.map((m) => m.san));
    assert.deepEqual(second, first);
  });

  it('escapes quotes and backslashes in tag values so they survive a round trip', () => {
    const { first, second } = roundTrip('[Annotator "say \\"hi\\" \\\\ done"]\n\n*\n');
    assert.equal(tagValue(second, 'Annotator'), tagValue(first, 'Annotator'));
  });

  it('keeps a tag value on its own line when it carries a newline or other control character', () => {
    // A tag value is a PGN string, and the parser ends a string at a newline. Writing one verbatim
    // splits the tag across lines and turns the rest of it into movetext (or a parse failure), so the
    // serializer writes each non-printing character as a space, which is what PGN asks of a writer.
    const text = serializePgn({
      tags: [{ key: 'White', value: 'a"]\n[Black "forged"]\r\n\t\u0000\u007f\\x' }],
      preComments: [],
      moves: [],
      result: '*',
    });

    assert.equal(text.split('\n')[0], '[White "a\\"] [Black \\"forged\\"]     \\\\x"]');
    const reparsed = parsePgn(text)[0];
    assert.ok(reparsed);
    assert.deepEqual(reparsed.tags, [{ key: 'White', value: 'a"] [Black "forged"]     \\x' }]);
  });

  it('keeps Unicode in tag values unchanged', () => {
    const { first, second } = roundTrip('[White "Ünïcødé ☃ لاعب"]\n\n*\n');
    assert.equal(tagValue(second, 'White'), 'Ünïcødé ☃ لاعب');
    assert.deepEqual(second, first);
  });

  it('numbers movetext from a stated starting move, including a black first move', () => {
    const game: PgnGame = {
      tags: [],
      preComments: [],
      startingMove: { number: 12, color: 'b' },
      moves: ['Nf6', 'Nc3', 'd5'].map((san) => ({ san, nags: [], comments: [], variations: [] })),
      result: '0-1',
    };

    assert.equal(serializePgn(game), '12... Nf6 13. Nc3 d5 0-1\n');
    assert.deepEqual(parsePgn(serializePgn(game))[0]?.moves.map((m) => m.san), ['Nf6', 'Nc3', 'd5']);
  });

  it('numbers from 1. with White when no starting move is stated', () => {
    const game: PgnGame = {
      tags: [],
      preComments: [],
      moves: ['e4', 'e5'].map((san) => ({ san, nags: [], comments: [], variations: [] })),
      result: '*',
    };

    assert.equal(serializePgn(game), '1. e4 e5 *\n');
  });

  it('neutralises braces in a comment so the export still parses', () => {
    // PGN gives `{...}` no escape mechanism at all — a comment ends at the first `}`. Writing one
    // verbatim does not make a lossy file, it makes a broken one: everything after the brace is
    // re-read as movetext. The substitution is lossy and says so; refusing to export a study
    // because someone typed a brace in a note would be worse.
    // Built directly rather than parsed: a braced comment cannot be *written* in PGN in the first
    // place, so there is no input text to start from. It reaches the serializer from a study whose
    // annotations came in over the API, where nothing stops a person typing one.
    const text = serializePgn({
      tags: [],
      preComments: [],
      moves: [{ san: 'e4', nags: [], comments: ['see line {A} then }B'], variations: [] }],
      result: '*',
    });

    const reparsed = parsePgn(text)[0];
    assert.ok(reparsed, 'the export must still parse');
    assert.deepEqual(reparsed.moves.map((m) => m.san), ['e4'], 'no phantom moves from a stray brace');
    assert.deepEqual(reparsed.moves[0]?.comments, ['see line (A) then )B']);
  });

  it('writes several games so they read back as several games', () => {
    const games = parsePgn('[White "A"]\n\n1. e4 1-0\n\n[White "B"]\n\n1. d4 0-1\n');
    assert.deepEqual(parsePgn(serializePgnGames(games)), games);
  });

  it('semantically round-trips suffix annotations (converting to $n and back)', () => {
    const input = '1. e4! e5?! 2. Bc4!? Nc6 3. Qh5+!! Nf6?? 4. Qxf7#! *';
    const { first, second } = roundTrip(input);

    // The exported text will contain `$1`, `$6`, `$5`, `$3`, `$4`, `$1` instead of `!`, `?!`, etc.
    // The round trip is semantic rather than literal: the NAGs must be present and identical.
    assert.deepEqual(
      first.moves.map((m) => m.nags),
      [[1], [6], [5], [], [3], [4], [1]]
    );
    assert.deepEqual(second, first);
  });
});

describe('PGN error offsets', () => {
  it('points an unrecognised annotation at the first ! rather than at the move', () => {
    // `1. e4!!! *` — the move itself is fine; `!!!` is what the reader has to go and fix, so the
    // offset must land on the first `!` (index 5), not on the `e` at index 3. A range check alone
    // cannot see this: both are inside the input.
    const pgn = '1. e4!!! *\n';
    assert.throws(
      () => parsePgn(pgn),
      (err: unknown) => {
        assert.ok(err instanceof PgnParseError);
        assert.equal(pgn[err.offset], '!', `offset ${err.offset} should sit on the first '!'`);
        assert.equal(err.offset, pgn.indexOf('!'));
        return true;
      }
    );
  });
});
