import type { Speed, Variant } from '../api/models.js';

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
