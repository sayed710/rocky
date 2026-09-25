import { createHash } from 'node:crypto';
import type { EmailDeliveryOutcome, EmailDeliveryResult, EmailSender } from '../ports/email.js';
import type { Metrics } from '../ports/metrics.js';
import { NullMetrics } from '../ports/metrics.js';
import { EMAIL_ADDRESS_PATTERN } from './address.js';
import { buildEmailContent, type EmailPurpose } from './content.js';

const RESEND_EMAIL_ENDPOINT = 'https://api.resend.com/emails';
const DELIVERY_LATENCY_BUCKETS = [0.1, 0.25, 0.5, 1, 2, 5, 10, 30] as const;

export interface ResendEmailSenderOptions {
  readonly apiKey: string;
  readonly from: string;
  readonly publicWebOrigin: string;
  readonly timeoutMs: number;
  readonly fetch?: typeof fetch;
  readonly metrics?: Metrics;
}

function outcomeForStatus(status: number): EmailDeliveryOutcome {
  if (status === 429) return 'provider_throttled';
  if (status >= 400 && status < 500) return 'provider_rejected';
  return 'provider_error';
}

function hasMessageId(value: unknown): boolean {
  return value !== null
    && typeof value === 'object'
    && typeof (value as { id?: unknown }).id === 'string'
    && (value as { id: string }).id.length > 0;
}

export class ResendEmailSender implements EmailSender {
  private readonly fetch: typeof fetch;
  private readonly metrics: Metrics;

  constructor(private readonly options: ResendEmailSenderOptions) {
    this.fetch = options.fetch ?? fetch;
    this.metrics = options.metrics ?? new NullMetrics();
  }

  sendPasswordReset(to: string, token: string): Promise<EmailDeliveryResult> {
    return this.send('password_reset', to, token);
  }

  sendEmailVerification(to: string, token: string): Promise<EmailDeliveryResult> {
    return this.send('email_verify', to, token);
  }

  sendLoginCode(to: string, code: string): Promise<EmailDeliveryResult> {
    return this.send('login_step_up', to, code);
  }

  private async send(purpose: EmailPurpose, to: string, token: string): Promise<EmailDeliveryResult> {
    const startedAt = Date.now();
    if (!EMAIL_ADDRESS_PATTERN.test(to)) return this.finish(purpose, 'provider_rejected', startedAt);

    const content = buildEmailContent(purpose, this.options.publicWebOrigin, token);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.options.timeoutMs);
    try {
      const response = await this.fetch(RESEND_EMAIL_ENDPOINT, {
        method: 'POST',
        redirect: 'error',
        signal: controller.signal,
        headers: {
          Authorization: `Bearer ${this.options.apiKey}`,
          'Content-Type': 'application/json',
          'Idempotency-Key': this.idempotencyKey(purpose, to, token),
          'User-Agent': 'shatarang-api/0.1',
        },
        body: JSON.stringify({
          from: this.options.from,
          to: [to],
          subject: content.subject,
          text: content.text,
          html: content.html,
          tags: [{ name: 'purpose', value: purpose }],
        }),
      });
      if (!response.ok) {
        try {
          await response.body?.cancel();
        } catch {
          // Preserve the bounded provider outcome even if the runtime cannot discard the body.
        }
        return this.finish(purpose, outcomeForStatus(response.status), startedAt);
      }

      let payload: unknown;
      try {
        payload = await response.json();
      } catch {
        return this.finish(purpose, 'provider_error', startedAt);
      }
      return this.finish(purpose, hasMessageId(payload) ? 'success' : 'provider_error', startedAt);
    } catch {
      return this.finish(purpose, controller.signal.aborted ? 'timeout' : 'provider_error', startedAt);
    } finally {
      clearTimeout(timer);
    }
  }

  private idempotencyKey(purpose: EmailPurpose, to: string, token: string): string {
    const digest = createHash('sha256').update(`${purpose}\0${to}\0${token}`).digest('hex');
    return `shatarang/${purpose}/${digest}`;
  }

  private finish(
    purpose: EmailPurpose,
    outcome: EmailDeliveryOutcome,
    startedAt: number,
  ): EmailDeliveryResult {
    const labels = { outcome, purpose };
    this.metrics.counter('email_delivery_total', labels).inc();
    this.metrics
      .histogram('email_delivery_duration_seconds', DELIVERY_LATENCY_BUCKETS, labels)
      .observe((Date.now() - startedAt) / 1000);
    return { outcome };
  }
}
