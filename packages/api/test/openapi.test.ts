import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { startHarness } from './helpers';
import { joinRequestView, learnerStepView, teamView, teamDetailView, attemptResultView, capabilitiesView, sessionView, moveExplanationView, puzzleGenerationView, openingExplorationView } from '../src/presenters';
import { MAX_EXPLORED_PLIES } from '../src/openings/opening-exploration-service';
import type { JoinRequest, Team } from '@chess-platform/community';
import type { AttemptResult, LessonStep } from '@chess-platform/learning';
import type { JsonSchema } from '../src/openapi/types';

function collectRefs(node: unknown, acc: string[]): void {
  if (Array.isArray(node)) {
    for (const x of node) collectRefs(x, acc);
  } else if (node && typeof node === 'object') {
    for (const [k, v] of Object.entries(node)) {
      if (k === '$ref' && typeof v === 'string') acc.push(v);
      else collectRefs(v, acc);
    }
  }
}

test('OpenAPI document is well-formed and self-consistent', async () => {
  const h = await startHarness();
  try {
    const doc = h.server.openapiDocument() as any;
    assert.equal(doc.openapi, '3.1.0');
    assert.equal(doc.info.title, 'Gambit API');
    assert.equal(doc.info.license.identifier, 'AGPL-3.0-or-later');

    // Every registered route appears (in OpenAPI `{param}` form) with responses.
    for (const route of h.server.router.list()) {
      const p = route.path
        .split('/')
        .map((s) => (s.startsWith(':') ? `{${s.slice(1)}}` : s))
        .join('/');
      const op = doc.paths[p]?.[route.method.toLowerCase()];
      assert.ok(op, `missing operation ${route.method} ${p}`);
      assert.ok(op.responses && Object.keys(op.responses).length > 0, `no responses for ${p}`);
      assert.ok(op.operationId, `no operationId for ${p}`);
    }

    // The bearer security scheme is declared.
    assert.equal(doc.components.securitySchemes.bearerAuth.scheme, 'bearer');

    // Every $ref resolves to a defined component schema.
    const refs: string[] = [];
    collectRefs(doc.paths, refs);
    collectRefs(doc.components.schemas, refs);
    for (const ref of refs) {
      assert.ok(ref.startsWith('#/components/schemas/'), `unexpected ref ${ref}`);
      const name = ref.replace('#/components/schemas/', '');
      assert.ok(doc.components.schemas[name], `dangling ref: ${ref}`);
    }
  } finally {
    await h.close();
  }
});

test('protected operations declare bearer security', async () => {
  const h = await startHarness();
  try {
    const doc = h.server.openapiDocument() as any;
    const me = doc.paths['/v1/users/me'].get;
    assert.deepEqual(me.security, [{ bearerAuth: [] }]);
    // The admin role grant requires bearer and documents a 403.
    const grant = doc.paths['/v1/users/{userId}/roles'].post;
    assert.deepEqual(grant.security, [{ bearerAuth: [] }]);
    assert.ok(grant.responses['403']);
    // Public endpoints have no security requirement.
    assert.equal(doc.paths['/v1/health'].get.security, undefined);
  } finally {
    await h.close();
  }
});

test('Game Review documents unsupported variants among its validation outcomes', async () => {
  const h = await startHarness();
  try {
    const response = (h.server.openapiDocument() as any)
      .paths['/v1/games/{id}/review'].post.responses['422'];
    assert.match(response.description, /unsupported variant/i);
  } finally {
    await h.close();
  }
});

test('both PGN exports document a PGN body, never JSON, and the finished-game export its outcomes', async () => {
  const h = await startHarness();
  try {
    const doc = h.server.openapiDocument() as any;
    const game = doc.paths['/v1/games/{id}/export.pgn'].get;
    assert.equal(game.security, undefined, 'public, like the game summary and the spectator join');
    assert.deepEqual(Object.keys(game.responses['200'].content), ['application/x-chess-pgn']);
    assert.equal(game.responses['200'].content['application/x-chess-pgn'].schema.$ref, '#/components/schemas/PgnDocument');
    assert.ok(game.responses['200'].headers['Content-Disposition']);
    assert.deepEqual(Object.keys(game.responses).sort(), ['200', '400', '404', '409', '422', '503']);
    for (const status of ['404', '409', '422']) {
      assert.deepEqual(Object.keys(game.responses[status].content), ['application/json'], `${status} is the JSON error envelope`);
    }
    assert.equal(doc.components.schemas.PgnDocument.type, 'string');

    const study = doc.paths['/v1/studies/{id}/export.pgn'].get;
    assert.deepEqual(Object.keys(study.responses['200'].content), ['application/x-chess-pgn']);
  } finally {
    await h.close();
  }
});

test('Study Partner publishes only the private five-route lifecycle and its safe turn contract', async () => {
  const h = await startHarness();
  try {
    type Operation = {
      readonly security?: readonly Readonly<Record<string, readonly string[]>>[];
      readonly parameters?: readonly {
        readonly name?: string;
        readonly in?: string;
        readonly required?: boolean;
        readonly schema?: Readonly<Record<string, unknown>>;
      }[];
      readonly requestBody?: {
        readonly content?: Readonly<Record<string, { readonly schema?: { readonly $ref?: string } }>>;
      };
    };
    type StudyPartnerDocument = {
      readonly paths: Readonly<Record<string, Readonly<Record<string, Operation>>>>;
      readonly components: {
        readonly schemas: Readonly<Record<string, JsonSchema>>;
      };
    };
    const doc = h.server.openapiDocument() as unknown as StudyPartnerDocument;
    const routes = Object.entries(doc.paths)
      .filter(([path]) => path.startsWith('/v1/study-partner/'))
      .flatMap(([path, operations]) => Object.keys(operations).map((method) => `${method.toUpperCase()} ${path}`))
      .sort();
    assert.deepEqual(routes, [
      'DELETE /v1/study-partner/sessions/{id}',
      'GET /v1/study-partner/sessions/{id}',
      'POST /v1/study-partner/sessions',
      'POST /v1/study-partner/sessions/{id}/end',
      'POST /v1/study-partner/sessions/{id}/turns',
    ]);
    for (const [path, operations] of Object.entries(doc.paths)) {
      if (!path.startsWith('/v1/study-partner/')) continue;
      for (const operation of Object.values(operations)) {
        assert.deepEqual(operation.security, [{ bearerAuth: [] }]);
      }
    }

    const turn = doc.paths['/v1/study-partner/sessions/{id}']?.['post'];
    assert.equal(turn, undefined, 'the session resource itself must not gain an undocumented POST');
    const submit = doc.paths['/v1/study-partner/sessions/{id}/turns']?.['post'];
    assert.ok(submit);
    const key = submit.parameters?.find((parameter) => parameter.name === 'Idempotency-Key');
    assert.deepEqual(
      { in: key?.in, required: key?.required, pattern: key?.schema?.['pattern'], maxLength: key?.schema?.['maxLength'] },
      { in: 'header', required: true, pattern: '^[A-Za-z0-9._:-]{1,128}$', maxLength: 128 },
    );
    assert.equal(
      submit.requestBody?.content?.['application/json']?.schema?.$ref,
      '#/components/schemas/SubmitStudyPartnerTurnRequest',
    );

    const request = doc.components.schemas['SubmitStudyPartnerTurnRequest'];
    assert.deepEqual(Object.keys(request?.properties ?? {}).sort(), ['expectedVersion', 'move']);
    assert.equal(request?.additionalProperties, false);
    const explanation = doc.components.schemas['StudyPartnerExplanation'];
    assert.ok(explanation, 'StudyPartnerExplanation must stay published');
    assert.deepEqual(
      Object.keys(explanation.properties ?? {}).sort(),
      ['citation', 'explanation', 'fen', 'move', 'variant'],
    );
    assert.equal(explanation.additionalProperties, false);
    const puzzle = doc.components.schemas['CoachPuzzleView'];
    assert.ok(puzzle, 'CoachPuzzleView must stay published');
    assert.deepEqual(Object.keys(puzzle.properties ?? {}).sort(), ['difficulty', 'fen', 'kind', 'variant']);
    assert.equal(puzzle.additionalProperties, false);
    const session = doc.components.schemas['StudyPartnerSession'];
    const turns = session?.properties?.['turns'];
    assert.equal(turns?.maxItems, 20);
  } finally {
    await h.close();
  }
});

test('email verification resend documents authentication and rate limiting', async () => {
  const h = await startHarness();
  try {
    const op = (h.server.openapiDocument() as any)
      .paths['/v1/auth/email/verification/request'].post;
    assert.deepEqual(op.security, [{ bearerAuth: [] }]);
    assert.equal(op.responses['202'].description, 'Accepted');
    assert.equal(op.responses['401'].content['application/json'].schema.$ref, '#/components/schemas/Error');
    assert.equal(op.responses['429'].content['application/json'].schema.$ref, '#/components/schemas/Error');
    assert.equal(op.responses['429'].headers['Retry-After'].schema.type, 'integer');
  } finally {
    await h.close();
  }
});

test('the spec is served at GET /v1/openapi.json', async () => {
  const h = await startHarness();
  try {
    const res = await h.json('GET', '/v1/openapi.json');
    assert.equal(res.status, 200);
    assert.equal(res.body.openapi, '3.1.0');
    assert.ok(res.body.paths['/v1/auth/login']);
  } finally {
    await h.close();
  }
});

/**
 * The published schema and the presenter that fills it are two separate declarations of one
 * contract, and nothing made them agree. `JoinRequestView` required an `updatedAt` the presenter
 * never emitted and omitted the `respondedAt` it always did, from M10 increment 4 until M14
 * increment 28 — the same drift ADR-0088 fixed for `ForumPostView`. Every route test passed
 * throughout, because they all read the response and none read the schema.
 *
 * Asserting the presenter's real output against the served document is what closes that: correcting
 * one side without the other now fails here.
 */
test('JoinRequestView: the served schema describes exactly what the presenter emits', async () => {
  const h = await startHarness();
  try {
    const schema = (h.server.openapiDocument() as any).components.schemas.JoinRequestView;

    // Both branches of `respondedAt: j.respondedAt ? ... : null` — the key set must not depend on
    // whether the request has been responded to, since the schema declares it required either way.
    // Typed as `JoinRequest` rather than asserted: a test that exists to catch contract drift has
    // no business opting out of the check that catches it. A new required field on the domain type
    // fails to compile here.
    const base = {
      id: 'e6f0b1a2-0000-4000-8000-000000000001',
      teamId: 'e6f0b1a2-0000-4000-8000-000000000002',
      playerId: 'e6f0b1a2-0000-4000-8000-000000000003',
      createdAt: new Date('2026-01-01T00:00:00.000Z'),
    };
    const pendingRequest: JoinRequest = { ...base, status: 'pending' };
    const respondedRequest: JoinRequest = {
      ...base,
      status: 'accepted',
      respondedAt: new Date('2026-01-02T00:00:00.000Z'),
    };
    const pending = joinRequestView(pendingRequest);
    const responded = joinRequestView(respondedRequest);

    const declared = Object.keys(schema.properties).sort();
    assert.deepEqual(Object.keys(pending).sort(), declared);
    assert.deepEqual(Object.keys(responded).sort(), declared);

    // Required lists presence, not non-nullness: a pending request sends `respondedAt: null`.
    assert.deepEqual([...schema.required].sort(), declared);
    assert.equal(pending.respondedAt, null);
    assert.equal(typeof responded.respondedAt, 'string');
  } finally {
    await h.close();
  }
});

/**
 * Defining `LearnerStepView` and pointing the routes at it are two separate edits, and only the
 * second one changes what the published document promises. Reverting just the two `doc({ responses })
 * lines — leaving the presenter, the routes and both schemas intact — left the api suite at 0 failures while
 * `openapi.json` advertised `expectedSan` and `correctIndex` on routes that no longer send them.
 * The well-formedness test above cannot catch that: it checks every `$ref` resolves, never that a
 * schema is referenced, so an orphaned `LearnerStepView` is invisible to it.
 *
 * The PATCH assertion guards the other direction — a blanket rename that strips the answers from the
 * author too breaks authoring, and would otherwise pass.
 */
test('public step routes reference LearnerStepView/LearnerStepList schemas, authoring routes retain StepView', async () => {
  const h = await startHarness();
  try {
    const doc = h.server.openapiDocument() as any;

    const listRef = doc.paths['/v1/lessons/{id}/steps']?.get?.responses?.['200']?.content?.['application/json']?.schema?.$ref;
    assert.equal(listRef, '#/components/schemas/LearnerStepList');

    const getStepRef = doc.paths['/v1/steps/{id}']?.get?.responses?.['200']?.content?.['application/json']?.schema?.$ref;
    assert.equal(getStepRef, '#/components/schemas/LearnerStepView');

    const patchStepRef = doc.paths['/v1/steps/{id}']?.patch?.responses?.['200']?.content?.['application/json']?.schema?.$ref;
    assert.equal(patchStepRef, '#/components/schemas/StepView');
  } finally {
    await h.close();
  }
});

/**
 * Same coupling the `JoinRequestView` test above pins, for the view whose whole purpose is to leave
 * two fields out: the schema and the presenter are two declarations of one contract, and nothing else
 * makes them agree. A property added to `LearnerStepView` that the presenter never emits would put the
 * answer back in the published contract while every route test stayed green.
 *
 * Asserted as the union across all four kinds rather than per-fixture, because the view is a union of
 * three step kinds plus the tombstone — no single fixture can match the schema exactly, and the union
 * can. Fixtures are typed as the real `LessonStep`: a test that exists to catch contract drift has no
 * business opting out of the check that catches it.
 */
test('LearnerStepView: the served schema describes exactly what the presenter emits across all step kinds', async () => {
  const h = await startHarness();
  try {
    const schema = (h.server.openapiDocument() as any).components.schemas.LearnerStepView;

    const textStep: LessonStep = {
      id: 'e6f0b1a2-0000-4000-8000-000000000001',
      lessonId: 'e6f0b1a2-0000-4000-8000-000000000002',
      orderIndex: 0,
      kind: 'text',
      prose: 'Introduction to basic tactical themes.',
    };

    const moveStep: LessonStep = {
      id: 'e6f0b1a2-0000-4000-8000-000000000010',
      lessonId: 'e6f0b1a2-0000-4000-8000-000000000002',
      orderIndex: 1,
      kind: 'move',
      fen: 'rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq e3 0 1',
      expectedSan: 'e5',
      hint: 'Push e5',
    };

    const quizStep: LessonStep = {
      id: 'e6f0b1a2-0000-4000-8000-000000000011',
      lessonId: 'e6f0b1a2-0000-4000-8000-000000000002',
      orderIndex: 2,
      kind: 'quiz',
      question: 'What is the best move?',
      options: ['e4', 'd4', 'Nf3'],
      correctIndex: 0,
    };

    const deletedStep: LessonStep = {
      id: 'e6f0b1a2-0000-4000-8000-000000000012',
      lessonId: 'e6f0b1a2-0000-4000-8000-000000000002',
      orderIndex: 3,
      kind: 'text',
      prose: 'Tombstoned step.',
      deletedAt: new Date('2026-01-01T00:00:00.000Z'),
    };

    const textView = learnerStepView(textStep);
    const moveView = learnerStepView(moveStep);
    const quizView = learnerStepView(quizStep);
    const deletedView = learnerStepView(deletedStep);

    assert.equal('expectedSan' in moveView, false);
    assert.equal('correctIndex' in quizView, false);
    assert.equal('expectedSan' in schema.properties, false);
    assert.equal('correctIndex' in schema.properties, false);

    const emittedKeysSet = new Set<string>([
      ...Object.keys(textView),
      ...Object.keys(moveView),
      ...Object.keys(quizView),
      ...Object.keys(deletedView),
    ]);

    const emittedKeys = [...emittedKeysSet].sort();
    const schemaDeclaredKeys = Object.keys(schema.properties).sort();

    assert.deepEqual(emittedKeys, schemaDeclaredKeys);
  } finally {
    await h.close();
  }
});

/**
 * `TeamView` listed `updatedAt` in its `required` array. The `Team` domain type has no such field
 * and `teamView` has never emitted one, so the published contract promised every client a timestamp
 * the server does not send — the third instance of the drift ADR-0088 fixed for `ForumPostView` and
 * M14 increment 28 fixed for `JoinRequestView`, and it survived just as long for the same reason:
 * every route test reads the response, and none read the schema.
 *
 * `TeamDetailView` is pinned alongside it because it is new, and a contract is cheapest to hold
 * still from the day it is published.
 */
test('TeamView and TeamDetailView describe exactly what their presenters emit', async () => {
  const h = await startHarness();
  try {
    const schemas = (h.server.openapiDocument() as any).components.schemas;

    const team: Team = {
      id: 'e6f0b1a2-0000-4000-8000-000000000001',
      slug: 'a-team',
      name: 'A Team',
      description: 'Description',
      visibility: 'public',
      createdBy: 'e6f0b1a2-0000-4000-8000-000000000002',
      createdAt: new Date('2026-01-01T00:00:00.000Z'),
    };

    const listed = Object.keys(teamView(team)).sort();
    assert.deepEqual(listed, Object.keys(schemas.TeamView.properties).sort());
    assert.deepEqual(listed, [...schemas.TeamView.required].sort());

    // Both branches of the viewer's role: `required` lists presence, and a non-member is sent an
    // explicit null rather than having the key omitted.
    const asMember = teamDetailView(team, 'admin');
    const asStranger = teamDetailView(team, null);
    const detailKeys = Object.keys(asMember).sort();

    assert.deepEqual(detailKeys, Object.keys(schemas.TeamDetailView.properties).sort());
    assert.deepEqual(detailKeys, Object.keys(asStranger).sort());
    assert.deepEqual(detailKeys, [...schemas.TeamDetailView.required].sort());
    assert.equal(asStranger.viewerRole, null);
  } finally {
    await h.close();
  }
});

/**
 * The last presenter without one of these, added when `AttemptResult.message` was deleted
 * (ADR-0097). The same divergence has been found here three times — `ForumPostView` (ADR-0088),
 * `JoinRequestView` (increment 28) and `TeamView` (increment 30) — and each time it survived because
 * every route test reads the response and none read the schema.
 *
 * Unlike those, `completedAt` here is genuinely optional on both sides: the presenter spreads it
 * conditionally and the schema leaves it out of `required`. So the declared properties are checked
 * against the union of what both branches emit, and `required` is checked separately against the
 * keys that are always present. Asserting one against the other would fail on a correct contract.
 */
test('AttemptResultView: the served schema describes exactly what the presenter emits', async () => {
  const h = await startHarness();
  try {
    const schema = (h.server.openapiDocument() as any).components.schemas.AttemptResultView;

    const base = { stepId: 'e6f0b1a2-0000-4000-8000-000000000001', attempts: 2 };
    const inProgress: AttemptResult = { ...base, correct: false };
    const completed: AttemptResult = {
      ...base,
      correct: true,
      completedAt: new Date('2026-01-01T00:00:00.000Z'),
    };

    const pending = attemptResultView(inProgress);
    const done = attemptResultView(completed);

    const emitted = [...new Set([...Object.keys(pending), ...Object.keys(done)])].sort();
    assert.deepEqual(emitted, Object.keys(schema.properties).sort());

    // `required` is what every response carries, which is the pending shape.
    assert.deepEqual([...schema.required].sort(), Object.keys(pending).sort());
    assert.equal('completedAt' in pending, false);
    assert.equal(typeof done.completedAt, 'string');
  } finally {
    await h.close();
  }
});

/**
 * Pin the `Capabilities` schema against `capabilitiesView` presenter output so they cannot drift.
 * Adding or removing a capability key from the presenter without updating `Capabilities` in `schemas.ts`
 * (or vice versa) fails this test.
 */
test('Capabilities: the served schema describes exactly what the presenter emits', async () => {
  const h = await startHarness();
  try {
    const schema = (h.server.openapiDocument() as any).components.schemas.Capabilities;
    const view = capabilitiesView({
      learningRepository: h.learningRepository,
      studiesRepository: h.studiesRepository,
      achievementsRepository: h.achievementsRepository,
      searchRepository: h.searchRepository,
      socialGraphRepository: h.socialGraphRepository,
      messagingRepository: h.messagingRepository,
      communityRepository: h.communityRepository,
      analysis: h.analysis,
    });

    const presenterKeys = Object.keys(view.capabilities).sort();
    const schemaDeclaredKeys = Object.keys(schema.properties.capabilities.properties).sort();
    const schemaRequiredKeys = [...schema.properties.capabilities.required].sort();

    assert.deepEqual(presenterKeys, schemaDeclaredKeys);
    assert.deepEqual(presenterKeys, schemaRequiredKeys);
  } finally {
    await h.close();
  }
});

/**
 * Pin `WebAuthnRegisterOptions` and `WebAuthnLoginOptions` schemas against service options output.
 */
test('WebAuthnOptions: served schemas match actual options emitted by service', async () => {
  const h = await startHarness();
  try {
    const schemas = (h.server.openapiDocument() as any).components.schemas;
    const { token } = await h.makeUser('optsuser');

    const regRes = await h.json('POST', '/v1/auth/webauthn/register/options', { token });
    assert.equal(regRes.status, 200);
    const regOptions = regRes.body;

    const regDeclaredKeys = Object.keys(schemas.WebAuthnRegisterOptions.properties).sort();
    assert.deepEqual(Object.keys(regOptions).sort(), regDeclaredKeys);
    assert.deepEqual([...schemas.WebAuthnRegisterOptions.required].sort(), regDeclaredKeys);
    assert.equal(regOptions.authenticatorSelection.residentKey, 'required');
    assert.equal('residentKey' in schemas.WebAuthnRegisterOptions.properties.authenticatorSelection.properties, true);
    assert.equal('requireResidentKey' in schemas.WebAuthnRegisterOptions.properties.authenticatorSelection.properties, false);

    const loginRes = await h.json('POST', '/v1/auth/webauthn/login/options', { body: { handle: 'optsuser' } });
    assert.equal(loginRes.status, 200);
    const loginOptions = loginRes.body;

    const loginRequiredKeys = [...schemas.WebAuthnLoginOptions.required].sort();
    assert.deepEqual(Object.keys(loginOptions).sort(), loginRequiredKeys);
    assert.equal(schemas.WebAuthnLoginOptions.required.includes('allowCredentials'), false);
  } finally {
    await h.close();
  }
});

/**
 * `SessionView` is the account-security screen's entire data source, and it had no coupling test
 * even though the list route predates this increment — the same gap that let `ForumPostView`,
 * `JoinRequestView` and `TeamView` drift (ADR-0088). Pinned now that a second route operates on the
 * same objects: a field added to the presenter without the schema would be invisible to any
 * consumer reading the spec, and a field declared but never emitted is a promise the server breaks.
 */
test('SessionView: the served schema describes exactly what the presenter emits', async () => {
  const h = await startHarness();
  try {
    const schema = (h.server.openapiDocument() as any).components.schemas.SessionView;

    const view = sessionView({
      id: 's1',
      userId: 'u1',
      createdAt: new Date('2026-01-01T00:00:00Z'),
      expiresAt: new Date('2026-02-01T00:00:00Z'),
      revokedAt: null,
      rotatedFrom: null,
      lastSeenAt: new Date('2026-01-02T00:00:00Z'),
      lastIp: '203.0.113.1',
      lastUserAgent: 'Mozilla/5.0',
      createdIp: '203.0.113.9',
      createdUserAgent: 'Mozilla/5.0 (first sign-in)',
    });

    const presenterKeys = Object.keys(view).sort();
    assert.deepEqual(presenterKeys, Object.keys(schema.properties).sort());
    assert.deepEqual(presenterKeys, [...schema.required].sort());

    // The presenter must not leak session internals the schema does not declare. `userId` is
    // redundant (the route is already scoped to the caller) and `rotatedFrom` exposes the refresh
    // rotation chain, which is a server-side integrity detail rather than something a user acts on.
    assert.equal('userId' in view, false, 'sessionView must not expose userId');
    assert.equal('rotatedFrom' in view, false, 'sessionView must not expose the rotation chain');
    assert.equal(JSON.stringify(view).includes('refresh'), false, 'no refresh material in the view');
  } finally {
    await h.close();
  }
});

/** The revocation route must be declared, authenticated, and non-guessable about other users. */
test('DELETE /v1/auth/sessions/{id} is declared with bearer security', async () => {
  const h = await startHarness();
  try {
    const spec = h.server.openapiDocument() as any;
    const op = spec.paths['/v1/auth/sessions/{id}']?.delete;
    assert.ok(op, 'the revocation route must appear in the served spec');
    assert.deepEqual(op.security, [{ bearerAuth: [] }]);
    assert.ok(op.responses['204'], 'declares the success status the handler returns');
    assert.ok(op.responses['404'], 'declares the not-found status used for another user\'s id');
    assert.equal(op.responses['403'], undefined, 'must not advertise a 403 — that would be an existence oracle');
  } finally {
    await h.close();
  }
});

/**
 * MoveExplanationResponse: the served schema describes exactly what the presenter emits.
 */
test('MoveExplanationResponse: the served schema describes exactly what the presenter emits', async () => {
  const h = await startHarness();
  try {
    const doc = h.server.openapiDocument();
    const components = doc['components'] as { schemas: Record<string, JsonSchema> };
    const schema = components.schemas['MoveExplanationResponse'];
    assert.ok(schema && schema.properties && schema.required);

    const view = moveExplanationView({
      fen: 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1',
      variant: 'standard',
      move: 'e2e4',
      explanation: 'e4 controls central squares.',
      citation: {
        moveOutcome: { kind: 'evaluation', evalKind: 'cp', evalValue: 20, evalLabel: '+0.20' },
        evalKind: 'cp',
        evalValue: 30,
        evalLabel: '+0.30',
        bestMove: 'e2e4',
        bestLine: ['e2e4', 'e7e5'],
        depth: 16,
      },
      providerId: 'test-provider',
      model: 'test-model',
    });

    const presenterKeys = Object.keys(view).sort();
    assert.deepEqual(presenterKeys, Object.keys(schema.properties).sort());
    assert.deepEqual(presenterKeys, [...schema.required].sort());

    const citationSchema = schema.properties['citation'];
    assert.ok(citationSchema && citationSchema.properties && citationSchema.required);
    const citationKeys = Object.keys(view.citation).sort();
    assert.deepEqual(citationKeys, Object.keys(citationSchema.properties).sort());
    assert.deepEqual(citationKeys, [...citationSchema.required].sort());
  } finally {
    await h.close();
  }
});

test('PuzzleGenerationResponse: every result branch matches its served schema', async () => {
  const h = await startHarness();
  try {
    const schema = (h.server.openapiDocument() as any).components.schemas.PuzzleGenerationResponse;
    const fen = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';
    const common = {
      fen,
      variant: 'standard' as const,
      evidence: { kind: 'centipawn_gap' as const, gapCp: 270 },
      bestMove: 'e2e4',
      comparisonMove: 'd2d4',
      bestEvaluation: { type: 'cp' as const, value: 350 },
      comparisonEvaluation: { type: 'cp' as const, value: 80 },
      depth: 16,
    };
    const views = [
      puzzleGenerationView({
        kind: 'puzzle',
        ...common,
        solutionMove: 'e2e4',
        solutionLine: ['e2e4', 'e7e5'],
        difficulty: 'easy',
      }),
      puzzleGenerationView({ kind: 'no_tactic', ...common }),
      puzzleGenerationView({
        kind: 'insufficient',
        fen,
        variant: 'standard',
        reason: 'not_enough_lines',
        bestMove: 'e2e4',
        comparisonMove: null,
      }),
    ];

    for (const view of views) {
      const branch = schema.oneOf.find(
        (candidate: any) => candidate.properties?.kind?.enum?.[0] === view.kind,
      );
      assert.ok(branch, `no PuzzleGenerationResponse branch for kind '${view.kind}'`);
      assert.deepEqual(Object.keys(view).sort(), [...branch.required].sort());
      assert.deepEqual(Object.keys(view).sort(), Object.keys(branch.properties).filter((key) => key !== 'terminal').sort());
    }
  } finally {
    await h.close();
  }
});


/**
 * The opening contract, and the field it deliberately does not have.
 *
 * `OpeningContinuationView` is the schema that keeps the bundled statistics off the wire
 * (ADR-0127). Asserting the presenter's keys against `required` *and* `properties` means a field
 * added to either side alone fails here; `additionalProperties: false` closes the third route in,
 * where a value rides along without a schema entry at all.
 */
test('OpeningExplorationResponse: the served view matches its schema, statistics included in neither', async () => {
  const h = await startHarness();
  try {
    const schemas = (h.server.openapiDocument() as any).components.schemas;
    const response = schemas.OpeningExplorationResponse;
    const continuation = schemas.OpeningContinuationView;
    const request = schemas.OpeningExplorationRequest;

    const view = openingExplorationView({
      moves: ['e2e4', 'e7e5', 'g1f3', 'b8c6', 'f1b5'],
      found: true,
      eco: 'C60',
      name: 'Ruy Lopez (Spanish Opening)',
      matchedMoves: 5,
      outOfBook: false,
      continuations: [{ move: 'a7a6', san: 'a6', eco: 'C70', name: 'Ruy Lopez, Morphy Defense' }],
    });

    assert.deepEqual(Object.keys(view).sort(), [...response.required].sort());
    assert.deepEqual(Object.keys(view).sort(), Object.keys(response.properties).sort());
    assert.equal(response.additionalProperties, false);

    assert.deepEqual([...continuation.required].sort(), ['eco', 'move', 'name', 'san']);
    assert.deepEqual(Object.keys(continuation.properties).sort(), ['eco', 'move', 'name', 'san']);
    assert.equal(continuation.additionalProperties, false);
    assert.deepEqual(Object.keys(view.continuations[0]!).sort(), ['eco', 'move', 'name', 'san']);

    // The request publishes the server's ply ceiling rather than leaving a caller to discover it
    // from a 422, and accepts nothing else.
    assert.deepEqual([...request.required].sort(), ['moves', 'variant']);
    assert.deepEqual(Object.keys(request.properties).sort(), ['initialFen', 'moves', 'variant']);
    assert.equal(request.properties.moves.maxItems, MAX_EXPLORED_PLIES);
    assert.equal(request.additionalProperties, false);

    assert.ok(
      [...schemas.Capabilities.properties.capabilities.required].includes('openingExplorer'),
      'the capability is required, so a client can rely on its presence',
    );
  } finally {
    await h.close();
  }
});
