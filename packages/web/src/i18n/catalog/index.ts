import { enMessages } from './en.js';

/**
 * Union of all canonical message keys supported in Rookzen.
 * Strongly typed and derived from the canonical English catalog.
 */
export type MessageKey = keyof typeof enMessages;

/**
 * A complete message catalog mapping every valid MessageKey to a translated string.
 */
export type MessagesCatalog = Readonly<Record<MessageKey, string>>;

export { enMessages };

/**
 * Type guard verifying whether a string is a valid MessageKey.
 */
export function isMessageKey(key: string): key is MessageKey {
  return Object.prototype.hasOwnProperty.call(enMessages, key);
}
