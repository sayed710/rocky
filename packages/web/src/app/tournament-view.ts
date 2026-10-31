import { el } from './dom.js';
import { renderEmpty, formatTimeControl, formatClock } from './render-helpers.js';
import { shortId } from '../api/graphql.js';
import { applyAutoDirection, createLtrElement, renderInterpolatedText } from '../i18n/bidi.js';
import { getVariantLabel } from './variant-labels.js';
import type { I18n } from '../i18n/manager.js';
import type {
  TournamentSummary,
  TournamentDetail,
  TournamentStanding,
  TournamentLiveBoard,
  TournamentFormat,
  TournamentState,
} from '../api/models.js';

export function formatFormat(format: TournamentFormat, i18n: I18n): string {
  switch (format) {
    case 'round_robin':
      return i18n.t('tournaments.format.roundRobin');
    case 'swiss':
      return i18n.t('tournaments.format.swiss');
    case 'arena':
      return i18n.t('tournaments.format.arena');
  }
}

export function formatState(state: TournamentState, i18n: I18n): string {
  switch (state) {
    case 'registration':
      return i18n.t('tournaments.state.registration');
    case 'running':
      return i18n.t('tournaments.state.running');
    case 'finished':
      return i18n.t('tournaments.state.finished');
  }
}

export function renderTournamentList(
  container: HTMLElement,
  items: readonly TournamentSummary[],
  i18n: I18n,
): void {
  container.innerHTML = '';
  if (items.length === 0) {
    renderEmpty(container, {
      mark: '🏆',
      title: i18n.t('tournaments.emptyListTitle'),
      body: i18n.t('tournaments.emptyListBody'),
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

    const playersCountStr = i18n.t('tournaments.playersCount', { count: item.participantCount });

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
  i18n: I18n,
): void {
  const doc = container.ownerDocument;
  container.innerHTML = '';

  const formatRow = el(
    doc,
    'div',
    { class: 'panel-row' },
    el(doc, 'strong', {}, i18n.t('tournaments.details.format')),
    el(doc, 'span', {}, formatFormat(detail.format, i18n)),
  );

  const stateRow = el(
    doc,
    'div',
    { class: 'panel-row' },
    el(doc, 'strong', {}, i18n.t('tournaments.details.state')),
    el(doc, 'span', {}, formatState(detail.state, i18n)),
  );

  const variantRow = el(
    doc,
    'div',
    { class: 'panel-row' },
    el(doc, 'strong', {}, i18n.t('tournaments.details.variant')),
    el(doc, 'span', {}, getVariantLabel(detail.variant, i18n)),
  );

  const timeValue = el(doc, 'span', {});
  renderInterpolatedText(timeValue, '{time}', { time: formatTimeControl(detail.timeControl, i18n) });
  const tcRow = el(
    doc,
    'div',
    { class: 'panel-row' },
    el(doc, 'strong', {}, i18n.t('tournaments.details.timeControl')),
    timeValue,
  );

  const playersText = i18n.t('tournaments.playersCount', { count: detail.participants.length });
  const playersRow = el(
    doc,
    'div',
    { class: 'panel-row' },
    el(doc, 'strong', {}, i18n.t('tournaments.details.participants')),
    el(doc, 'span', {}, playersText),
  );

  container.append(formatRow, stateRow, variantRow, tcRow, playersRow);

  if (detail.format === 'arena') {
    const durationText = i18n.t('tournaments.durationMin', { min: Math.round(detail.durationMs / 60000) });
    const durationRow = el(
      doc,
      'div',
      { class: 'panel-row' },
      el(doc, 'strong', {}, i18n.t('tournaments.details.duration')),
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
      el(doc, 'strong', {}, i18n.t('tournaments.details.rounds')),
      createLtrElement(doc, 'span', roundsText),
    );
    container.appendChild(roundsRow);
  }
}

export function renderStandings(
  container: HTMLElement,
  standings: readonly TournamentStanding[],
  names: ReadonlyMap<string, { id: string; handle: string }>,
  i18n: I18n,
): void {
  const doc = container.ownerDocument;
  const active = doc.activeElement;
  const focusedPlayerId =
    active instanceof HTMLAnchorElement &&
    container.contains(active) &&
    typeof active.dataset.playerId === 'string'
      ? active.dataset.playerId
      : null;

  container.innerHTML = '';
  if (standings.length === 0) {
    renderEmpty(container, {
      title: i18n.t('tournaments.emptyStandingsTitle'),
      body: i18n.t('tournaments.emptyStandingsBody'),
      inline: true,
    });
    if (focusedPlayerId !== null) {
      container.tabIndex = -1;
      container.focus();
    }
    return;
  }

  let anchorToFocus: HTMLAnchorElement | null = null;
  for (const s of standings) {
    const rankSpan = createLtrElement(doc, 'span', `#${s.rank}`);
    const resolved = names.get(s.playerId);
    let playerSpan: HTMLElement;
    if (resolved) {
      const link = el(
        doc,
        'a',
        {
          href: `/profile/${encodeURIComponent(resolved.handle)}`,
          'data-route': 'profile',
          class: 'row-link',
          dir: 'auto',
        },
        resolved.handle,
      );
      link.dataset.playerId = s.playerId;
      if (s.playerId === focusedPlayerId) {
        anchorToFocus = link;
      }
      playerSpan = el(doc, 'span', {}, rankSpan, ' ', link);
    } else {
      playerSpan = el(doc, 'span', {}, rankSpan, ' ', el(doc, 'bdi', {}, shortId(s.playerId)));
    }

    const ptsStr = i18n.t('tournaments.standings.points', { points: s.points });
    const statsSpan = el(doc, 'span', { class: 'count' });
    if ('wins' in s) {
      // ArenaStanding
      const onFireStr = s.onFire ? i18n.t('tournaments.standings.onFire') : '';
      renderInterpolatedText(statsSpan, i18n.t('tournaments.standings.arenaStats'), {
        points: ptsStr, wins: s.wins, draws: s.draws, losses: s.losses, games: s.gamesPlayed, onFire: onFireStr,
      });
    } else {
      // SwissOrRoundRobinStanding
      const withdrawnStr = s.withdrawn ? i18n.t('tournaments.standings.withdrawn') : '';
      renderInterpolatedText(statsSpan, i18n.t('tournaments.standings.swissStats'), {
        points: ptsStr, tiebreak: s.tiebreak, buchholz: s.buchholz, withdrawn: withdrawnStr,
      });
    }

    const row = el(doc, 'div', { class: 'panel-row' }, playerSpan, statsSpan);
    container.appendChild(row);
  }

  if (focusedPlayerId !== null) {
    if (anchorToFocus) {
      anchorToFocus.focus();
    } else {
      container.tabIndex = -1;
      container.focus();
    }
  }
}

export function renderLiveBoards(
  container: HTMLElement,
  games: readonly TournamentLiveBoard[],
  names: ReadonlyMap<string, { id: string; handle: string }>,
  i18n: I18n,
): void {
  container.innerHTML = '';
  if (games.length === 0) {
    renderEmpty(container, {
      title: i18n.t('tournaments.emptyLiveGamesTitle'),
      body: i18n.t('tournaments.emptyLiveGamesBody'),
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
    );
    renderInterpolatedText(matchupLink, i18n.t('tournaments.liveGame.matchup'), { white: whiteHandle, black: blackHandle });

    const infoSpan = el(doc, 'span', { class: 'count' });
    if (g.status.over) {
      renderInterpolatedText(infoSpan, i18n.t('tournaments.liveGame.over'), { result: g.status.result });
    } else {
      const turnStr = g.turn === 'w'
        ? i18n.t('game.player.white')
        : i18n.t('game.player.black');
      const clocksStr = `${formatClock(g.clock.w)} - ${formatClock(g.clock.b)}`;
      renderInterpolatedText(infoSpan, i18n.t('tournaments.liveGame.inProgress'), {
        move: Math.floor(g.ply / 2) + 1,
        turn: turnStr,
        clocks: clocksStr,
      });
    }

    const row = el(doc, 'div', { class: 'panel-row' }, matchupLink, infoSpan);
    container.appendChild(row);
  }
}
