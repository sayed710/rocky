/**
 * The published contract's nullability, and the distinction it kept getting wrong.
 *
 * Every nullable field in this API was once declared with `nullable: true` — an OpenAPI
 * **3.0** keyword, in a document whose first line says `"openapi": "3.1.0"`. 3.1 is JSON Schema
 * 2020-12, which has no such keyword and ignores it. So the document did not describe those fields
 * as nullable; it described them as strictly non-null and carried a comment no validator reads,
 * while the server sent `null` on every one of them. A generated client built from that spec would
 * type `PublicUser.country` as `string` and be wrong for every user who has not set a country.
 *
 * These tests pin the correct representation and, more importantly, the two ways it can silently
 * regress: the keyword coming back, and `null` being dropped from a type union or an enum.
 */
import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { startHarness } from './helpers';
import { nullable } from '../src/openapi/types';
import type { JsonSchema } from '../src/openapi/types';

type Schemas = Record<string, JsonSchema>;

/** Start an API harness and expose its OpenAPI schemas with an owned async cleanup callback. */
async function schemas(): Promise<{ doc: any; s: Schemas; close: () => Promise<void> }> {
  const h = await startHarness();
  const doc = h.server.openapiDocument() as any;
  return { doc, s: doc.components.schemas as Schemas, close: () => h.close() };
}

/** Every `nullable` key anywhere in the document, by JSON path. */
function nullableKeyPaths(node: unknown, path: string, acc: string[]): void {
  if (Array.isArray(node)) {
    node.forEach((x, i) => nullableKeyPaths(x, `${path}[${i}]`, acc));
    return;
  }
  if (node && typeof node === 'object') {
    for (const [k, v] of Object.entries(node)) {
      if (k === 'nullable') acc.push(`${path}.${k}`);
      nullableKeyPaths(v, `${path}.${k}`, acc);
    }
  }
}

test('the served document is OpenAPI 3.1 and contains no `nullable` keyword anywhere', async () => {
  const { doc, close } = await schemas();
  try {
    assert.equal(doc.openapi, '3.1.0');
    const found: string[] = [];
    nullableKeyPaths(doc, '$', found);
    assert.deepEqual(found, [], `3.0's \`nullable\` is not a 3.1 keyword; found at: ${found.join(', ')}`);
  } finally {
    await close();
  }
});

test('nullable scalars declare a type union including null, keeping their format', async () => {
  const { s, close } = await schemas();
  try {
    // A bare string, and the three formats the document actually uses on nullable fields.
    assert.deepEqual(s['PublicUser']!.properties!['country'], { type: ['string', 'null'] });
    assert.deepEqual(s['RatingView']!.properties!['updatedAt'], {
      type: ['string', 'null'],
      format: 'date-time',
    });
    assert.deepEqual(s['GameSummary']!.properties!['whiteId'], {
      type: ['string', 'null'],
      format: 'uuid',
    });
    assert.deepEqual(s['RegisterRequest']!.properties!['email'], {
      type: ['string', 'null'],
      format: 'email',
    });
    // Integer, the only numeric kind the document uses nullably.
    assert.deepEqual(s['SeekView']!.properties!['minRating'], { type: ['integer', 'null'] });
  } finally {
    await close();
  }
});

/**
 * `enum` is an independent constraint, not a refinement of `type`.
 *
 * `{type: ['string','null'], enum: ['w','b']}` admits neither `'x'` nor `null` — the enum rejects
 * what the type just allowed. Widening only the type would have moved the lie rather than removed
 * it, and it is the failure a reviewer is least likely to notice because the type array looks right.
 */
test('nullable enums list null as a member, not just in the type union', async () => {
  const { s, close } = await schemas();
  try {
    assert.deepEqual(s['TeamDetailView']!.properties!['viewerRole'], {
      type: ['string', 'null'],
      enum: ['owner', 'admin', 'member', null],
    });
    const winner = (s['LiveBoard']!.properties!['status'] as JsonSchema).properties!['winner'];
    assert.deepEqual(winner, { type: ['string', 'null'], enum: ['w', 'b', null] });
  } finally {
    await close();
  }
});

/**
 * All four combinations exist in this document, and `CreateSeekRequest` carries three of them,
 * which is why it is the fixture: `rated` may be absent but is never null, `minRating` may be
 * either, and `variant` is always present and never null. If nullability and optionality were the
 * same axis, one schema could not hold all three.
 */
test('optional and nullable are independent axes, and the migration moved only one of them', async () => {
  const { s, close } = await schemas();
  try {
    const seek = s['CreateSeekRequest']!;
    const required = new Set(seek.required ?? []);

    // Optional, not nullable: send it or leave it out — but if you send it, it is a boolean.
    assert.equal(required.has('rated'), false);
    assert.equal(seek.properties!['rated']!.type, 'boolean');

    // Optional AND nullable: absent, a number, or an explicit null. Both at once.
    assert.equal(required.has('minRating'), false);
    assert.deepEqual(seek.properties!['minRating'], {
      type: ['integer', 'null'],
      minimum: 0,
      maximum: 4000,
    });
    assert.equal(required.has('maxRating'), false);
    assert.deepEqual(seek.properties!['maxRating'], {
      type: ['integer', 'null'],
      minimum: 0,
      maximum: 4000,
    });

    // Required, not nullable: always present, never null.
    assert.equal(required.has('variant'), true);
    assert.equal(seek.properties!['variant']!.type, 'string');

    // Required AND nullable: always sent, and `null` when the user has set no country. This is
    // the combination `nullable: true` described worst — a client generated from the old document
    // typed it as a plain `string` and was wrong for every such user.
    const user = s['PublicUser']!;
    assert.equal(user.required!.includes('country'), true);
    assert.deepEqual(user.properties!['country']!.type, ['string', 'null']);

    // And the field this increment must not have quietly made optional: `centipawnLoss` is always
    // sent, and is `null` when the move has no centipawn value to report — a delivered mate, or a
    // game already lost (ADR-0118).
    const mistake = s['MistakePredictionResponse']!;
    assert.equal(mistake.required!.includes('centipawnLoss'), true);
    assert.equal(mistake.required!.includes('bestMove'), true);
    assert.deepEqual(mistake.properties!['centipawnLoss'], { type: ['integer', 'null'] });

    // `email` stayed out of `required` — widening a type must never add a field to it.
    assert.deepEqual(s['RegisterRequest']!.required, ['handle', 'password']);
  } finally {
    await close();
  }
});

/**
 * The whole population rather than a sample.
 *
 * The tests above name six fields. This one holds every nullable schema in the document to the
 * same rules, so an enum that loses its `null` member somewhere nobody thought to sample still
 * fails — which is exactly how the original defect survived: it was uniform, and nothing checked
 * it in bulk.
 *
 * The count is asserted too. It is a number that must be updated deliberately when a nullable
 * field is added or removed, and that is the point: a migration that silently dropped nullability
 * from a field would otherwise leave every remaining field still well-formed.
 */
test('every nullable schema in the document is well-formed, and there are 64 of them', async () => {
  const { doc, close } = await schemas();
  try {
    const nullables: { path: string; schema: JsonSchema }[] = [];
    const walk = (node: unknown, path: string): void => {
      if (Array.isArray(node)) {
        node.forEach((x, i) => walk(x, `${path}[${i}]`));
        return;
      }
      if (!node || typeof node !== 'object') return;
      const schema = node as JsonSchema;
      if (Array.isArray(schema.type) && schema.type.includes('null')) {
        nullables.push({ path, schema });
      }
      for (const [k, v] of Object.entries(node)) walk(v, `${path}.${k}`);
    };
    walk(doc, '$');

    assert.equal(nullables.length, 64, `nullable field count changed: ${nullables.length}`);

    for (const { path, schema } of nullables) {
      const types = schema.type as readonly string[];
      assert.equal(types.length, 2, `${path}: expected exactly one type beside null`);
      assert.equal(types[1], 'null', `${path}: null must be the widening, not the base type`);
      assert.notEqual(types[0], 'null', `${path}: a schema of only null describes nothing`);
      if (schema.enum !== undefined) {
        assert.ok(
          schema.enum.includes(null),
          `${path}: the type admits null but the enum does not, so null is still rejected`,
        );
      }
    }
  } finally {
    await close();
  }
});

/**
 * The committed artifact is what clients generate from; the served document is what the server
 * answers with. Nothing made them agree — no test and no CI step — so the artifact could drift a
 * whole release behind and every suite would stay green.
 */
test('the committed openapi.json is exactly what the generator produces', async () => {
  const { doc, close } = await schemas();
  try {
    // Parsed, not compared as bytes: the generator writes LF and git checks out CRLF on Windows,
    // so a byte comparison would fail on a file that is in fact identical.
    const committed = JSON.parse(readFileSync(join(process.cwd(), 'openapi.json'), 'utf8'));
    assert.deepEqual(
      committed,
      doc,
      'packages/api/openapi.json is stale — run `npm run build && npm run openapi` in packages/api',
    );
  } finally {
    await close();
  }
});

// --- the builder itself ------------------------------------------------------------------------
//
// The document contains only nullable scalars and enums, so the cases below are exercised here
// rather than by adding fields to the public contract that exist only to be tested. A schema
// invented for a test is a schema a client can read.

test('nullable() widens a bare type and carries every sibling constraint through', () => {
  assert.deepEqual(nullable({ type: 'number' }), { type: ['number', 'null'] });
  assert.deepEqual(nullable({ type: 'integer', minimum: 0, maximum: 100, description: 'A score' }), {
    type: ['integer', 'null'],
    minimum: 0,
    maximum: 100,
    description: 'A score',
  });
  assert.deepEqual(nullable({ type: 'string', minLength: 1, maxLength: 8 }), {
    type: ['string', 'null'],
    minLength: 1,
    maxLength: 8,
  });
});

test('nullable() widens arrays and objects without disturbing what they contain', () => {
  assert.deepEqual(nullable({ type: 'array', items: { type: 'string' } }), {
    type: ['array', 'null'],
    items: { type: 'string' },
  });
  assert.deepEqual(
    nullable({ type: 'object', properties: { id: { type: 'string' } }, required: ['id'] }),
    { type: ['object', 'null'], properties: { id: { type: 'string' } }, required: ['id'] },
  );
});

/**
 * A `$ref` cannot be widened in place. 2020-12 permits `$ref` siblings, so
 * `{$ref: '...', type: ['object','null']}` is syntactically legal — and wrong: it asserts both
 * constraints at once, and `null` fails the referenced schema. The composition is the honest form.
 */
test('nullable() composes a $ref rather than putting a type union beside it', () => {
  assert.deepEqual(nullable({ $ref: '#/components/schemas/TeamView' }), {
    anyOf: [{ $ref: '#/components/schemas/TeamView' }, { type: 'null' }],
  });
});

test('nullable() is idempotent and refuses a schema it cannot widen', () => {
  const once = nullable({ type: 'string', enum: ['a'] });
  assert.deepEqual(nullable(once), once, 'applying it twice must not append a second null');
  assert.throws(
    () => nullable({ description: 'no type, no ref' }),
    /needs a schema with a `type` or a `\$ref`/,
  );
});
