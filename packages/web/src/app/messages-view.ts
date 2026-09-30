/**
 * Messages view renderers — pure DOM helpers that take a container plus data
 * and write DOM using `el()` and existing styling classes.
 */
import { el } from './dom.js';
import { renderEmpty } from './render-helpers.js';
import { shortId } from '../api/graphql.js';
import { getOtherParticipantId, getMessageDisplayBody, truncatePreview } from './messages-helpers.js';
import { applyAutoDirection } from '../i18n/bidi.js';
import type { I18n } from '../i18n/manager.js';
import type { ConversationSummary, MessageView, SocialPlayer } from '../api/models.js';

export function renderInbox(
  container: HTMLElement,
  items: readonly ConversationSummary[],
  names: ReadonlyMap<string, SocialPlayer>,
  currentUserId: string | null,
  i18n?: I18n,
): void {
  container.innerHTML = '';
  if (items.length === 0) {
    renderEmpty(container, {
      mark: '💬',
      title: i18n ? i18n.t('community.messages.emptyInboxTitle') : 'No messages yet',
      body: i18n ? i18n.t('community.messages.emptyInboxBody') : 'Start a conversation from a user profile.',
    });
    return;
  }

  const doc = container.ownerDocument;
  for (const item of items) {
    const otherId = currentUserId
      ? getOtherParticipantId(item.conversation, currentUserId)
      : item.conversation.participantA;
    const handle = names.get(otherId)?.handle ?? shortId(otherId);

    const nameLink = el(
      doc,
      'a',
      { href: `/messages/${encodeURIComponent(item.conversation.id)}`, class: 'row-link' },
      handle,
    );
    applyAutoDirection(nameLink);

    let previewText = '';
    if (item.lastMessage) {
      const displayBody = getMessageDisplayBody(item.lastMessage, i18n);
      previewText = truncatePreview(displayBody, 40);
    }

    const timeStr = item.lastMessage
      ? formatInboxTimestamp(item.lastMessage.sentAt)
      : formatInboxTimestamp(item.conversation.lastMessageAt);

    const detailsText = previewText ? `${previewText} · ${timeStr}` : timeStr;
    const infoSpan = el(doc, 'span', { class: 'count' }, detailsText);
    if (previewText) {
      applyAutoDirection(infoSpan);
    }

    const rowChildren: (Node | string)[] = [nameLink, infoSpan];

    if (item.unreadCount > 0) {
      const badgeText = i18n
        ? i18n.t('community.messages.unreadBadge', { count: item.unreadCount })
        : ` (${item.unreadCount} unread)`;
      const badge = el(doc, 'span', { class: 'count' }, badgeText);
      rowChildren.push(badge);
    }

    const row = el(doc, 'div', { class: 'panel-row' }, ...rowChildren);
    container.appendChild(row);
  }
}

export function renderThread(
  container: HTMLElement,
  messages: readonly MessageView[],
  names: ReadonlyMap<string, SocialPlayer>,
  currentUserId: string | null,
  i18n?: I18n,
): void {
  container.innerHTML = '';
  if (messages.length === 0) {
    renderEmpty(container, {
      title: i18n ? i18n.t('community.messages.emptyThreadTitle') : 'No messages in this thread',
      body: i18n ? i18n.t('community.messages.emptyThreadBody') : 'Type a message below to start chatting.',
      inline: true,
    });
    return;
  }

  const doc = container.ownerDocument;
  for (const m of messages) {
    const isOwn = currentUserId !== null && m.senderId === currentUserId;
    const senderHandle = names.get(m.senderId)?.handle ?? shortId(m.senderId);
    const timeStr = formatTimestamp(m.sentAt);

    const senderSpan = el(doc, 'span', { class: 'message-sender' }, senderHandle);
    applyAutoDirection(senderSpan);
    const timeSpan = el(doc, 'span', { class: 'count' }, timeStr);
    const header = el(doc, 'div', { class: 'message-header' }, senderSpan, timeSpan);

    const displayBody = getMessageDisplayBody(m, i18n);
    const isTombstone = m.deletedAt !== null;
    const bodyClass = isTombstone ? 'message-body message-tombstone' : 'message-body';
    const bodyEl = el(doc, 'div', { class: bodyClass }, displayBody);
    applyAutoDirection(bodyEl);

    const messageClass = isOwn ? 'message-item own' : 'message-item';
    const itemEl = el(doc, 'div', { class: messageClass }, header, bodyEl);

    container.appendChild(itemEl);
  }
}

export function formatTimestamp(iso: string): string {
  try {
    const d = new Date(iso);
    if (isNaN(d.getTime())) return iso;
    return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  } catch {
    return iso;
  }
}

export function formatInboxTimestamp(iso: string, nowMs = Date.now()): string {
  try {
    const d = new Date(iso);
    if (isNaN(d.getTime())) return iso;

    const now = new Date(nowMs);
    const isToday =
      d.getFullYear() === now.getFullYear() &&
      d.getMonth() === now.getMonth() &&
      d.getDate() === now.getDate();

    if (isToday) {
      return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    }
    return d.toLocaleDateString([], { month: 'short', day: 'numeric' });
  } catch {
    return iso;
  }
}
