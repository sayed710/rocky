import type { InterpolationParams } from './types.js';

/** Regular expression for matching named placeholders like `{name}` or `{count}`. */
const PLACEHOLDER_REGEX = /\{([a-zA-Z0-9_]+)\}/g;

/**
 * Safely interpolates named parameters into a template string.
 *
 * Example:
 * ```ts
 * interpolate('Hello {name}!', { name: 'World' }); // 'Hello World!'
 * ```
 *
 * Guarantees:
 * - Pure string substitution: zero eval, zero HTML interpretation, zero regex injection.
 * - Missing placeholders remain unchanged.
 * - Numbers and strings are formatted deterministically.
 */
export function interpolate(template: string, params?: InterpolationParams): string {
  if (!template || !params) {
    return template;
  }

  return template.replace(PLACEHOLDER_REGEX, (match, key: string) => {
    if (Object.prototype.hasOwnProperty.call(params, key)) {
      const val = params[key];
      if (val !== undefined && val !== null) {
        return String(val);
      }
    }
    return match;
  });
}
