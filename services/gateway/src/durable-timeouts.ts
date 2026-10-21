/**
 * Validates a durable operation timeout in ms (integer from 100 to 120000).
 */
export function parseDurableTimeoutEnv(
  value: string | undefined,
  name: string,
  defaultValue = 5000,
): number {
  if (value === undefined || value === '') {
    return defaultValue;
  }
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 100 || parsed > 120_000) {
    throw new Error(`${name} must be an integer between 100 and 120000`);
  }
  return parsed;
}
