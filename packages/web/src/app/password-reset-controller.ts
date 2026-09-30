/**
 * PasswordReset controller — a pure, DOM-free orchestrator that manages the
 * password recovery request and reset ceremonies.
 *
 * Like {@link AuthController} and {@link PasskeysController}, it never touches the DOM;
 * the bootstrap layer wires callbacks to DOM elements.
 */
import type { GambitClient } from '../api/client.js';
import type { I18nManager } from '../i18n/manager.js';
import { UnauthorizedError } from '../net/errors.js';

export interface PasswordResetCallbacks {
  /** Called when an operation is in-flight (for UI spinner / disabled / aria-busy state). */
  onPending: (pending: boolean) => void;
  /** Called when an error occurs (for UI error display). */
  onError: (message: string | null) => void;
  /** Called when a success status message should be displayed. */
  onSuccess: (message: string | null) => void;
  /** Called after a password reset confirm succeeds to clear local session state. */
  onSessionInvalidated?: () => void;
}

export interface PasswordResetControllerOptions {
  readonly client: GambitClient;
  readonly callbacks: PasswordResetCallbacks;
  readonly i18n?: I18nManager | undefined;
}

export class PasswordResetController {
  private readonly client: GambitClient;
  private readonly callbacks: PasswordResetCallbacks;
  private readonly i18n?: I18nManager | undefined;
  private requestGeneration = 0;
  private pendingGeneration = 0;
  private isSubmitting = false;
  private disposed = false;

  constructor(opts: PasswordResetControllerOptions) {
    this.client = opts.client;
    this.callbacks = opts.callbacks;
    this.i18n = opts.i18n;
  }

  /**
   * Request a password reset link for a handle or email.
   * Returns true on successful request dispatch, false otherwise.
   */
  async requestReset(handleOrEmail: string): Promise<boolean> {
    if (this.disposed || this.isSubmitting) return false;

    const trimmed = handleOrEmail.trim();
    if (!trimmed) {
      this.callbacks.onError(
        this.i18n ? this.i18n.t('passwordRecovery.enterHandleOrEmail') : 'Please enter your handle or email address.',
      );
      this.callbacks.onSuccess(null);
      return false;
    }

    const generation = ++this.requestGeneration;
    const pendingGen = this.beginPending();
    this.callbacks.onError(null);
    this.callbacks.onSuccess(null);

    try {
      await this.client.auth.requestPasswordReset({ handleOrEmail: trimmed });
      if (!this.isCurrent(generation)) return false;

      this.callbacks.onSuccess(
        this.i18n
          ? this.i18n.t('passwordRecovery.sentInstructions')
          : 'If an account matching that handle or email address exists, we have sent instructions to reset your password.',
      );
      return true;
    } catch (err) {
      if (this.isCurrent(generation)) {
        this.callbacks.onError(err instanceof Error ? err.message : String(err));
      }
      return false;
    } finally {
      this.endPending(pendingGen);
    }
  }

  /**
   * Confirm a password reset using a single-use token and a new password.
   * Enforces 8..1024 characters length and matching confirmation client-side.
   */
  async confirmReset(token: string, newPassword: string, confirmPassword: string): Promise<boolean> {
    if (this.disposed || this.isSubmitting) return false;

    if (!token) {
      this.callbacks.onError(
        this.i18n ? this.i18n.t('passwordRecovery.linkInvalid') : 'This password reset link is invalid or has expired.',
      );
      this.callbacks.onSuccess(null);
      return false;
    }

    if (newPassword.length < 8 || newPassword.length > 1024) {
      this.callbacks.onError(
        this.i18n ? this.i18n.t('passwordRecovery.passwordLength') : 'Password must be between 8 and 1024 characters.',
      );
      this.callbacks.onSuccess(null);
      return false;
    }

    if (newPassword !== confirmPassword) {
      this.callbacks.onError(
        this.i18n ? this.i18n.t('passwordRecovery.passwordsDoNotMatch') : 'Passwords do not match.',
      );
      this.callbacks.onSuccess(null);
      return false;
    }

    const generation = ++this.requestGeneration;
    const pendingGen = this.beginPending();
    this.callbacks.onError(null);
    this.callbacks.onSuccess(null);

    try {
      await this.client.auth.confirmPasswordReset({ token, newPassword });
      if (!this.isCurrent(generation)) return false;

      this.callbacks.onSuccess(
        this.i18n ? this.i18n.t('passwordRecovery.resetSuccess') : 'Your password has been reset successfully.',
      );
      this.callbacks.onSessionInvalidated?.();
      return true;
    } catch (err) {
      if (this.isCurrent(generation)) {
        if (err instanceof UnauthorizedError) {
          this.callbacks.onError(
            this.i18n ? this.i18n.t('passwordRecovery.linkInvalid') : 'This password reset link is invalid or has expired.',
          );
        } else {
          this.callbacks.onError(err instanceof Error ? err.message : String(err));
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
