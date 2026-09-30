/**
 * Pure helpers for the Direct Messaging UI.
 */
import type { ConversationView, MessageView } from '../api/models.js';
import type { I18n } from '../i18n/manager.js';

/**
 * Derive the other participant's user ID from a ConversationView and the caller's user ID.
 * If currentUserId is participantA, returns participantB, otherwise returns participantA.
 */
export function getOtherParticipantId(conv: ConversationView, currentUserId: string): string {
  return conv.participantA === currentUserId ? conv.participantB : conv.participantA;
}

/**
 * Get the text to display for a message body.
 * If the message has been tombstoned (deletedAt !== null), returns placeholder text.
 */
export function getMessageDisplayBody(message: MessageView, i18n?: I18n): string {
  if (message.deletedAt !== null) {
    return i18n ? i18n.t('community.messages.deleted') : '[Message deleted]';
  }
  return message.body;
}

/**
 * Truncate a message body preview for the inbox row display.
 */
export function truncatePreview(body: string, maxLength = 50): string {
  if (body.length <= maxLength) return body;
  return `${body.slice(0, maxLength)}…`;
}
