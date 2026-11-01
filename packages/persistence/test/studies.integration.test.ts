import test from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout } from 'node:timers/promises';
import { join } from 'node:path';
import { createPool } from '../src/pg/pool';
import { migrate } from '../src/pg/migrate';
import { PgStudiesRepository } from '../src/pg/studies';
import { uuidv7 } from '../src/ids';
import { StudyRuleError, type PositionReader, type StudyVariant } from '@chess-platform/studies';
import { Position } from '@chess-platform/core';

const DATABASE_URL = process.env['DATABASE_URL'];
const skip = DATABASE_URL ? false : 'DATABASE_URL not set';

class CorePositionReader implements PositionReader {
  /** Returns legal SAN moves for the supplied position and variant. */
  legalSans(fen: string, variant: StudyVariant = 'standard'): readonly string[] {
    const pos = Position.fromFen(fen, variant);
    return pos.legalMoves().map((m) => pos.toSan(m));
  }
  /** Applies one legal SAN move and returns the resulting FEN. */
  play(fen: string, san: string, variant: StudyVariant = 'standard'): string {
    const pos = Position.fromFen(fen, variant);
    const moves = pos.legalMoves();
    const move = moves.find((m) => pos.toSan(m) === san);
    if (!move) {
      throw new Error(`Illegal move ${san}`);
    }
    return pos.play(move).fen();
  }
  initialFen(variant: StudyVariant = 'standard'): string {
    return Position.initial(variant).fen();
  }
}

interface PgErrorShape {
  code?: string;
  constraint?: string;
}

/** Identifies a PostgreSQL constraint violation without assuming every thrown value is an Error. */
function isPgConstraintViolation(err: unknown, code: string, constraint?: string): boolean {
  if (typeof err !== 'object' || err === null) return false;
  const pgErr = err as PgErrorShape;
  if (pgErr.code !== code) return false;
  if (constraint !== undefined && pgErr.constraint !== constraint) return false;
  return true;
}

test('pg studies repository integration tests', { skip }, async () => {
  const pool = createPool();
  await migrate(pool, join(process.cwd(), 'migrations'));

  const reader = new CorePositionReader();
  const repo = new PgStudiesRepository(pool, reader);

  const createdUserIds: string[] = [];
  /** Inserts and tracks a disposable integration-test user. */
  const createUser = async (name: string): Promise<string> => {
    const id = uuidv7();
    const handle = `usr-${name.toLowerCase()}-${id.slice(0, 8)}`;
    await pool.query(
      `INSERT INTO users (id, handle, email_hash, created_at) VALUES ($1, $2, $3, NOW())`,
      [id, handle, Buffer.from(id)]
    );
    createdUserIds.push(id);
    return id;
  };

  try {
    const alice = await createUser('Alice');
    const bob = await createUser('Bob');
    const charlie = await createUser('Charlie');

    const t0 = new Date('2026-08-02T10:00:00Z');
    const t1 = new Date('2026-08-02T10:01:00Z');
    const t2 = new Date('2026-08-02T10:02:00Z');

    // 1. Invariant 1 & 2: Study creation, single owner index, authority matrix
    const studyId1 = uuidv7();
    const study1 = await repo.createStudy(studyId1, alice, 'Sicilian Defense', 'Repertoire for Black', 'public', t0);
    assert.equal(study1.id, studyId1);
    assert.equal(study1.ownerId, alice);
    assert.equal(study1.variant, 'standard');

    // Partial unique index enforcement on study_collaborators (one owner per study)
    await assert.rejects(
      async () =>
        pool.query(
          `INSERT INTO study_collaborators (study_id, player_id, role) VALUES ($1, $2, 'owner')`,
          [studyId1, bob]
        ),
      (err: unknown) => isPgConstraintViolation(err, '23505')
    );

    // 2. Collaborators and Ownership Transfer (demotes before promoting)
    await repo.addCollaborator(studyId1, alice, bob, 'contributor', t1);
    const collabs = await repo.listCollaborators(studyId1, alice);
    assert.equal(collabs.total, 2);

    // New owner must already be a collaborator
    await assert.rejects(
      async () => repo.transferOwnership(studyId1, alice, charlie, t2),
      (err: unknown) => err instanceof StudyRuleError && err.code === 'not_found'
    );

    // Transfer ownership from Alice to Bob
    const transferRes = await repo.transferOwnership(studyId1, alice, bob, t2);
    assert.equal(transferRes.oldOwner.role, 'contributor');
    assert.equal(transferRes.newOwner.role, 'owner');
    assert.equal(transferRes.study.ownerId, bob);

    // 3. Invariant 3: Visibility levels (private invisible to non-collaborators => not_found; unlisted excluded from list)
    const privStudyId = uuidv7();
    await repo.createStudy(privStudyId, alice, 'Private Study', 'Secret prep', 'private', t0);

    // Non-collaborator gets not_found
    await assert.rejects(
      async () => repo.getStudy(privStudyId, charlie),
      (err: unknown) => err instanceof StudyRuleError && err.code === 'not_found'
    );

    // Unlisted study
    const unlistedId = uuidv7();
    await repo.createStudy(unlistedId, alice, 'Unlisted Prep', 'Shared link only', 'unlisted', t0);

    const publicList = await repo.listStudies();
    const idsInList = publicList.items.map((s) => s.id);
    assert.ok(idsInList.includes(studyId1));
    assert.ok(!idsInList.includes(privStudyId));
    assert.ok(!idsInList.includes(unlistedId));

    // 4. Chapter Management (orderIndex density, reordering, tombstoning)
    const chId1 = uuidv7();
    const ch1 = await repo.createChapter(chId1, studyId1, bob, 'Mainline e4', undefined, t0);
    assert.equal(ch1.orderIndex, 0);

    // Direct repository variant-derived default regression (Qodo c8aa2377):
    const hordeStudyId = uuidv7();
    await repo.createStudy(hordeStudyId, bob, 'Horde Study', '', 'public', t0, { variant: 'horde' });
    const hordeCh1 = await repo.createChapter(uuidv7(), hordeStudyId, bob, 'Horde Default', undefined, t0);
    assert.equal(hordeCh1.startingFen, Position.initial('horde').fen(), 'omitted FEN on Horde study must derive Horde initial position');

    const explicitFen = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';
    const hordeCh2 = await repo.createChapter(uuidv7(), hordeStudyId, bob, 'Horde Explicit', explicitFen, t1);
    assert.equal(hordeCh2.startingFen, explicitFen, 'explicit FEN override must be preserved');

    const rkStudyId = uuidv7();
    await repo.createStudy(rkStudyId, bob, 'RK Study', '', 'public', t0, { variant: 'racingkings' });
    const rkCh = await repo.createChapter(uuidv7(), rkStudyId, bob, 'RK Default', undefined, t0);
    assert.equal(rkCh.startingFen, Position.initial('racingkings').fen(), 'omitted FEN on Racing Kings study must derive RK initial position');

    const chId2 = uuidv7();
    const ch2 = await repo.createChapter(chId2, studyId1, bob, 'Sideline d4', undefined, t1);
    assert.equal(ch2.orderIndex, 1);

    // Unique index on study_id + order_index (when deleted_at IS NULL)
    await assert.rejects(
      async () =>
        pool.query(
          `INSERT INTO study_chapters (id, study_id, name, order_index, starting_fen) VALUES ($1, $2, 'Bad Order', 0, $3)`,
          [uuidv7(), studyId1, ch1.startingFen]
        ),
      (err: unknown) => isPgConstraintViolation(err, '23505')
    );

    // Reorder chapters
    const reordered = await repo.reorderChapters(studyId1, bob, [chId2, chId1], t2);
    assert.equal(reordered[0].id, chId2);
    assert.equal(reordered[0].orderIndex, 0);
    assert.equal(reordered[1].id, chId1);
    assert.equal(reordered[1].orderIndex, 1);

    // Delete chapter (tombstone & re-compact active indices)
    const deletedCh = await repo.deleteChapter(chId2, bob, t2);
    assert.ok(deletedCh.deletedAt);

    await assert.rejects(
      async () => repo.deleteChapter(chId2, bob, t2),
      (err: unknown) => err instanceof StudyRuleError && err.code === 'invalid_transition'
    );

    // 5. Tree Node Management (append, resolve SAN, return existing child, delete node cascade)
    const node1 = await repo.appendNode(chId1, bob, null, 'e4', reader);
    assert.equal(node1.san, 'e4');

    // Duplicate append returns existing child
    const node1Dup = await repo.appendNode(chId1, bob, null, 'e4', reader);
    assert.equal(node1Dup.id, node1.id);

    // Sub-move
    const node2 = await repo.appendNode(chId1, bob, node1.id, 'c5', reader, { comment: 'Sicilian' });
    assert.equal(node2.san, 'c5');
    assert.equal(node2.comment, 'Sicilian');

    // A persisted variant must control FEN parsing and move application after the study is re-read.
    const threeCheckStudyId = uuidv7();
    const threeCheckStudy = await repo.createStudy(
      threeCheckStudyId,
      alice,
      'Three-Check',
      'Counter preservation',
      'private',
      t0,
      { variant: 'threecheck' },
    );
    assert.equal(threeCheckStudy.variant, 'threecheck');
    assert.equal((await repo.getStudy(threeCheckStudyId, alice)).variant, 'threecheck');

    const threeCheckChapterId = uuidv7();
    await repo.createChapter(
      threeCheckChapterId,
      threeCheckStudyId,
      alice,
      'Counter line',
      '4k3/8/8/8/8/8/8/3R3K w - - 3+3 0 1',
      t0,
    );
    const checkingNode = await repo.appendNode(threeCheckChapterId, alice, null, 'Re1+', reader);
    assert.match(checkingNode.fenAfter, / 2\+3 1 1$/);

    // Delete root node cascades to sub-move
    await repo.deleteNode(node1.id, bob);
    const { tree } = await repo.getChapter(chId1, bob);
    assert.equal(tree.length, 0);

    // 6. Import & Export PGN
    const pgnSample = `[Event "Test Import"]
[Site "?"]
[Date "????.??.??"]
[Round "?"]
[White "Player1"]
[Black "Player2"]
[Result "*"]

1. e4 e5 (1... c5 2. Nf3) 2. Nf3 Nc6 *`;

    const importedChapters = await repo.importPgn(studyId1, bob, pgnSample, reader, t2);
    assert.equal(importedChapters.length, 1);
    assert.equal(importedChapters[0].name, 'Player1 vs Player2');

    const exportedPgn = await repo.exportPgn(studyId1, bob, importedChapters[0].id);
    assert.ok(exportedPgn.includes('1. e4 e5'));
    assert.ok(exportedPgn.includes('1... c5'));

    // Two different rejections, and the difference is the point. A token that cannot be SAN under
    // any position is a malformed FILE, caught while parsing and pointing at the offset. A token
    // that is well-formed SAN but not playable HERE is a malformed GAME, caught while resolving
    // against the board. Collapsing them would leave whoever uploaded the file guessing which of
    // the two they have.
    const chaptersBeforeFailures = await repo.listChapters(studyId1, bob);

    await assert.rejects(
      async () => repo.importPgn(studyId1, bob, `[Event "Bad"]\n\n1. e4 invalidmove *`, reader, t2),
      (err: unknown) => err instanceof StudyRuleError && err.code === 'invalid_input'
    );

    // `Nf6` is perfectly good SAN — there is simply no white knight that can reach f6 on move 2.
    await assert.rejects(
      async () => repo.importPgn(studyId1, bob, `[Event "Bad"]\n\n1. e4 e5 2. Nf6 *`, reader, t2),
      (err: unknown) =>
        err instanceof StudyRuleError && err.code === 'invalid_move' && /Nf6/.test(err.message)
    );

    // And neither rejected import may leave anything behind. A half-written chapter looks complete
    // to a reader, who cannot tell it from a game that really ended where the import stopped.
    const chaptersAfterFailures = await repo.listChapters(studyId1, bob);
    assert.equal(
      chaptersAfterFailures.length,
      chaptersBeforeFailures.length,
      'a rejected import must not create a chapter'
    );

    // 7. Staged Concurrency Test: outside transaction holding study advisory lock
    const concurStudyId = uuidv7();
    await repo.createStudy(concurStudyId, alice, 'Concur Study', 'Test', 'private', t0);

    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(
        `SELECT pg_advisory_xact_lock(hashtextextended('study:' || $1::text, 0))`,
        [concurStudyId]
      );

      const updating = repo
        .updateStudy(concurStudyId, alice, { name: 'Updated Concur' }, t1)
        .then((s) => s.name, (err: unknown) => (err instanceof Error ? err.message : String(err)));

      await setTimeout(250); // let the update call reach its wait on advisory lock

      await client.query(`SELECT id FROM studies WHERE id = $1 FOR UPDATE`, [concurStudyId]);
      await client.query('COMMIT');

      assert.equal(
        await updating,
        'Updated Concur',
        'updateStudy must acquire the advisory lock before row locks, or staged locks deadlock'
      );
    } finally {
      client.release();
    }

    // 8. Malformed UUID parameter handling (must answer not_found, not 500 driver error)
    for (const badId of ['not-a-uuid', 'bad-id-123']) {
      await assert.rejects(
        async () => repo.getStudy(badId, alice),
        (err: unknown) => err instanceof StudyRuleError && err.code === 'not_found',
        `getStudy('${badId}') must yield not_found`
      );
    }

    // 9. Foreign Key Cascades: Deleting user cascades to studies
    const cascadeUser = await createUser('CascadeUser');
    const cascadeStudyId = uuidv7();
    await repo.createStudy(cascadeStudyId, cascadeUser, 'Cascade Study', 'Desc', 'public', t0);

    await pool.query(`DELETE FROM users WHERE id = $1`, [cascadeUser]);

    await assert.rejects(
      async () => repo.getStudy(cascadeStudyId, alice),
      (err: unknown) => err instanceof StudyRuleError && err.code === 'not_found'
    );

    // 10. Closed variant catalog and studies FK integrity (migrations 0028-0031)
    const domainRes = await pool.query<{ convalidated: boolean }>(`
      SELECT convalidated
      FROM pg_constraint
      WHERE conrelid = 'variants'::regclass
        AND contype = 'c'
        AND conname = 'variants_code_check'
    `);
    assert.deepEqual(domainRes.rows, [{ convalidated: true }]);

    // 10.1 Metadata verification: FK constraint exists and points to variants(code)
    const fkRes = await pool.query<{
      constraint_name: string;
      table_name: string;
      column_name: string;
      foreign_table_name: string;
      foreign_column_name: string;
    }>(`
      SELECT
        tc.constraint_name,
        tc.table_name,
        kcu.column_name,
        ccu.table_name AS foreign_table_name,
        ccu.column_name AS foreign_column_name
      FROM information_schema.table_constraints tc
      JOIN information_schema.key_column_usage kcu
        ON tc.constraint_name = kcu.constraint_name AND tc.table_schema = kcu.table_schema
      JOIN information_schema.constraint_column_usage ccu
        ON ccu.constraint_name = tc.constraint_name AND ccu.table_schema = tc.table_schema
      WHERE tc.table_name = 'studies'
        AND tc.constraint_type = 'FOREIGN KEY'
        AND kcu.column_name = 'variant'
    `);
    assert.equal(fkRes.rows.length, 1, 'expected exactly one FK constraint on studies.variant');
    assert.equal(fkRes.rows[0]?.constraint_name, 'studies_variant_fk');
    assert.equal(fkRes.rows[0]?.foreign_table_name, 'variants');
    assert.equal(fkRes.rows[0]?.foreign_column_name, 'code');

    // 10.2 Absence of old CHECK constraint
    const oldCheckRes = await pool.query<{ conname: string }>(`
      SELECT conname
      FROM pg_constraint
      WHERE conrelid = 'studies'::regclass
        AND contype = 'c'
        AND conname = 'studies_variant_check'
    `);
    assert.equal(oldCheckRes.rows.length, 0, 'old CHECK constraint studies_variant_check must no longer exist');

    // 10.3 The catalog rejects noncanonical codes before they can broaden FK consumers.
    await assert.rejects(
      pool.query(`INSERT INTO variants (code, name) VALUES ('noncanonical_variant', 'Invalid')`),
      (err: unknown) => isPgConstraintViolation(err, '23514', 'variants_code_check'),
      'inserting a noncanonical catalog code must raise check_violation (23514)'
    );

    // An unsupported study remains rejected by the FK.
    const badStudyId = uuidv7();
    await assert.rejects(
      async () =>
        pool.query(
          `INSERT INTO studies (id, owner_id, name, description, visibility, variant, created_at, updated_at)
           VALUES ($1, $2, 'Bad Variant Study', '', 'public', 'nonexistent_variant', NOW(), NOW())`,
          [badStudyId, alice]
        ),
      (err: unknown) => isPgConstraintViolation(err, '23503', 'studies_variant_fk'),
      'inserting an invalid variant must raise foreign_key_violation (23503) referencing studies_variant_fk'
    );

    // 10.4 All 8 canonical StudyVariants can be created and queried through repository
    const ALL_VARIANTS: readonly StudyVariant[] = [
      'standard',
      'chess960',
      'kingofthehill',
      'atomic',
      'crazyhouse',
      'threecheck',
      'horde',
      'racingkings',
    ];
    for (const v of ALL_VARIANTS) {
      const vStudyId = uuidv7();
      const vStudy = await repo.createStudy(vStudyId, alice, `Study ${v}`, '', 'public', t0, { variant: v });
      assert.equal(vStudy.id, vStudyId);
      assert.equal(vStudy.variant, v);
      const fetched = await repo.getStudy(vStudyId, alice);
      assert.equal(fetched.variant, v);
    }

  } finally {
    if (createdUserIds.length > 0) {
      await pool.query(`DELETE FROM users WHERE id = ANY($1)`, [createdUserIds]);
    }
    await pool.end();
  }
});
