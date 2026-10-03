import type { EngineErrorCode } from '@chess-platform/engine';

const engineCodes: Readonly<Record<EngineErrorCode, true>> = {
  invalid_fen: true, no_engine_for_variant: true, engine_crashed: true,
  engine_timeout: true, engine_version: true, protocol: true, queue_full: true,
  circuit_open: true, cancelled: true, shutting_down: true, not_initialized: true,
};
const knownCodes = new Set([
  ...Object.keys(engineCodes),
  '42P01', '42703', '57014', '55P03', '40001', '40P01',
  '23502', '23503', '23505', '23514',
  '08000', '08001', '08003', '08004', '08006', '08007', '08P01',
  '57P01', '57P02', '57P03', '53300',
  'ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT', 'EPIPE', 'ENOTFOUND',
]);

/** Closed, bounded diagnostic vocabulary; arbitrary exception fields may contain stored payloads. */
export function safeTrustFailureCode(error: unknown): string | null {
  try {
    if (typeof error !== 'object' || error === null) return null;
    const code: unknown = (error as { code?: unknown }).code;
    return typeof code === 'string' && knownCodes.has(code) ? code : null;
  } catch {
    return null;
  }
}
