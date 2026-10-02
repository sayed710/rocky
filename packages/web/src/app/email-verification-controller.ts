/**
 * EmailVerification controller — a pure, DOM-free orchestrator that manages the
 * email verification ceremony.
 *
 * Like {@link PasswordResetController} and {@link AuthController}, it never touches the DOM;
 * the bootstrap layer wires callbacks to DOM elements.
 */
import type { GambitClient } from '../api/client.js';
import type { I18nManager } from '../i18n/manager.js';
import { UnauthorizedError } from '../net/errors.js';

export type EmailVerificationErrorKey = 'needsLink' | 'linkInvalid' | 'couldNotVerify';

export interface EmailVerificationCallbacks {
  /** Called when an operation is in-flight (for UI spinner / disabled / aria-busy state). */
  onPending: (pending: boolean) => void;
  /** Called when an error occurs (for UI error display). */
  onError: (message: string | null, errorKey?: EmailVerificationErrorKey | null) => void;
  /** Called when a success status message should be displayed. */
  onSuccess: (message: string | null) => void;
  /** Whether the surface should offer a retry control for the state just reported. */
  onRetryable: (retryable: boolean) => void;
}

export interface EmailVerificationControllerOptions {
  readonly client: GambitClient;
  readonly callbacks: EmailVerificationCallbacks;
  readonly i18n: I18nManager;
}

export class EmailVerificationController {
  private readonly client: GambitClient;
  private readonly callbacks: EmailVerificationCallbacks;
  private readonly i18n: I18nManager;
  private requestGeneration = 0;
  private pendingGeneration = 0;
  private isSubmitting = false;
  private terminal = false;
  private disposed = false;

  constructor(opts: EmailVerificationControllerOptions) {
    this.client = opts.client;
    this.callbacks = opts.callbacks;
    this.i18n = opts.i18n;
  }

  /**
   * Verify an email verification token.
   * Returns true on success, false on failure or missing token.
   */
  async verify(token: string | null): Promise<boolean> {
    if (this.disposed || this.isSubmitting || this.terminal) return false;

    const trimmed = token?.trim() ?? '';
    if (!trimmed) {
      this.terminal = true;
      this.callbacks.onError(
        this.i18n.t('emailVerification.needsLink'),
        'needsLink',
      );
      this.callbacks.onSuccess(null);
      this.callbacks.onRetryable(false);
      return false;
    }

    const generation = ++this.requestGeneration;
    const pendingGen = this.beginPending();
    this.callbacks.onError(null, null);
    this.callbacks.onSuccess(null);
    this.callbacks.onRetryable(false);

    try {
      await this.client.auth.verifyEmail({ token: trimmed });
      if (!this.isCurrent(generation)) return false;

      this.callbacks.onSuccess(
        this.i18n.t('emailVerification.verified'),
      );
      this.callbacks.onRetryable(false);
      this.terminal = true;
      return true;
    } catch (err) {
      if (this.isCurrent(generation)) {
        if (err instanceof UnauthorizedError) {
          this.callbacks.onError(
            this.i18n.t('emailVerification.linkInvalid'),
            'linkInvalid',
          );
          this.callbacks.onRetryable(false);
          this.terminal = true;
        } else {
          this.callbacks.onError(
            this.i18n.t('emailVerification.couldNotVerify'),
            'couldNotVerify',
          );
          this.callbacks.onRetryable(true);
        }
      }
      return false;
    } finally {
      this.endPending(pendingGen);
    }
  }

  /** Permanently dispose the controller. */
  dispose(): void {
    this.disposed = true;
  }

  private isCurrent(generation: number): boolean {
    return !this.disposed && generation === this.requestGeneration;
  }

  private beginPending(): number {
    this.isSubmitting = true;
    const gen = ++this.pendingGeneration;
    this.callbacks.onPending(true);
    return gen;
  }

  private endPending(gen: number): void {
    this.isSubmitting = false;
    if (!this.disposed && gen === this.pendingGeneration) {
      this.callbacks.onPending(false);
    }
  }
}
