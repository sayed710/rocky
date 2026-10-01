import type { GambitClient } from '../api/client.js';
import type {
  JoinRequestView,
  SocialPlayer,
  TeamDetailView,
  TeamMembership,
  TeamView,
} from '../api/models.js';
import { applyAutoDirection } from '../i18n/bidi.js';
import type { I18nManager } from '../i18n/manager.js';
import { TeamsController } from './teams-controller.js';
import type { TeamsCallbacks } from './teams-controller.js';
import {
  actionExplanation,
  createJoinRequestQueue,
  membershipOf,
  teamAction,
} from './teams-helpers.js';
import type { TeamAction } from './teams-helpers.js';
import { renderJoinRequests, renderTeamList, renderTeamMembers } from './teams-view.js';

interface TeamDetailMountDependencies {
  readonly doc: Document;
  readonly client: GambitClient;
  readonly slug: string;
  readonly sessionPresent: boolean;
  readonly restorePromise: Promise<unknown>;
  readonly i18n: I18nManager;
}

interface TeamListElements {
  readonly list: HTMLElement | null;
  readonly error: HTMLElement | null;
  readonly form: HTMLFormElement | null;
  readonly input: HTMLInputElement | null;
}

interface TeamDetailElements {
  readonly name: HTMLElement | null;
  readonly description: HTMLElement | null;
  readonly actionNote: HTMLElement | null;
  readonly actions: HTMLElement | null;
  readonly members: HTMLElement | null;
  readonly joinRequestsHeading: HTMLElement | null;
  readonly joinRequests: HTMLElement | null;
  readonly forumLink: HTMLElement | null;
  readonly error: HTMLElement | null;
}

interface TeamRenderDependencies {
  readonly doc: Document;
  readonly elements: TeamDetailElements;
  readonly controller: TeamsController;
  readonly slug: string;
  readonly viewerId: () => string | null;
  readonly i18n: I18nManager;
}

interface TeamActionRequest {
  readonly controller: TeamsController;
  readonly team: TeamDetailView;
  readonly members: readonly TeamMembership[];
  readonly viewerId: string | null;
  readonly slug: string;
  readonly action: Exclude<TeamAction, { readonly kind: 'none' }>;
}

function teamListElements(doc: Document): TeamListElements {
  return {
    list: doc.getElementById('team-list'),
    error: doc.getElementById('teams-error'),
    form: doc.getElementById('team-search-form') as HTMLFormElement | null,
    input: doc.getElementById('team-search-input') as HTMLInputElement | null,
  };
}

function createTeamListCallbacks(
  elements: TeamListElements,
  searched: () => boolean,
  i18n: I18nManager,
  onListLoaded?: (teams: readonly TeamView[]) => void,
): TeamsCallbacks {
  return {
    onList: (teams) => {
      onListLoaded?.(teams);
      if (elements.error) elements.error.textContent = '';
      if (elements.list) renderTeamList(elements.list, teams, searched(), i18n);
    },
    onTeam: () => {},
    onLoading: (loading) => {
      if (elements.list) elements.list.setAttribute('aria-busy', loading ? 'true' : 'false');
    },
    onError: (message) => {
      if (elements.error) elements.error.textContent = message;
    },
    onNotFound: () => {},
  };
}

export function mountTeamList(
  doc: Document,
  client: GambitClient,
  i18n: I18nManager,
): TeamsController {
  const elements = teamListElements(doc);
  let searched = false;
  let lastTeams: readonly TeamView[] | null = null;
  let unsubscribeLocale: (() => void) | undefined;

  const controller = new TeamsController({
    client,
    callbacks: createTeamListCallbacks(
      elements,
      () => searched,
      i18n,
      (teams) => {
        lastTeams = teams;
      },
    ),
    onDispose: () => {
      unsubscribeLocale?.();
    },
  });

  unsubscribeLocale = i18n.onLocaleChange(() => {
    if (lastTeams && elements.list) {
      renderTeamList(elements.list, lastTeams, searched, i18n);
    }
  });

  if (elements.form && elements.input) {
    const input = elements.input;
    elements.form.onsubmit = (event) => {
      event.preventDefault();
      const term = input.value.trim();
      searched = term.length > 0;
      void controller.loadList(term || undefined);
    };
  }
  void controller.loadList();
  return controller;
}

function teamDetailElements(doc: Document): TeamDetailElements {
  return {
    name: doc.getElementById('team-name'),
    description: doc.getElementById('team-description'),
    actionNote: doc.getElementById('team-action-note'),
    actions: doc.getElementById('team-actions'),
    members: doc.getElementById('team-members'),
    joinRequestsHeading: doc.getElementById('join-requests-heading'),
    joinRequests: doc.getElementById('join-requests'),
    forumLink: doc.getElementById('team-forum-link'),
    error: doc.getElementById('team-error'),
  };
}

function renderTeamIdentity(
  elements: TeamDetailElements,
  team: TeamDetailView,
  members: readonly TeamMembership[],
  names: ReadonlyMap<string, SocialPlayer>,
  i18n: I18nManager,
): void {
  if (elements.error) elements.error.textContent = '';
  if (elements.name) {
    elements.name.textContent = team.name;
    applyAutoDirection(elements.name);
  }
  if (elements.description) {
    elements.description.textContent = team.description;
    applyAutoDirection(elements.description);
  }
  if (elements.members) renderTeamMembers(elements.members, members, names, i18n);
  if (elements.forumLink instanceof HTMLAnchorElement) {
    elements.forumLink.href = `/teams/${encodeURIComponent(team.slug)}/forum`;
  }
}

function renderModerationQueue(
  dependencies: TeamRenderDependencies,
  team: TeamDetailView,
  names: ReadonlyMap<string, SocialPlayer>,
  joinRequests: readonly JoinRequestView[] | undefined,
): void {
  const { elements, controller, slug, i18n } = dependencies;
  if (elements.joinRequestsHeading) elements.joinRequestsHeading.hidden = joinRequests === undefined;
  if (elements.joinRequests) elements.joinRequests.hidden = joinRequests === undefined;
  if (!elements.joinRequests || joinRequests === undefined) return;
  const joinRequestsElement = elements.joinRequests;

  const queue = createJoinRequestQueue({
    renderQueue: (busy) => {
      renderJoinRequests(joinRequestsElement, joinRequests, names, busy, {
        onAccept: (request) => void queue.respond(request.id, 'accepted'),
        onDecline: (request) => void queue.respond(request.id, 'declined'),
      }, i18n);
    },
    respond: (requestId, status) =>
      controller.respondToJoinRequest(team.id, requestId, status, slug),
  });
  queue.render();
}

function runTeamAction(request: TeamActionRequest): Promise<boolean> {
  if (request.action.kind === 'join') {
    return request.controller.join(request.team.id, request.slug);
  }
  const membership = membershipOf(request.members, request.viewerId);
  return membership === null
    ? Promise.resolve(false)
    : request.controller.leave(request.team.id, membership.playerId, request.slug);
}

function renderTeamAction(
  dependencies: TeamRenderDependencies,
  team: TeamDetailView,
  members: readonly TeamMembership[],
): void {
  const { actions, actionNote } = dependencies.elements;
  if (!actions || !actionNote) return;
  actions.replaceChildren();
  actionNote.textContent = '';

  const viewerId = dependencies.viewerId();
  const action = teamAction(team, team.viewerRole, viewerId);
  if (action.kind === 'none') {
    actionNote.textContent = actionExplanation(action.reason, dependencies.i18n);
    return;
  }

  const button = dependencies.doc.createElement('button');
  button.type = 'button';
  button.textContent = action.kind === 'join'
    ? dependencies.i18n.t('community.teams.actionJoin')
    : dependencies.i18n.t('community.teams.actionLeave');
  button.addEventListener('click', () => {
    button.disabled = true;
    void runTeamAction({
      controller: dependencies.controller,
      team,
      members,
      viewerId,
      slug: dependencies.slug,
      action,
    }).then(() => {
      button.disabled = false;
    });
  });
  actions.appendChild(button);
}

function renderTeamNotFound(elements: TeamDetailElements, i18n: I18nManager): void {
  if (elements.name) elements.name.textContent = i18n.t('community.teams.notFoundTitle');
  if (elements.description) elements.description.textContent = i18n.t('community.teams.notFoundBody');
  if (elements.members) elements.members.replaceChildren();
  if (elements.actions) elements.actions.replaceChildren();
  if (elements.actionNote) elements.actionNote.textContent = '';
  if (elements.joinRequestsHeading) elements.joinRequestsHeading.hidden = true;
  if (elements.joinRequests) elements.joinRequests.hidden = true;
}

function createTeamDetailCallbacks(
  dependencies: TeamRenderDependencies,
  onTeamLoaded?: (state: {
    team: TeamDetailView;
    members: readonly TeamMembership[];
    names: ReadonlyMap<string, SocialPlayer>;
    joinRequests?: readonly JoinRequestView[] | undefined;
  }) => void,
): TeamsCallbacks {
  return {
    onList: () => {},
    onTeam: (team, members, names, joinRequests) => {
      onTeamLoaded?.({ team, members, names, joinRequests });
      renderTeamIdentity(dependencies.elements, team, members, names, dependencies.i18n);
      renderModerationQueue(dependencies, team, names, joinRequests);
      renderTeamAction(dependencies, team, members);
    },
    onLoading: (loading) => {
      const { members, joinRequests } = dependencies.elements;
      if (members) members.setAttribute('aria-busy', loading ? 'true' : 'false');
      if (joinRequests) joinRequests.setAttribute('aria-busy', loading ? 'true' : 'false');
    },
    onError: (message) => {
      if (dependencies.elements.error) dependencies.elements.error.textContent = message;
    },
    // Missing and private teams deliberately share one state so this UI cannot confirm existence.
    onNotFound: () => renderTeamNotFound(dependencies.elements, dependencies.i18n),
  };
}

function loadAfterSessionRestore(
  sessionPresent: boolean,
  restorePromise: Promise<unknown>,
  load: () => void,
): void {
  if (sessionPresent) load();
  else void restorePromise.then(() => load()).catch(() => undefined);
}

export function mountTeamDetail({
  doc,
  client,
  slug,
  sessionPresent,
  restorePromise,
  i18n,
}: TeamDetailMountDependencies): TeamsController {
  const elements = teamDetailElements(doc);
  let controller: TeamsController;
  let lastTeamState: {
    team: TeamDetailView;
    members: readonly TeamMembership[];
    names: ReadonlyMap<string, SocialPlayer>;
    joinRequests?: readonly JoinRequestView[] | undefined;
  } | null = null;
  let unsubscribeLocale: (() => void) | undefined;

  const dependencies: TeamRenderDependencies = {
    doc,
    elements,
    get controller() {
      return controller;
    },
    slug,
    viewerId: () => client.session.current?.user.id ?? null,
    i18n,
  };

  controller = new TeamsController({
    client,
    callbacks: createTeamDetailCallbacks(dependencies, (state) => {
      lastTeamState = state;
    }),
    onDispose: () => {
      unsubscribeLocale?.();
    },
  });

  unsubscribeLocale = i18n.onLocaleChange(() => {
    if (lastTeamState) {
      renderTeamIdentity(
        dependencies.elements,
        lastTeamState.team,
        lastTeamState.members,
        lastTeamState.names,
        dependencies.i18n,
      );
      renderModerationQueue(
        dependencies,
        lastTeamState.team,
        lastTeamState.names,
        lastTeamState.joinRequests,
      );
      renderTeamAction(dependencies, lastTeamState.team, lastTeamState.members);
    }
  });

  loadAfterSessionRestore(sessionPresent, restorePromise, () => void controller.loadTeam(slug));
  return controller;
}
