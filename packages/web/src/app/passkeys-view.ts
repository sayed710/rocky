/**
 * DOM rendering for the passkeys section.
 *
 * Uses the standard `.panel-list`/`.panel-row` composition and `renderEmpty` helper.
 */
import type { PasskeyView } from '../api/models.js';
import type { I18nManager } from '../i18n/manager.js';
import { appendPanelRow, renderEmpty } from './render-helpers.js';

export function renderPasskeys(
  container: HTMLElement,
  passkeys: readonly PasskeyView[],
  onDelete: (id: string) => void,
  busy: boolean,
  i18n?: I18nManager,
): void {
  container.innerHTML = '';
  if (passkeys.length === 0) {
    renderEmpty(container, {
      title: i18n ? i18n.t('profile.passkeys.emptyTitle') : 'No passkeys registered yet',
      body: i18n ? i18n.t('profile.passkeys.emptyBody') : 'Add a passkey for fast, passwordless sign-in.',
      inline: true,
    });
    return;
  }

  for (const passkey of passkeys) {
    const createdDate = passkey.createdAt.slice(0, 10);
    const defaultName = i18n ? i18n.t('profile.passkeys.defaultName') : 'Passkey';
    const label = `${passkey.name || defaultName} (${createdDate})`;
    const deleteLabel = i18n ? i18n.t('profile.passkeys.delete') : 'Delete';
    appendPanelRow(
      container,
      label,
      [{ label: deleteLabel, run: () => onDelete(passkey.id) }],
      busy,
    );
  }
}
