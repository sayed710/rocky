import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { renderStandings } from '../src/app/tournament-view.js';
import { FakeElement, createFakeDoc } from './support/localization-dom.js';
import { createI18nManager } from '../src/i18n/index.js';
import { shortId } from '../src/api/graphql.js';
import type { ArenaStanding, SwissOrRoundRobinStanding } from '../src/api/models.js';

function setupDocument(): { container: FakeElement; doc: Document } {
  const container = new FakeElement('div', 'tournament-standings');
  const elementMap = new Map<string, FakeElement>([['tournament-standings', container]]);
  const doc = createFakeDoc(elementMap);
  return { container, doc };
}

describe('renderStandings', () => {
  it('renders safe literal links, LTR ranks, unresolved short IDs without links, and statistics for Arena and Swiss', () => {
    const { container } = setupDocument();
    const i18n = createI18nManager();

    const arenaStandings: readonly ArenaStanding[] = [
      {
        rank: 1,
        playerId: 'player-resolved-12345678',
        points: 15,
        wins: 7,
        draws: 1,
        losses: 0,
        gamesPlayed: 8,
        onFire: true,
      },
      {
        rank: 2,
        playerId: 'player-unresolved-87654321',
        points: 9,
        wins: 4,
        draws: 1,
        losses: 2,
        gamesPlayed: 7,
        onFire: false,
      },
    ];

    const names = new Map([
      ['player-resolved-12345678', { id: 'player-resolved-12345678', handle: 'alice/chess<script>' }],
    ]);

    renderStandings(container as unknown as HTMLElement, arenaStandings, names, i18n);

    const rows = container.children;
    assert.equal(rows.length, 2);

    // Row 1: Resolved player
    const row1 = rows[0];
    assert.ok(row1);
    const anchorsRow1 = row1.querySelectorAll('a');
    assert.equal(anchorsRow1.length, 1);
    const link = anchorsRow1[0];
    assert.ok(link);

    assert.equal(link.attributes['href'], '/profile/alice%2Fchess%3Cscript%3E');
    assert.equal(link.attributes['data-route'], 'profile');
    assert.equal(link.attributes['dir'], 'auto');
    assert.equal(link.classList.contains('row-link'), true);
    assert.equal(link.dataset.playerId, 'player-resolved-12345678');
    assert.equal(link.textContent, 'alice/chess<script>');
    assert.equal(link.querySelector('img'), null);
    assert.equal(link.querySelector('script'), null);

    const playerSpanRow1 = row1.children[0];
    assert.ok(playerSpanRow1);
    const rankSpanRow1 = playerSpanRow1.children[0];
    assert.ok(rankSpanRow1);
    assert.equal(rankSpanRow1.attributes['dir'], 'ltr');
    assert.equal(rankSpanRow1.textContent, '#1');

    // Arena statistics rendered and onFire present
    assert.ok(row1.textContent.includes(i18n.t('tournaments.standings.points', { points: 15 })));
    assert.ok(row1.textContent.includes(i18n.t('tournaments.standings.onFire')));

    // Row 2: Unresolved player
    const row2 = rows[1];
    assert.ok(row2);
    assert.equal(row2.querySelectorAll('a').length, 0);
    assert.ok(row2.textContent.includes(shortId('player-unresolved-87654321')));
    assert.ok(row2.textContent.includes('#2'));
    assert.ok(row2.textContent.includes(i18n.t('tournaments.standings.points', { points: 9 })));
    const bdi = row2.querySelector('bdi');
    assert.ok(bdi);
    assert.equal(bdi.textContent, shortId('player-unresolved-87654321'));

    // Swiss standings rendering
    const swissStandings: readonly SwissOrRoundRobinStanding[] = [
      {
        rank: 1,
        playerId: 'player-resolved-12345678',
        points: 4.5,
        tiebreak: 14.5,
        buchholz: 22.0,
        medianBuchholz: 18.0,
        withdrawn: false,
      },
      {
        rank: 2,
        playerId: 'player-unresolved-87654321',
        points: 3.0,
        tiebreak: 10.0,
        buchholz: 18.0,
        medianBuchholz: 15.0,
        withdrawn: true,
      },
    ];

    renderStandings(container as unknown as HTMLElement, swissStandings, names, i18n);
    const swissRows = container.children;
    assert.equal(swissRows.length, 2);

    const swissRow1 = swissRows[0];
    assert.ok(swissRow1);
    assert.ok(swissRow1.textContent.includes(i18n.t('tournaments.standings.points', { points: 4.5 })));
    assert.ok(swissRow1.textContent.includes('14.5'));
    assert.ok(swissRow1.textContent.includes('22'));

    const swissRow2 = swissRows[1];
    assert.ok(swissRow2);
    assert.equal(swissRow2.querySelectorAll('a').length, 0);
    assert.ok(swissRow2.textContent.includes(shortId('player-unresolved-87654321')));
    assert.ok(swissRow2.textContent.includes(i18n.t('tournaments.standings.withdrawn')));
    const swissBdi = swissRow2.querySelector('bdi');
    assert.ok(swissBdi);
    assert.equal(swissBdi.textContent, shortId('player-unresolved-87654321'));
  });

  it('retains focus on the same playerId across rank, order, and handle changes, without stealing external focus', () => {
    const { container, doc } = setupDocument();
    const i18n = createI18nManager();

    const initialStandings: readonly ArenaStanding[] = [
      {
        rank: 1,
        playerId: 'p1',
        points: 10,
        wins: 5,
        draws: 0,
        losses: 0,
        gamesPlayed: 5,
        onFire: true,
      },
      {
        rank: 2,
        playerId: 'p2',
        points: 8,
        wins: 4,
        draws: 0,
        losses: 1,
        gamesPlayed: 5,
        onFire: false,
      },
    ];

    const initialNames = new Map([
      ['p1', { id: 'p1', handle: 'playerOne' }],
      ['p2', { id: 'p2', handle: 'playerTwo' }],
    ]);

    renderStandings(container as unknown as HTMLElement, initialStandings, initialNames, i18n);

    const initialAnchors = container.querySelectorAll('a');
    const p2Anchor = initialAnchors.find((a) => a.dataset.playerId === 'p2');
    assert.ok(p2Anchor);
    p2Anchor.focus();
    assert.equal((doc as unknown as { activeElement?: FakeElement }).activeElement, p2Anchor);

    const updatedStandings: readonly ArenaStanding[] = [
      {
        rank: 1,
        playerId: 'p2',
        points: 14,
        wins: 7,
        draws: 0,
        losses: 1,
        gamesPlayed: 8,
        onFire: true,
      },
      {
        rank: 2,
        playerId: 'p1',
        points: 12,
        wins: 6,
        draws: 0,
        losses: 1,
        gamesPlayed: 7,
        onFire: false,
      },
    ];

    const updatedNames = new Map([
      ['p1', { id: 'p1', handle: 'playerOne' }],
      ['p2', { id: 'p2', handle: 'playerTwoRenamed' }],
    ]);

    renderStandings(container as unknown as HTMLElement, updatedStandings, updatedNames, i18n);

    const activeAfter = (doc as unknown as { activeElement?: FakeElement }).activeElement;
    assert.ok(activeAfter);
    assert.equal(activeAfter.dataset.playerId, 'p2');
    assert.equal(activeAfter.textContent, 'playerTwoRenamed');
    const firstRowAfter = container.children[0];
    assert.ok(firstRowAfter);
    const firstRowAnchor = firstRowAfter.querySelectorAll('a')[0];
    assert.ok(firstRowAnchor);
    assert.equal(firstRowAnchor, activeAfter);

    const externalBtn = doc.createElement('button') as unknown as FakeElement;
    (doc as unknown as { body: FakeElement }).body.appendChild(externalBtn);
    externalBtn.focus();
    assert.equal((doc as unknown as { activeElement?: FakeElement }).activeElement, externalBtn);

    renderStandings(container as unknown as HTMLElement, updatedStandings, updatedNames, i18n);
    assert.equal((doc as unknown as { activeElement?: FakeElement }).activeElement, externalBtn);
  });

  it('moves focus to container with tabIndex -1 when focused player is removed, becomes unresolved, or standings becomes empty', () => {
    const { container, doc } = setupDocument();
    const i18n = createI18nManager();

    const standings: readonly ArenaStanding[] = [
      { rank: 1, playerId: 'p1', points: 6, wins: 3, draws: 0, losses: 0, gamesPlayed: 3, onFire: false },
      { rank: 2, playerId: 'p2', points: 4, wins: 2, draws: 0, losses: 1, gamesPlayed: 3, onFire: false },
    ];
    const names = new Map([
      ['p1', { id: 'p1', handle: 'playerOne' }],
      ['p2', { id: 'p2', handle: 'playerTwo' }],
    ]);
    const firstStanding = standings[0];
    assert.ok(firstStanding);

    renderStandings(container as unknown as HTMLElement, standings, names, i18n);
    const p2Anchor = container.querySelectorAll('a').find((a) => a.dataset.playerId === 'p2');
    assert.ok(p2Anchor);
    p2Anchor.focus();

    renderStandings(container as unknown as HTMLElement, [firstStanding], names, i18n);
    assert.equal((doc as unknown as { activeElement?: FakeElement }).activeElement, container);
    assert.equal((container as unknown as { tabIndex?: number }).tabIndex, -1);

    const p1Anchor = container.querySelectorAll('a').find((a) => a.dataset.playerId === 'p1');
    assert.ok(p1Anchor);
    p1Anchor.focus();

    const emptyNames = new Map<string, { id: string; handle: string }>();
    renderStandings(container as unknown as HTMLElement, [firstStanding], emptyNames, i18n);
    assert.equal((doc as unknown as { activeElement?: FakeElement }).activeElement, container);
    assert.equal((container as unknown as { tabIndex?: number }).tabIndex, -1);

    renderStandings(container as unknown as HTMLElement, standings, names, i18n);
    const p1AnchorAgain = container.querySelectorAll('a').find((a) => a.dataset.playerId === 'p1');
    assert.ok(p1AnchorAgain);
    p1AnchorAgain.focus();

    renderStandings(container as unknown as HTMLElement, [], names, i18n);
    assert.equal((doc as unknown as { activeElement?: FakeElement }).activeElement, container);
    assert.equal((container as unknown as { tabIndex?: number }).tabIndex, -1);
    assert.ok(container.textContent.includes(i18n.t('tournaments.emptyStandingsTitle')));
    assert.ok(container.textContent.includes(i18n.t('tournaments.emptyStandingsBody')));
  });

  it('preserves focus, bidi isolation, and localized text across EN/AR re-render', () => {
    const { container, doc } = setupDocument();
    const i18n = createI18nManager();

    const standings: readonly ArenaStanding[] = [
      {
        rank: 1,
        playerId: 'p1',
        points: 10,
        wins: 5,
        draws: 0,
        losses: 0,
        gamesPlayed: 5,
        onFire: true,
      },
      {
        rank: 2,
        playerId: 'player-unresolved-87654321',
        points: 4,
        wins: 2,
        draws: 0,
        losses: 2,
        gamesPlayed: 4,
        onFire: false,
      },
    ];
    const names = new Map([['p1', { id: 'p1', handle: 'playerOne' }]]);

    renderStandings(container as unknown as HTMLElement, standings, names, i18n);
    const initialLink = container.querySelectorAll('a').find((a) => a.dataset.playerId === 'p1');
    assert.ok(initialLink);
    initialLink.focus();

    i18n.setLocale('ar');
    renderStandings(container as unknown as HTMLElement, standings, names, i18n);

    const activeAr = (doc as unknown as { activeElement?: FakeElement }).activeElement;
    assert.ok(activeAr);
    assert.equal(activeAr.dataset.playerId, 'p1');
    assert.equal(activeAr.attributes['dir'], 'auto');

    const firstRowAr = container.children[0];
    assert.ok(firstRowAr);
    const playerSpanAr = firstRowAr.children[0];
    assert.ok(playerSpanAr);
    const rankSpan = playerSpanAr.children[0];
    assert.ok(rankSpan);
    assert.equal(rankSpan.attributes['dir'], 'ltr');
    assert.equal(rankSpan.textContent, '#1');

    const arPoints = i18n.t('tournaments.standings.points', { points: 10 });
    assert.ok(container.textContent.includes(arPoints));

    const secondRowAr = container.children[1];
    assert.ok(secondRowAr);
    assert.equal(secondRowAr.querySelectorAll('a').length, 0);
    const unresolvedBdiAr = secondRowAr.querySelector('bdi');
    assert.ok(unresolvedBdiAr);
    assert.equal(unresolvedBdiAr.textContent, shortId('player-unresolved-87654321'));
  });
});
