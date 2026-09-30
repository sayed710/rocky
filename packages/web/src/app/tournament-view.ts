import { el } from './dom.js';
import { renderEmpty, formatTimeControl, formatClock } from './render-helpers.js';
import { shortId } from '../api/graphql.js';
import { applyAutoDirection } from '../i18n/bidi.js';
import type { I18n } from '../i18n/manager.js';
import type {
  TournamentSummary,
  TournamentDetail,
  TournamentStanding,
  TournamentLiveBoard,
  TournamentFormat,
  TournamentState,
} from '../api/models.js';

export function formatFormat(format: TournamentFormat, i18n?: I18n): string {
  switch (format) {
    case 'round_robin':
      return i18n ? i18n.t('tournaments.format.roundRobin') : 'Round robin';
    case 'swiss':
      return i18n ? i18n.t('tournaments.format.swiss') : 'Swiss';
    case 'arena':
      return i18n ? i18n.t('tournaments.format.arena') : 'Arena';
  }
}

export function formatState(state: TournamentState, i18n?: I18n): string {
  switch (state) {
    case 'registration':
      return i18n ? i18n.t('tournaments.state.registration') : 'Registration';
    case 'running':
      return i18n ? i18n.t('tournaments.state.running') : 'Running';
    case 'finished':
      return i18n ? i18n.t('tournaments.state.finished') : 'Finished';
  }
}

export function renderTournamentList(
  container: HTMLElement,
  items: readonly TournamentSummary[],
  i18n?: I18n,
): void {
  container.innerHTML = '';
  if (items.length === 0) {
    renderEmpty(container, {
      mark: '🏆',
      title: i18n ? i18n.t('tournaments.emptyListTitle') : 'No tournaments available',
      body: i18n ? i18n.t('tournaments.emptyListBody') : 'Check back later for upcoming tournaments.',
    });
    return;
  }

  const doc = container.ownerDocument;
  for (const item of items) {
    const link = el(
      doc,
      'a',
      { href: `/tournaments/${encodeURIComponent(item.id)}`, class: 'row-link' },
      item.name,
    );
    applyAutoDirection(link);

    const playersCountStr = i18n
      ? i18n.t('tournaments.playersCount', { count: item.participantCount })
      : `${item.participantCount} players`;

    const info = el(
      doc,
      'span',
      { class: 'count' },
      `${formatFormat(item.format, i18n)} · ${formatState(item.state, i18n)} · ${playersCountStr}`,
    );

    const row = el(
      doc,
      'div',
      { class: 'panel-row' },
      link,
      info,
    );

    container.appendChild(row);
  }
}

export function renderTournamentDetail(
  container: HTMLElement,
  detail: TournamentDetail,
  i18n?: I18n,
): void {
  const doc = container.ownerDocument;
  container.innerHTML = '';

  const formatRow = el(
    doc,
    'div',
    { class: 'panel-row' },
    el(doc, 'strong', {}, i18n ? i18n.t('tournaments.details.format') : 'Format'),
    el(doc, 'span', {}, formatFormat(detail.format, i18n)),
  );

  const stateRow = el(
    doc,
    'div',
    { class: 'panel-row' },
    el(doc, 'strong', {}, i18n ? i18n.t('tournaments.details.state') : 'State'),
    el(doc, 'span', {}, formatState(detail.state, i18n)),
  );

  const variantRow = el(
    doc,
    'div',
    { class: 'panel-row' },
    el(doc, 'strong', {}, i18n ? i18n.t('tournaments.details.variant') : 'Variant'),
    el(doc, 'span', {}, detail.variant),
  );

  const tcRow = el(
    doc,
    'div',
    { class: 'panel-row' },
    el(doc, 'strong', {}, i18n ? i18n.t('tournaments.details.timeControl') : 'Time Control'),
    el(doc, 'span', {}, formatTimeControl(detail.timeControl)),
  );

  const playersText = i18n
    ? i18n.t('tournaments.playersCount', { count: detail.participants.length })
    : `${detail.participants.length} players`;
  const playersRow = el(
    doc,
    'div',
    { class: 'panel-row' },
    el(doc, 'strong', {}, i18n ? i18n.t('tournaments.details.participants') : 'Participants'),
    el(doc, 'span', {}, playersText),
  );

  container.append(formatRow, stateRow, variantRow, tcRow, playersRow);

  if (detail.format === 'arena') {
    const durationText = i18n
      ? i18n.t('tournaments.durationMin', { min: Math.round(detail.durationMs / 60000) })
      : `${Math.round(detail.durationMs / 60000)} min`;
    const durationRow = el(
      doc,
      'div',
      { class: 'panel-row' },
      el(doc, 'strong', {}, i18n ? i18n.t('tournaments.details.duration') : 'Duration'),
      el(doc, 'span', {}, durationText),
    );
    container.appendChild(durationRow);
  } else {
    const roundsText = detail.rounds
      ? `${detail.roundsGenerated} / ${detail.rounds}`
      : `${detail.roundsGenerated}`;
    const roundsRow = el(
      doc,
      'div',
      { class: 'panel-row' },
      el(doc, 'strong', {}, i18n ? i18n.t('tournaments.details.rounds') : 'Rounds'),
      el(doc, 'span', {}, roundsText),
    );
    container.appendChild(roundsRow);
  }
}

export function renderStandings(
  container: HTMLElement,
  standings: readonly TournamentStanding[],
  names: ReadonlyMap<string, { id: string; handle: string }>,
  i18n?: I18n,
): void {
  container.innerHTML = '';
  if (standings.length === 0) {
    renderEmpty(container, {
      title: i18n ? i18n.t('tournaments.emptyStandingsTitle') : 'No standings yet',
      body: i18n ? i18n.t('tournaments.emptyStandingsBody') : 'Standings will appear when participants join or play.',
      inline: true,
    });
    return;
  }

  const doc = container.ownerDocument;
  for (const s of standings) {
    const handle = names.get(s.playerId)?.handle ?? shortId(s.playerId);
    const playerSpan = el(doc, 'span', {}, `#${s.rank} ${handle}`);
    applyAutoDirection(playerSpan);

    const ptsStr = i18n ? i18n.t('tournaments.standings.points', { points: s.points }) : `${s.points} pts`;
    let statsStr = '';
    if ('wins' in s) {
      // ArenaStanding
      const onFireStr = s.onFire ? (i18n ? i18n.t('tournaments.standings.onFire') : ' 🔥 On fire') : '';
      statsStr = `${ptsStr} (${s.wins}W/${s.draws}D/${s.losses}L, ${s.gamesPlayed} games)${onFireStr}`;
    } else {
      // SwissOrRoundRobinStanding
      const withdrawnStr = s.withdrawn ? (i18n ? i18n.t('tournaments.standings.withdrawn') : ' [Withdrawn]') : '';
      statsStr = `${ptsStr} (Tiebreak: ${s.tiebreak}, Buchholz: ${s.buchholz})${withdrawnStr}`;
    }

    const statsSpan = el(doc, 'span', { class: 'count' }, statsStr);
    const row = el(doc, 'div', { class: 'panel-row' }, playerSpan, statsSpan);
    container.appendChild(row);
  }
}

export function renderLiveBoards(
  container: HTMLElement,
  games: readonly TournamentLiveBoard[],
  names: ReadonlyMap<string, { id: string; handle: string }>,
  i18n?: I18n,
): void {
  container.innerHTML = '';
  if (games.length === 0) {
    renderEmpty(container, {
      title: i18n ? i18n.t('tournaments.emptyLiveGamesTitle') : 'No live games right now',
      body: i18n ? i18n.t('tournaments.emptyLiveGamesBody') : 'Active games will appear here when rounds are in progress.',
      inline: true,
    });
    return;
  }

  const doc = container.ownerDocument;
  for (const g of games) {
    const whiteHandle = names.get(g.white)?.handle ?? shortId(g.white);
    const blackHandle = names.get(g.black)?.handle ?? shortId(g.black);

    const matchupLink = el(
      doc,
      'a',
      { href: `/game/${encodeURIComponent(g.gameId)}`, class: 'row-link' },
      `${whiteHandle} vs ${blackHandle}`,
    );
    applyAutoDirection(matchupLink);

    let statusText = '';
    if (g.status.over) {
      statusText = i18n
        ? i18n.t('tournaments.liveGame.over', { result: g.status.result })
        : `Over (${g.status.result})`;
    } else {
      const turnStr = g.turn === 'w'
        ? (i18n ? i18n.t('game.player.white') : 'White')
        : (i18n ? i18n.t('game.player.black') : 'Black');
      const clocksStr = `${formatClock(g.clock.w)} - ${formatClock(g.clock.b)}`;
      statusText = i18n
        ? i18n.t('tournaments.liveGame.inProgress', {
            move: Math.floor(g.ply / 2) + 1,
            turn: turnStr,
            clocks: clocksStr,
          })
        : `Move ${Math.floor(g.ply / 2) + 1} (${turnStr}) · ${clocksStr}`;
    }

    const infoSpan = el(doc, 'span', { class: 'count' }, statusText);
    const row = el(doc, 'div', { class: 'panel-row' }, matchupLink, infoSpan);
    container.appendChild(row);
  }
}
