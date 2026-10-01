import type { GambitClient } from '../api/client.js';
import type { I18nManager } from '../i18n/manager.js';
import { EmailVerificationController } from './email-verification-controller.js';
import type { EmailVerificationCallbacks, EmailVerificationErrorKey } from './email-verification-controller.js';

interface EmailVerificationElements {
  readonly section: HTMLElement | null;
  readonly status: HTMLElement | null;
  readonly error: HTMLElement | null;
  readonly retry: HTMLButtonElement | null;
}

interface EmailVerificationState {
  token: string | null;
  pending: boolean;
}

export interface EmailVerificationMountOptions {
  readonly doc: Document;
  readonly client: GambitClient;
  readonly verificationToken: string | null;
  readonly i18n: I18nManager;
}

function emailVerificationElements(doc: Document): EmailVerificationElements {
  return {
    section: doc.getElementById('email-verify'),
    status: doc.getElementById('email-verify-status'),
    error: doc.getElementById('email-verify-error'),
    retry: doc.getElementById('email-verify-retry') as HTMLButtonElement | null,
  };
}

function setEmailVerificationPending(
  elements: EmailVerificationElements,
  pending: boolean,
  i18n: I18nManager,
): void {
  if (elements.retry) {
    elements.retry.disabled = pending;
    elements.retry.textContent = i18n.t('emailVerification.retry');
  }
  if (elements.section) elements.section.setAttribute('aria-busy', String(pending));
  if (elements.status && pending) {
    elements.status.textContent = i18n.t('emailVerification.verifyingStatus');
  }
}

function resetEmailVerificationSurface(
  elements: EmailVerificationElements,
  i18n: I18nManager,
): void {
  if (elements.status) elements.status.textContent = '';
  if (elements.error) elements.error.textContent = '';
  if (elements.retry) elements.retry.hidden = true;
  setEmailVerificationPending(elements, false, i18n);
}

function createEmailVerificationCallbacks(
  elements: EmailVerificationElements,
  state: EmailVerificationState,
  i18n: I18nManager,
  recordStatus?: (hasSuccess: boolean, errorKey: EmailVerificationErrorKey | null) => void,
): EmailVerificationCallbacks {
  let wasRetryable = false;

  return {
    onPending: (pending) => {
      state.pending = pending;
      setEmailVerificationPending(elements, pending, i18n);
      if (pending) {
        wasRetryable = false;
        recordStatus?.(false, null);
        if (elements.error) elements.error.textContent = '';
      } else if (!wasRetryable) {
        state.token = null;
      }
    },
    onError: (message, errorKey) => {
      recordStatus?.(false, errorKey ?? null);
      if (elements.error) elements.error.textContent = message ?? '';
      if (message && elements.status) {
        elements.status.textContent = '';
      }
    },
    onSuccess: (message) => {
      if (message) {
        recordStatus?.(true, null);
        if (elements.status) elements.status.textContent = message;
        if (elements.error) elements.error.textContent = '';
        state.token = null;
      }
    },
    onRetryable: (retryable) => {
      wasRetryable = retryable;
      if (elements.retry) elements.retry.hidden = !retryable;
    },
  };
}

function bindEmailVerificationActions(
  elements: EmailVerificationElements,
  state: EmailVerificationState,
  controller: EmailVerificationController,
): void {
  if (elements.retry) {
    elements.retry.onclick = () => {
      if (!state.token) return;
      void controller.verify(state.token);
    };
  }
}

function disposeEmailVerificationMount(
  elements: EmailVerificationElements,
  state: EmailVerificationState,
  controller: EmailVerificationController,
  i18n: I18nManager,
): void {
  if (elements.retry) elements.retry.onclick = null;
  controller.dispose();
  state.token = null;
  setEmailVerificationPending(elements, false, i18n);
}

export function mountEmailVerification(
  options: EmailVerificationMountOptions,
): { dispose: () => void } {
  let disposed = false;
  const elements = emailVerificationElements(options.doc);
  const state: EmailVerificationState = { token: options.verificationToken, pending: false };
  resetEmailVerificationSurface(elements, options.i18n);

  let hasSuccess = false;
  let lastErrorKey: EmailVerificationErrorKey | null = null;

  const controller = new EmailVerificationController({
    client: options.client,
    callbacks: createEmailVerificationCallbacks(elements, state, options.i18n, (success, errorKey) => {
      hasSuccess = success;
      lastErrorKey = errorKey;
    }),
    i18n: options.i18n,
  });
  bindEmailVerificationActions(elements, state, controller);
  void controller.verify(state.token);

  const unsubscribeLocale = options.i18n.onLocaleChange(() => {
    if (elements.retry) elements.retry.textContent = options.i18n.t('emailVerification.retry');
    if (state.pending) setEmailVerificationPending(elements, true, options.i18n);
    if (hasSuccess && elements.status) {
      elements.status.textContent = options.i18n.t('emailVerification.verified');
    }
    if (lastErrorKey && elements.error) {
      elements.error.textContent = options.i18n.t(`emailVerification.${lastErrorKey}`);
    }
  });

  return {
    dispose: () => {
      if (disposed) return;
      disposed = true;
      unsubscribeLocale();
      disposeEmailVerificationMount(elements, state, controller, options.i18n);
    },
  };
}
