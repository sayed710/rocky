import type { LogFields } from '../ports/logger';

/** Fixed categories and vetted codes only: exception messages/stacks can contain secrets. */
export function arenaFailureFields(error: unknown): LogFields {
  const message = error instanceof Error ? error.message : '';
  const rawCode = typeof error === 'object' && error !== null ? (error as { code?: unknown }).code : undefined;
  const network = new Set(['ETIMEDOUT', 'ECONNRESET', 'ECONNREFUSED', 'EPIPE', 'ENOTFOUND', 'EAI_AGAIN']);
  const errorCode = typeof rawCode === 'string' && (/^[0-9]{2}[0-9A-Z]{3}$/.test(rawCode) || network.has(rawCode)) ? rawCode : undefined;
  const repairRequired = message.startsWith('Invalid persisted Arena') || message.startsWith('Ambiguous ended legacy Arena launch');
  const errorCategory = errorCode ? 'database_or_network'
    : message.startsWith('Arena database time') ? 'database_time'
    : message.startsWith('Invalid persisted Arena') ? 'invalid_snapshot'
    : message.startsWith('Ambiguous ended legacy Arena launch') ? 'legacy_launch_repair'
    : 'unknown';
  return { errorCategory, repairRequired, ...(errorCode ? { errorCode } : {}) };
}
