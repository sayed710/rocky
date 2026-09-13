/**
 * @packageDocumentation
 * Minimal, dependency-free OpenAPI 3.1 schema surface: the types we emit, plus the one builder
 * ({@link nullable}) whose job is to keep a 3.0 keyword from coming back. We model only the subset we
 * emit. Route handlers carry a {@link RouteDoc} describing their contract; the
 * spec builder ({@link ../openapi/spec}) folds these into a complete document.
 */

/** A JSON Schema type name. */
export type SchemaType = 'object' | 'array' | 'string' | 'integer' | 'number' | 'boolean' | 'null';

/**
 * A JSON Schema object (the subset we produce). `$ref` points at components.
 *
 * There is deliberately no `nullable` here. It was an OpenAPI 3.0 keyword, invented because JSON
 * Schema Draft 4 could not express a union; 3.1 is JSON Schema 2020-12, where `type` takes an
 * array and `nullable` is not a keyword at all. A 3.1 document carrying it does not describe a
 * nullable field — it describes a non-nullable one, plus an annotation every validator ignores.
 * Leaving the property off the type is what stops it coming back: {@link nullable} is the only
 * way to build one, so a field cannot be marked nullable without actually becoming nullable.
 */
export interface JsonSchema {
  readonly $ref?: string;
  readonly type?: SchemaType | readonly SchemaType[];
  readonly format?: string;
  readonly description?: string;
  /** `null` is admissible so a nullable enum can list it — see {@link nullable}. */
  readonly enum?: readonly (string | number | boolean | null)[];
  readonly items?: JsonSchema;
  readonly properties?: Readonly<Record<string, JsonSchema>>;
  readonly required?: readonly string[];
  readonly additionalProperties?: boolean | JsonSchema;
  readonly minimum?: number;
  readonly maximum?: number;
  readonly minLength?: number;
  readonly maxLength?: number;
  readonly pattern?: string;
  /** Array bound. Published so a caller learns a server ceiling from the contract, not from a 422. */
  readonly maxItems?: number;
  readonly default?: string | number | boolean;
  readonly example?: unknown;
  readonly oneOf?: readonly JsonSchema[];
  readonly anyOf?: readonly JsonSchema[];
}

/**
 * The same schema, widened to admit `null`.
 *
 * **Nullable is not optional.** A nullable property is always present and may hold `null`; an
 * optional one may be absent and, when present, still obeys its type. They are independent, and
 * this helper only ever touches the former — it never adds to or removes from a `required` list,
 * so a required field stays required and an optional one stays optional. `RegisterRequest.email`
 * is the case that needs both: optional in `required`, and nullable here.
 *
 * Three shapes, because a single rule would be wrong for two of them:
 *
 * - **A typed schema** becomes a type union: `{type: 'string'}` → `{type: ['string', 'null']}`.
 *   Every sibling constraint is carried through untouched, so `format`, `minimum` and the rest
 *   still describe the non-null case.
 * - **An enum** also gains `null` as a member. `enum` is an independent constraint, not a
 *   refinement of `type`: `{type: ['string','null'], enum: ['w','b']}` admits neither `'x'` nor
 *   `null`, so widening the type alone would move the lie rather than remove it.
 * - **A `$ref`** becomes `anyOf: [ref, {type: 'null'}]`. 2020-12 permits `$ref` siblings, but
 *   `{$ref, type: ['object','null']}` reads as *both* constraints at once and `null` fails the
 *   referenced schema — so the honest form is the composition, not the convenient one.
 */
export function nullable(schema: JsonSchema): JsonSchema {
  if (schema.$ref !== undefined) {
    return { anyOf: [schema, { type: 'null' }] };
  }
  if (schema.type === undefined) {
    // A schema with neither `type` nor `$ref` constrains nothing, so it already admits `null` and
    // "widening" it would be a no-op dressed up as an intention. Louder to refuse than to lie.
    throw new Error('nullable() needs a schema with a `type` or a `$ref`');
  }
  const types: readonly SchemaType[] = Array.isArray(schema.type) ? schema.type : [schema.type];
  const widened: readonly SchemaType[] = types.includes('null') ? types : [...types, 'null'];
  return {
    ...schema,
    type: widened,
    ...(schema.enum !== undefined && !schema.enum.includes(null)
      ? { enum: [...schema.enum, null] }
      : {}),
  };
}

/** An OpenAPI parameter (path, query, or header). */
export interface DocParam {
  readonly name: string;
  readonly in: 'path' | 'query' | 'header';
  readonly required: boolean;
  readonly description: string;
  readonly schema: JsonSchema;
}

/** One documented response. */
export interface DocHeader {
  readonly description: string;
  readonly schema: JsonSchema;
}

export interface DocResponse {
  readonly description: string;
  /** Component name (key under `components.schemas`) for the body, if any. */
  readonly schema?: string;
  readonly headers?: Readonly<Record<string, DocHeader>>;
}

/** The OpenAPI contract a route advertises. */
export interface RouteDoc {
  readonly summary: string;
  readonly description?: string;
  readonly tags: readonly string[];
  /** `bearer` marks the operation as requiring the access-token scheme. */
  readonly security: 'none' | 'bearer';
  readonly params?: readonly DocParam[];
  /** Component name for the request body schema, if the operation accepts one. */
  readonly requestSchema?: string;
  /** Whether the request body is required. Defaults to `true` when a `requestSchema` is present. */
  readonly requestBodyRequired?: boolean;
  readonly responses: Readonly<Record<number, DocResponse>>;
}

/** A reusable component schema registered on the spec (name → schema). */
export type ComponentSchemas = Readonly<Record<string, JsonSchema>>;
