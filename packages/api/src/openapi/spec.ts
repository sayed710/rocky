/**
 * @packageDocumentation
 * Builds a complete OpenAPI 3.1 document from the route table. Because every
 * route carries its own {@link RouteDoc}, the spec is generated from the same
 * definitions the router serves — it can never fall out of sync with the running
 * API. The document is served at `GET /v1/openapi.json` and written to disk by
 * `scripts/generate-openapi.ts` for publishing.
 */

import type { RouteDef, Router } from '../http/router';
import { COMPONENT_SCHEMAS } from './schemas';
import type { JsonSchema } from './types';

/** Metadata for the generated document. */
export interface OpenApiInfo {
  readonly title: string;
  readonly version: string;
  readonly description?: string;
  readonly servers?: readonly string[];
}

/** The generated OpenAPI document (typed loosely — it is emitted as JSON). */
export type OpenApiDocument = Record<string, unknown>;

const bodyRef = (schema: string, mediaType = 'application/json'): Record<string, unknown> => ({
  content: { [mediaType]: { schema: { $ref: `#/components/schemas/${schema}` } } },
});

function operationFor(route: RouteDef): Record<string, unknown> {
  const doc = route.doc;
  const responses: Record<string, unknown> = {};
  for (const [status, resp] of Object.entries(doc.responses)) {
    const response: Record<string, unknown> = resp.schema
      ? { description: resp.description, ...bodyRef(resp.schema, resp.mediaType) }
      : { description: resp.description };
    if (resp.headers) response['headers'] = resp.headers;
    responses[status] = response;
  }
  // Every operation can surface the standard error envelope.
  if (!responses['400']) responses['400'] = { description: 'Bad request', ...bodyRef('Error') };
  if (route.auth.required && !responses['401']) {
    responses['401'] = { description: 'Unauthorized', ...bodyRef('Error') };
  }
  if (route.auth.anyRole && route.auth.anyRole.length > 0 && !responses['403']) {
    responses['403'] = { description: 'Forbidden', ...bodyRef('Error') };
  }

  const op: Record<string, unknown> = {
    summary: doc.summary,
    tags: [...doc.tags],
    operationId: operationId(route),
    responses,
  };
  if (doc.description) op['description'] = doc.description;
  if (doc.security === 'bearer') op['security'] = [{ bearerAuth: [] }];
  if (doc.params && doc.params.length > 0) {
    op['parameters'] = doc.params.map((p) => ({
      name: p.name,
      in: p.in,
      required: p.required,
      description: p.description,
      schema: p.schema as JsonSchema,
    }));
  }
  if (doc.requestSchema) {
    op['requestBody'] = { required: doc.requestBodyRequired ?? true, ...bodyRef(doc.requestSchema) };
  }
  return op;
}

function operationId(route: RouteDef): string {
  const parts = route.path
    .split('/')
    .filter(Boolean)
    .map((s) => (s.startsWith(':') ? `by-${s.slice(1)}` : s));
  return `${route.method.toLowerCase()}_${parts.join('_')}`.replace(/[^A-Za-z0-9_]/g, '_');
}

/** Convert a router path (`/v1/users/:handle`) to OpenAPI form (`/v1/users/{handle}`). */
function toOpenApiPath(path: string): string {
  return path
    .split('/')
    .map((s) => (s.startsWith(':') ? `{${s.slice(1)}}` : s))
    .join('/');
}

/** Build the full OpenAPI document for a router. */
export function buildOpenApiDocument(router: Router, info: OpenApiInfo): OpenApiDocument {
  const paths: Record<string, Record<string, unknown>> = {};
  for (const route of router.list()) {
    const p = toOpenApiPath(route.path);
    const entry = paths[p] ?? (paths[p] = {});
    entry[route.method.toLowerCase()] = operationFor(route);
  }

  return {
    openapi: '3.1.0',
    info: {
      title: info.title,
      version: info.version,
      ...(info.description ? { description: info.description } : {}),
      license: { name: 'AGPL-3.0-or-later', identifier: 'AGPL-3.0-or-later' },
    },
    ...(info.servers && info.servers.length > 0
      ? { servers: info.servers.map((url) => ({ url })) }
      : {}),
    paths,
    components: {
      securitySchemes: {
        bearerAuth: { type: 'http', scheme: 'bearer', bearerFormat: 'JWS (HS256)' },
      },
      schemas: COMPONENT_SCHEMAS,
    },
  };
}
