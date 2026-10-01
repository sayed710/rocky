/**
 * Forum view renderers — pure DOM helpers. Titles and post bodies are user-supplied, so everything
 * goes through the shared `el()` helper, which appends strings as text nodes.
 */
import { el } from './dom.js';
import { renderEmpty } from './render-helpers.js';
import { shortId } from '../api/graphql.js';
import { postDisplayBody, sortThreads, threadDisplayTitle } from './forum-helpers.js';
import type { ForumPost, ForumThread, SocialPlayer } from '../api/models.js';
import { applyAutoDirection } from '../i18n/bidi.js';
import type { I18nManager } from '../i18n/manager.js';

export function renderThreadList(
  container: HTMLElement,
  slug: string,
  threads: readonly ForumThread[],
  names: ReadonlyMap<string, SocialPlayer>,
  i18n: I18nManager,
): void {
  container.replaceChildren();
  if (threads.length === 0) {
    renderEmpty(container, {
      mark: '♞',
      title: i18n.t('community.forum.emptyThreadsTitle'),
      body: i18n.t('community.forum.emptyThreadsBody'),
    });
    return;
  }

  const doc = container.ownerDocument;
  for (const thread of sortThreads(threads)) {
    const author = names.get(thread.authorId)?.handle ?? shortId(thread.authorId);
    const link = el(
      doc,
      'a',
      {
        href: `/teams/${encodeURIComponent(slug)}/forum/${encodeURIComponent(thread.id)}`,
        'data-route': 'thread',
        class: 'row-link',
      },
      threadDisplayTitle(thread, i18n),
    );
    applyAutoDirection(link);

    // `.panel-row` is space-between, so the row takes exactly two children: what identifies the
    // thread leads, and its state trails.
    const authorEl = el(doc, 'span', { class: 'count' }, author);
    applyAutoDirection(authorEl);
    const leading: (Node | string)[] = [link, authorEl];
    const row = el(doc, 'div', { class: 'panel-row' }, el(doc, 'span', { class: 'row-main' }, ...leading));

    // Only states that change what you can do earn a tag; "unlocked" and "unpinned" are the norm.
    const tags: string[] = [];
    if (thread.pinned) tags.push(i18n.t('community.forum.tagPinned'));
    if (thread.locked) tags.push(i18n.t('community.forum.tagLocked'));
    if (tags.length > 0) {
      row.appendChild(el(doc, 'span', { class: 'count' }, tags.join(' · ')));
    }

    container.appendChild(row);
  }
}

export function renderPosts(
  container: HTMLElement,
  posts: readonly ForumPost[],
  names: ReadonlyMap<string, SocialPlayer>,
  viewerId: string | null,
  i18n: I18nManager,
): void {
  container.replaceChildren();
  if (posts.length === 0) {
    renderEmpty(container, {
      title: i18n.t('community.forum.emptyPostsTitle'),
      body: i18n.t('community.forum.emptyPostsBody'),
      inline: true,
    });
    return;
  }

  const doc = container.ownerDocument;
  for (const post of posts) {
    const author = names.get(post.authorId)?.handle ?? shortId(post.authorId);
    const senderEl = el(doc, 'span', { class: 'message-sender' }, author);
    applyAutoDirection(senderEl);

    const meta: (Node | string)[] = [
      senderEl,
      el(doc, 'span', { class: 'count' }, formatPostTime(post.createdAt, i18n.locale)),
    ];
    // An edit is a fact about the post that changes how to read it; it is not an emphasis, so it
    // sits in the same muted meta line rather than getting a treatment of its own.
    if (post.editedAt !== null && post.deletedAt === null) {
      meta.push(el(doc, 'span', { class: 'count' }, i18n.t('community.forum.tagEdited')));
    }

    const isTombstone = post.deletedAt !== null;
    const bodyEl = el(
      doc,
      'div',
      { class: isTombstone ? 'message-body message-tombstone' : 'message-body' },
      postDisplayBody(post, i18n),
    );
    applyAutoDirection(bodyEl);

    const own = viewerId !== null && post.authorId === viewerId;
    container.appendChild(
      el(
        doc,
        'div',
        { class: own ? 'message-item own' : 'message-item' },
        el(doc, 'div', { class: 'message-header' }, ...meta),
        bodyEl,
      ),
    );
  }
}

function formatPostTime(iso: string, locale?: string): string {
  try {
    const d = new Date(iso);
    if (isNaN(d.getTime())) return iso;
    return d.toLocaleString(locale ?? 'en', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
  } catch {
    return iso;
  }
}
