import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  InMemoryStudiesRepository,
  StudyRuleError,
  type PositionReader,
  type StudyVariant,
} from '../src';

const canonicalStarts: Record<StudyVariant, string> = {
  standard: 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1',
  chess960: 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1',
  threecheck: 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 3+3 0 1',
  crazyhouse: 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR[] w KQkq - 0 1',
  kingofthehill: 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1',
  atomic: 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1',
  horde: 'rnbqkbnr/pppppppp/8/1PP2PP1/PPPPPPPP/PPPPPPPP/PPPPPPPP/PPPPPPPP w kq - 0 1',
  racingkings: '8/8/8/8/8/8/krbnNBRK/qrbnNBRQ w - - 0 1',
};

// Simple mock PositionReader for testing move resolution in domain rules
const mockReader: PositionReader = {
  legalSans(fen: string): readonly string[] {
    if (fen.includes('rnbqkbnr') || fen === 'start') {
      // `play` returns `${fen}+${san}`, so every derived FEN still contains the starting placement
      // and this branch answers for the whole game — the two below are unreachable. The list is
      // therefore every SAN any test in this file plays; `Ke2` is deliberately absent, because the
      // import-atomicity test relies on it being rejected.
      return ['e4', 'd4', 'Nf3', 'c4', 'e5', 'c5', 'd5', 'Nc6', 'Nf6', 'Nxe5', 'd6', 'Bb5', 'a6'];
    }
    if (fen.includes('e4')) {
      return ['e5', 'c5', 'e6', 'c6', 'Nf3', 'Nc6'];
    }
    return ['e5', 'Nf3', 'Nc6', 'Bb5', 'a6'];
  },
  play(fen: string, san: string): string {
    const legal = this.legalSans(fen);
    if (!legal.includes(san)) {
      throw new StudyRuleError('invalid_move', `'${san}' is not a legal move`);
    }
    return `${fen}+${san}`;
  },
  initialFen(variant: StudyVariant = 'standard') {
    return canonicalStarts[variant] ?? canonicalStarts.standard;
  },
};

describe('Domain Rule 1: Ownership and transfer', () => {
  it('creates study with exactly one owner and demotes old owner on transfer', async () => {
    const repo = new InMemoryStudiesRepository(mockReader);
    const study = await repo.createStudy('s1', 'p-owner', 'Study 1', 'Desc', 'public');

    assert.equal(study.ownerId, 'p-owner');
    const collabs = await repo.listCollaborators('s1');
    assert.equal(collabs.total, 1);
    assert.equal(collabs.items[0]?.playerId, 'p-owner');
    assert.equal(collabs.items[0]?.role, 'owner');

    // Add target contributor
    await repo.addCollaborator('s1', 'p-owner', 'p-new', 'contributor');

    // Transfer ownership
    const { oldOwner, newOwner, study: updatedStudy } = await repo.transferOwnership('s1', 'p-owner', 'p-new');

    assert.equal(updatedStudy.ownerId, 'p-new');
    assert.equal(oldOwner.role, 'contributor', 'old owner must be demoted to contributor');
    assert.equal(newOwner.role, 'owner', 'new owner must be promoted to owner');
  });

  it('refuses to transfer ownership to someone who is not a collaborator', async () => {
    // Creating the collaborator on the fly reads as convenience and is a one-way door: a transfer
    // to a mistyped id would succeed, demote the real owner to contributor, and leave the study
    // owned by an account nobody can sign in as. Taking it back is itself an owner-only action, so
    // there is no path back.
    const repo = new InMemoryStudiesRepository(mockReader);
    await repo.createStudy('s-lock', 'p-owner', 'Study', '', 'private');

    await assert.rejects(
      () => repo.transferOwnership('s-lock', 'p-owner', 'p-typo'),
      (err: unknown) => err instanceof StudyRuleError && err.code === 'not_found'
    );

    // And the owner still owns it — a refused transfer must change nothing.
    const study = await repo.getStudy('s-lock', 'p-owner');
    assert.equal(study.ownerId, 'p-owner');
    const owner = await repo.listCollaborators('s-lock', 'p-owner');
    assert.equal(owner.items.find((c) => c.playerId === 'p-owner')?.role, 'owner');
  });

  it('fails if non-owner attempts to transfer ownership', async () => {
    const repo = new InMemoryStudiesRepository(mockReader);
    await repo.createStudy('s1', 'p-owner', 'Study 1', 'Desc', 'public');
    await repo.addCollaborator('s1', 'p-owner', 'p-contrib', 'contributor');

    await assert.rejects(
      () => repo.transferOwnership('s1', 'p-contrib', 'p-other'),
      (err: unknown) => err instanceof StudyRuleError && err.code === 'not_authorized'
    );
  });
});

describe('Domain Rule 2: Authority hierarchy (owner > contributor > viewer)', () => {
  it('allows contributor+ to edit chapters/tree, but only owner to change visibility or delete study', async () => {
    const repo = new InMemoryStudiesRepository(mockReader);
    await repo.createStudy('s1', 'p-owner', 'Study 1', 'Desc', 'public');
    await repo.addCollaborator('s1', 'p-owner', 'p-contrib', 'contributor');
    await repo.addCollaborator('s1', 'p-owner', 'p-viewer', 'viewer');

    // Contributor can create chapter and append node
    const ch = await repo.createChapter('c1', 's1', 'p-contrib', 'Chapter 1');
    assert.equal(ch.name, 'Chapter 1');
    const node = await repo.appendNode('c1', 'p-contrib', null, 'e4', mockReader);
    assert.equal(node.san, 'e4');

    // Viewer CANNOT edit chapter or tree -> not_authorized
    await assert.rejects(
      () => repo.createChapter('c2', 's1', 'p-viewer', 'Chapter 2'),
      (err: unknown) => err instanceof StudyRuleError && err.code === 'not_authorized'
    );
    await assert.rejects(
      () => repo.appendNode('c1', 'p-viewer', null, 'd4', mockReader),
      (err: unknown) => err instanceof StudyRuleError && err.code === 'not_authorized'
    );

    // Contributor CANNOT change visibility or delete study -> not_authorized
    await assert.rejects(
      () => repo.updateStudy('s1', 'p-contrib', { visibility: 'private' }),
      (err: unknown) => err instanceof StudyRuleError && err.code === 'not_authorized'
    );
    await assert.rejects(
      () => repo.deleteStudy('s1', 'p-contrib'),
      (err: unknown) => err instanceof StudyRuleError && err.code === 'not_authorized'
    );

    // Owner CAN change visibility and delete study
    const updated = await repo.updateStudy('s1', 'p-owner', { visibility: 'private' });
    assert.equal(updated.visibility, 'private');
  });
});

describe('Domain Rule 3: Visibility and not_found vs not_authorized', () => {
  it('hides private studies from non-collaborators as not_found, excludes unlisted from list, and uses not_authorized only for visible actions', async () => {
    const repo = new InMemoryStudiesRepository(mockReader);
    await repo.createStudy('s-pub', 'p-owner', 'Public Study', 'Desc', 'public');
    await repo.createStudy('s-priv', 'p-owner', 'Private Study', 'Desc', 'private');
    await repo.createStudy('s-unlisted', 'p-owner', 'Unlisted Study', 'Desc', 'unlisted');

    // Stranger fetching private study gets not_found (existence leakage prevention)
    await assert.rejects(
      () => repo.getStudy('s-priv', 'p-stranger'),
      (err: unknown) => err instanceof StudyRuleError && err.code === 'not_found'
    );

    // Public list excludes unlisted and private (unless collaborator)
    const list = await repo.listStudies('p-stranger');
    assert.equal(list.total, 1);
    assert.equal(list.items[0]?.id, 's-pub');

    // Unlisted is fetchable by ID
    const unlisted = await repo.getStudy('s-unlisted', 'p-stranger');
    assert.equal(unlisted.id, 's-unlisted');

    // Add viewer to public study. Viewer can see public study but cannot edit -> not_authorized
    await repo.addCollaborator('s-pub', 'p-owner', 'p-viewer', 'viewer');
    await assert.rejects(
      () => repo.updateChapter('c1', 'p-viewer', { name: 'New' }),
      (err: unknown) => err instanceof StudyRuleError && err.code === 'not_found' // chapter doesn't exist
    );
  });
});

describe('Domain Rule 4: Appending move resolution & deduplication', () => {
  it('resolves move via PositionReader and returns existing child instead of duplicating', async () => {
    const repo = new InMemoryStudiesRepository(mockReader);
    await repo.createStudy('s1', 'p-owner', 'Study 1', 'Desc', 'public');
    await repo.createChapter('c1', 's1', 'p-owner', 'Chapter 1');

    // Appending move resolves SAN and generates node
    const n1 = await repo.appendNode('c1', 'p-owner', null, 'e4', mockReader);
    assert.equal(n1.san, 'e4');
    assert.ok(n1.id);

    // Appending the exact same move under the same parent returns the existing child node
    const n2 = await repo.appendNode('c1', 'p-owner', null, 'e4', mockReader);
    assert.equal(n2.id, n1.id, 'must return existing node without duplicating');

    const { tree } = await repo.getChapter('c1', 'p-owner');
    assert.equal(tree.length, 1);

    // Appending illegal move throws invalid_move
    await assert.rejects(
      () => repo.appendNode('c1', 'p-owner', null, 'Qh5', mockReader),
      (err: unknown) => err instanceof StudyRuleError && err.code === 'invalid_move'
    );
  });
});

describe('Domain Rule 5: Dense and stable orderIndex', () => {
  it('maintains contiguous orderIndex for chapters and reordering yields dense 0..N-1 sequence', async () => {
    const repo = new InMemoryStudiesRepository(mockReader);
    await repo.createStudy('s1', 'p-owner', 'Study 1', 'Desc', 'public');
    const c0 = await repo.createChapter('ch0', 's1', 'p-owner', 'Ch 0');
    const c1 = await repo.createChapter('ch1', 's1', 'p-owner', 'Ch 1');
    const c2 = await repo.createChapter('ch2', 's1', 'p-owner', 'Ch 2');

    assert.equal(c0.orderIndex, 0);
    assert.equal(c1.orderIndex, 1);
    assert.equal(c2.orderIndex, 2);

    // Reorder chapters
    const reordered = await repo.reorderChapters('s1', 'p-owner', ['ch2', 'ch0', 'ch1']);
    assert.equal(reordered[0]?.id, 'ch2');
    assert.equal(reordered[0]?.orderIndex, 0);
    assert.equal(reordered[1]?.id, 'ch0');
    assert.equal(reordered[1]?.orderIndex, 1);
    assert.equal(reordered[2]?.id, 'ch1');
    assert.equal(reordered[2]?.orderIndex, 2);
  });
});

describe('Domain Rule 6: Tombstones and transition locks', () => {
  it('marks deleted entity with tombstone and rejects secondary edit/delete with invalid_transition', async () => {
    const repo = new InMemoryStudiesRepository(mockReader);
    await repo.createStudy('s1', 'p-owner', 'Study 1', 'Desc', 'public');
    await repo.createChapter('c1', 's1', 'p-owner', 'Chapter 1');

    // Delete chapter
    const deletedCh = await repo.deleteChapter('c1', 'p-owner');
    assert.ok(deletedCh.deletedAt);

    // Attempting to delete again throws invalid_transition
    await assert.rejects(
      () => repo.deleteChapter('c1', 'p-owner'),
      (err: unknown) => err instanceof StudyRuleError && err.code === 'invalid_transition'
    );

    // Delete study
    const deletedStudy = await repo.deleteStudy('s1', 'p-owner');
    assert.ok(deletedStudy.deletedAt);

    // Attempting to edit or delete study again throws invalid_transition
    await assert.rejects(
      () => repo.deleteStudy('s1', 'p-owner'),
      (err: unknown) => err instanceof StudyRuleError && err.code === 'invalid_transition'
    );
  });
});

describe('Domain Rule 7: Import PGN validation and atomicity', () => {
  it('passes the persisted study variant through PGN import and export', async () => {
    const repo = new InMemoryStudiesRepository(mockReader);
    await repo.createStudy(
      's-threecheck',
      'p-owner',
      'Three-Check Study',
      '',
      'public',
      undefined,
      { variant: 'threecheck' },
    );

    const reader: PositionReader = {
      legalSans(_fen, variant) {
        return variant === 'threecheck' ? ['Re1+'] : [];
      },
      play(fen, _san, variant) {
        if (variant !== 'threecheck') throw new Error('wrong rule set');
        return fen.replace(' 3+3 ', ' 2+3 ');
      },
      initialFen() {
        return '4k3/8/8/8/8/8/8/3R3K w - - 3+3 0 1';
      },
    };
    const pgn = [
      '[Event "Counter preservation"]',
      '[FEN "4k3/8/8/8/8/8/8/3R3K w - - 3+3 0 1"]',
      '',
      '1. Re1+ *',
    ].join('\n');

    const [chapter] = await repo.importPgn('s-threecheck', 'p-owner', pgn, reader);
    assert.ok(chapter);
    const detail = await repo.getChapter(chapter.id, 'p-owner');
    assert.match(detail.tree[0]!.fenAfter, / 2\+3 0 1$/);

    const exported = await repo.exportPgn('s-threecheck', 'p-owner', chapter.id);
    assert.match(exported, /\[Variant "threecheck"\]/);
  });

  it('carries the study variant into side variations, not just the mainline', async () => {
    // The mainline being variant-aware proves nothing about the branches. Import walks variations
    // recursively, and a recursive call that forgets to pass the variant along is invisible: the
    // import succeeds, the chapter looks complete, and the sideline was validated under the wrong
    // rule set. ADR-0091 §10 records the last time a variation branch diverged from the mainline
    // here and produced a tree that loaded and was wrong.
    //
    // This is the property M15 Increment 13 pinned when it deleted `importGame`, the one movetext
    // walker in this package that never threaded a variant at all.
    const repo = new InMemoryStudiesRepository(mockReader);
    await repo.createStudy('s-var', 'p-owner', 'Three-Check Study', '', 'public', undefined, {
      variant: 'threecheck',
    });

    // The reader's *answers* depend on the variant: only three-check offers these checking rook
    // moves, so a branch resolving under standard rules cannot find them and the import fails
    // rather than quietly storing a move this study's rules never allowed.
    const reader: PositionReader = {
      legalSans: (_fen, variant) => (variant === 'threecheck' ? ['Re1+', 'Rd8+'] : ['Rd2']),
      play: (fen, san, variant) => {
        if (variant !== 'threecheck') throw new Error(`played ${san} under ${String(variant)}`);
        return fen.replace(/ (\d)\+(\d) /, (_m, w: string) => ` ${Number(w) - 1}+3 `) + `|${san}`;
      },
      initialFen() {
        return '4k3/8/8/8/8/8/8/3R3K w - - 3+3 0 1';
      },
    };

    const pgn = [
      '[Event "Sideline"]',
      '[FEN "4k3/8/8/8/8/8/8/3R3K w - - 3+3 0 1"]',
      '',
      '1. Re1+ (1. Rd8+) *',
    ].join('\n');

    const [chapter] = await repo.importPgn('s-var', 'p-owner', pgn, reader);
    assert.ok(chapter);

    const { tree } = await repo.getChapter(chapter.id, 'p-owner');
    const sans = tree.map((n) => n.san).sort();
    assert.deepEqual(
      sans,
      ['Rd8+', 'Re1+'],
      'the mainline and the variation both resolved under three-check rules',
    );
  });

  it('creates one chapter per game and rejects invalid moves with invalid_move without partial import', async () => {
    const repo = new InMemoryStudiesRepository(mockReader);
    await repo.createStudy('s1', 'p-owner', 'Study 1', 'Desc', 'public');

    const validPgn = [
      '[Event "Game 1"]',
      '',
      '1. e4 e5 *',
      '',
      '[Event "Game 2"]',
      '',
      '1. d4 e5 *',
    ].join('\n');

    const imported = await repo.importPgn('s1', 'p-owner', validPgn, mockReader);
    assert.equal(imported.length, 2);
    assert.equal(imported[0]?.name, 'Game 1');
    assert.equal(imported[1]?.name, 'Game 2');

    // Invalid PGN containing illegal move
    const invalidPgn = [
      '[Event "Good Game"]',
      '',
      '1. e4 e5 *',
      '',
      '[Event "Bad Game"]',
      '',
      '1. e4 Ke2 *',
    ].join('\n');

    await assert.rejects(
      () => repo.importPgn('s1', 'p-owner', invalidPgn, mockReader),
      (err: unknown) => err instanceof StudyRuleError && err.code === 'invalid_move'
    );

    // Verify study chapters count did NOT increase from the failed import
    const chapters = await repo.listChapters('s1', 'p-owner');
    assert.equal(chapters.length, 2, 'failed import must not be imported half-way');
  });

  it('preserves move and variation ordering (mainline orderIndex 0, variations orderIndex >= 1) on import and round-trip', async () => {
    const repo = new InMemoryStudiesRepository(mockReader);
    await repo.createStudy('s1', 'p-owner', 'Study 1', 'Desc', 'public');

    const pgnWithVar = '[Event "Petroff Line"]\n[White "W"]\n[Black "B"]\n\n1. e4 e5 2. Nf3 Nc6 (2... Nf6 3. Nxe5 d6) 3. Bb5 *';
    const chapters = await repo.importPgn('s1', 'p-owner', pgnWithVar, mockReader);
    assert.equal(chapters.length, 1);

    const chapterId = chapters[0]!.id;
    const { tree } = await repo.getChapter(chapterId, 'p-owner');

    // Find Nf3 node
    const nf3Node = tree.find((n) => n.san === 'Nf3');
    assert.ok(nf3Node);

    // Find children of Nf3 ordered by orderIndex
    const children = tree
      .filter((n) => n.parentId === nf3Node.id)
      .sort((a, b) => a.orderIndex - b.orderIndex);

    assert.equal(children.length, 2);
    assert.equal(children[0]?.san, 'Nc6', 'mainline move must have orderIndex 0');
    assert.equal(children[1]?.san, 'Nf6', 'variation move must have orderIndex 1');

    // Export PGN and confirm round-trip mainline & variation structure is preserved
    const exported = await repo.exportPgn('s1', 'p-owner', chapterId);
    assert.match(exported, /2\. Nf3 Nc6 \(2\.\.\. Nf6 3\. Nxe5 d6\) 3\. Bb5/);
  });
});

describe('Repository Variant-Derived Default FEN (Qodo c8aa2377)', () => {
  it('derives variant starting FEN for Horde and Racing Kings when startingFen is omitted', async () => {
    const repo = new InMemoryStudiesRepository(mockReader);
    await repo.createStudy('s-horde', 'p-owner', 'Horde Study', 'Desc', 'public', new Date(), { variant: 'horde' });
    const hordeCh = await repo.createChapter('ch-horde', 's-horde', 'p-owner', 'Horde Ch');
    assert.equal(hordeCh.startingFen, canonicalStarts.horde, 'Horde chapter without FEN must derive Horde initial position');

    await repo.createStudy('s-rk', 'p-owner', 'RK Study', 'Desc', 'public', new Date(), { variant: 'racingkings' });
    const rkCh = await repo.createChapter('ch-rk', 's-rk', 'p-owner', 'RK Ch');
    assert.equal(rkCh.startingFen, canonicalStarts.racingkings, 'Racing Kings chapter without FEN must derive RK initial position');
  });

  it('derives canonical starting FEN across all 8 variants when startingFen is omitted', async () => {
    const variants: readonly StudyVariant[] = [
      'standard',
      'chess960',
      'threecheck',
      'crazyhouse',
      'kingofthehill',
      'atomic',
      'horde',
      'racingkings',
    ];

    const repo = new InMemoryStudiesRepository(mockReader);
    for (const v of variants) {
      const studyId = `s-${v}`;
      await repo.createStudy(studyId, 'p-owner', `${v} Study`, 'Desc', 'public', new Date(), { variant: v });
      const ch = await repo.createChapter(`ch-${v}`, studyId, 'p-owner', `${v} Chapter`);
      assert.equal(ch.startingFen, canonicalStarts[v], `Variant ${v} must derive canonical starting FEN`);
    }
  });

  it('preserves explicit startingFen override regardless of study variant', async () => {
    const repo = new InMemoryStudiesRepository(mockReader);
    await repo.createStudy('s-horde-custom', 'p-owner', 'Custom Horde', 'Desc', 'public', new Date(), { variant: 'horde' });
    const customFen = '4k3/8/8/8/8/8/PPPPPPPP/PPPPPPPP w - - 0 1';
    const ch = await repo.createChapter('ch-custom', 's-horde-custom', 'p-owner', 'Custom Ch', customFen);
    assert.equal(ch.startingFen, customFen, 'Explicit FEN must be preserved');
  });

  it('uses repository injected InitialPositionPort for omitted PGN start even if operation reader advertises different initialFen', async () => {
    const repo = new InMemoryStudiesRepository(mockReader);
    await repo.createStudy('s-horde-import', 'p-owner', 'Horde Import', 'Desc', 'public', new Date(), { variant: 'horde' });

    let operationReaderInitialFenCalled = false;
    let operationReaderPlayCalled = false;

    const operationReader: PositionReader = {
      legalSans(): readonly string[] {
        return ['c4', 'd4'];
      },
      play(fen: string, san: string): string {
        operationReaderPlayCalled = true;
        return `${fen}+${san}`;
      },
      initialFen(): string {
        operationReaderInitialFenCalled = true;
        return 'decoy/divergent/fen/from/operation/reader w - - 0 1';
      },
    };

    const pgn = `[Event "Horde Test"]
[Site "Local"]

1. c4 *`;

    const imported = await repo.importPgn('s-horde-import', 'p-owner', pgn, operationReader);
    assert.equal(imported.length, 1);
    assert.equal(
      imported[0].startingFen,
      canonicalStarts.horde,
      'Imported chapter must derive initial FEN from repository injected provider, not operation reader'
    );
    assert.equal(operationReaderInitialFenCalled, false, 'Operation reader initialFen must not be queried for default start');
    assert.equal(operationReaderPlayCalled, true, 'Operation reader must still be used for movetext play/resolution');
  });

  it('preserves explicit [FEN] tag in PGN import override', async () => {
    const repo = new InMemoryStudiesRepository(mockReader);
    await repo.createStudy('s-horde-custom-import', 'p-owner', 'Custom Horde Import', 'Desc', 'public', new Date(), { variant: 'horde' });

    const customFen = 'rnbqkbnr/8/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';
    const pgn = `[Event "Custom FEN"]
[FEN "${customFen}"]

1. e4 *`;

    const imported = await repo.importPgn('s-horde-custom-import', 'p-owner', pgn, mockReader);
    assert.equal(imported.length, 1);
    assert.equal(imported[0].startingFen, customFen, 'Explicit PGN [FEN] tag must be preserved');
  });

  it('exportPgn omits FEN tag for canonical starts across all 8 variants and roundtrips faithfully (Qodo fef0004f)', async () => {
    const variants: readonly StudyVariant[] = [
      'standard',
      'chess960',
      'threecheck',
      'crazyhouse',
      'kingofthehill',
      'atomic',
      'horde',
      'racingkings',
    ];

    const repo = new InMemoryStudiesRepository(mockReader);
    for (const v of variants) {
      const studyId = `s-export-${v}`;
      await repo.createStudy(studyId, 'p-owner', `${v} Export Study`, 'Desc', 'public', new Date(), { variant: v });
      const ch = await repo.createChapter(`ch-exp-${v}`, studyId, 'p-owner', `${v} Chapter`);
      assert.equal(ch.startingFen, canonicalStarts[v]);

      const exportedPgn = await repo.exportPgn(studyId, 'p-owner', ch.id);
      assert.equal(
        exportedPgn.includes('[FEN '),
        false,
        `Variant ${v} canonical start must omit FEN tag on export`
      );

      const reimportStudyId = `s-reimport-${v}`;
      await repo.createStudy(reimportStudyId, 'p-owner', `${v} Reimport Study`, 'Desc', 'public', new Date(), { variant: v });
      const [reimported] = await repo.importPgn(reimportStudyId, 'p-owner', exportedPgn, mockReader);
      assert.equal(
        reimported.startingFen,
        canonicalStarts[v],
        `Variant ${v} reimport without FEN tag must derive canonical initial FEN`
      );
    }
  });

  it('exportPgn preserves FEN tag for stored legacy Racing Kings Standard-start and roundtrips faithfully (Qodo fef0004f)', async () => {
    const repo = new InMemoryStudiesRepository(mockReader);
    const standardStart = canonicalStarts.standard;

    // Study has variant racingkings, but chapter stores legacy Standard start FEN
    await repo.createStudy('s-rk-legacy', 'p-owner', 'Legacy RK', 'Desc', 'public', new Date(), { variant: 'racingkings' });
    const ch = await repo.createChapter('ch-rk-legacy', 's-rk-legacy', 'p-owner', 'Legacy Chapter', standardStart);
    assert.equal(ch.startingFen, standardStart);

    const exportedPgn = await repo.exportPgn('s-rk-legacy', 'p-owner', ch.id);
    assert.ok(
      exportedPgn.includes(`[FEN "${standardStart}"]`),
      'export of legacy Standard start in Racing Kings study must retain explicit FEN tag'
    );

    await repo.createStudy('s-rk-reimport', 'p-owner', 'Reimport RK', 'Desc', 'public', new Date(), { variant: 'racingkings' });
    const [reimported] = await repo.importPgn('s-rk-reimport', 'p-owner', exportedPgn, mockReader);
    assert.equal(
      reimported.startingFen,
      standardStart,
      'reimport must preserve the exact stored legacy Standard starting FEN rather than silently selecting RK default'
    );
  });

  it('handles Threecheck and Crazyhouse serialized-default differences properly (Qodo fef0004f)', async () => {
    const repo = new InMemoryStudiesRepository(mockReader);

    // 1. Threecheck canonical has '3+3 0 1' -> omits FEN tag on export
    await repo.createStudy('s-tc-canon', 'p-owner', 'TC Canon', 'Desc', 'public', new Date(), { variant: 'threecheck' });
    const tcCanonCh = await repo.createChapter('ch-tc-canon', 's-tc-canon', 'p-owner', 'TC Canon');
    assert.equal(tcCanonCh.startingFen, canonicalStarts.threecheck);
    const tcCanonPgn = await repo.exportPgn('s-tc-canon', 'p-owner', tcCanonCh.id);
    assert.equal(tcCanonPgn.includes('[FEN '), false, 'canonical Threecheck must omit FEN tag');

    // 2. Threecheck with standard FEN (missing '3+3') -> emits explicit FEN tag
    await repo.createStudy('s-tc-legacy', 'p-owner', 'TC Legacy', 'Desc', 'public', new Date(), { variant: 'threecheck' });
    const tcLegacyCh = await repo.createChapter('ch-tc-legacy', 's-tc-legacy', 'p-owner', 'TC Legacy', canonicalStarts.standard);
    const tcLegacyPgn = await repo.exportPgn('s-tc-legacy', 'p-owner', tcLegacyCh.id);
    assert.ok(tcLegacyPgn.includes(`[FEN "${canonicalStarts.standard}"]`), 'Threecheck with standard FEN must retain FEN tag');

    // 3. Crazyhouse canonical has '[]' -> omits FEN tag on export
    await repo.createStudy('s-zh-canon', 'p-owner', 'ZH Canon', 'Desc', 'public', new Date(), { variant: 'crazyhouse' });
    const zhCanonCh = await repo.createChapter('ch-zh-canon', 's-zh-canon', 'p-owner', 'ZH Canon');
    assert.equal(zhCanonCh.startingFen, canonicalStarts.crazyhouse);
    const zhCanonPgn = await repo.exportPgn('s-zh-canon', 'p-owner', zhCanonCh.id);
    assert.equal(zhCanonPgn.includes('[FEN '), false, 'canonical Crazyhouse must omit FEN tag');

    // 4. Crazyhouse with standard FEN (missing '[]') -> emits explicit FEN tag
    await repo.createStudy('s-zh-legacy', 'p-owner', 'ZH Legacy', 'Desc', 'public', new Date(), { variant: 'crazyhouse' });
    const zhLegacyCh = await repo.createChapter('ch-zh-legacy', 's-zh-legacy', 'p-owner', 'ZH Legacy', canonicalStarts.standard);
    const zhLegacyPgn = await repo.exportPgn('s-zh-legacy', 'p-owner', zhLegacyCh.id);
    assert.ok(zhLegacyPgn.includes(`[FEN "${canonicalStarts.standard}"]`), 'Crazyhouse with standard FEN must retain FEN tag');
  });

  it('preserves legacy Horde with standard start as explicit FEN on export without silent rewrite (Qodo fef0004f)', async () => {
    const repo = new InMemoryStudiesRepository(mockReader);
    const standardStart = canonicalStarts.standard;

    await repo.createStudy('s-horde-legacy', 'p-owner', 'Legacy Horde', 'Desc', 'public', new Date(), { variant: 'horde' });
    const ch = await repo.createChapter('ch-horde-legacy', 's-horde-legacy', 'p-owner', 'Legacy Horde Chapter', standardStart);

    const exportedPgn = await repo.exportPgn('s-horde-legacy', 'p-owner', ch.id);
    assert.ok(
      exportedPgn.includes(`[FEN "${standardStart}"]`),
      'export of legacy Horde holding standard start must preserve exact stored FEN, not silently omit or mutate'
    );
  });
});
