import type { Speed, Variant } from '../api/models.js';
import type { I18n } from '../i18n/manager.js';
import type { MessageKey } from '../i18n/catalog/index.js';

/** Human labels for the contract's variant codes. */
export const VARIANT_LABELS: Record<Variant, string> = {
  standard: 'Standard',
  chess960: 'Chess960',
  kingofthehill: 'King of the Hill',
  atomic: 'Atomic',
  crazyhouse: 'Crazyhouse',
  threecheck: 'Three-check',
  horde: 'Horde',
  racingkings: 'Racing Kings',
};

/** Human labels for the contract's speed classes. */
export const SPEED_LABELS: Record<Speed, string> = {
  ultrabullet: 'UltraBullet',
  bullet: 'Bullet',
  blitz: 'Blitz',
  rapid: 'Rapid',
  classical: 'Classical',
  correspondence: 'Correspondence',
};

function isKnownVariant(variant: string): variant is Variant {
  return Object.prototype.hasOwnProperty.call(VARIANT_LABELS, variant);
}

function isKnownSpeed(speed: string): speed is Speed {
  return Object.prototype.hasOwnProperty.call(SPEED_LABELS, speed);
}

/**
 * Returns the localized human-readable label for a chess variant.
 */
export function getVariantLabel(variant: Variant | string, i18n: I18n): string {
  if (isKnownVariant(variant)) {
    const key = `variant.${variant}` as MessageKey;
    return i18n.t(key);
  }
  return variant;
}

/**
 * Returns the localized human-readable label for a chess time-control speed class.
 */
export function getSpeedLabel(speed: Speed | string, i18n: I18n): string {
  if (isKnownSpeed(speed)) {
    const key = `speed.${speed}` as MessageKey;
    return i18n.t(key);
  }
  return speed;
}
