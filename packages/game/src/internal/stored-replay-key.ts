/**
 * Key of {@link Game}'s stored-history fold. Deliberately absent from `index.ts` and from the package
 * `exports` map, so `stored-history.ts` is the only module that reaches it (#127). This is containment
 * inside the repository, not a security boundary: any first-party code could still import this file.
 */
export const FOLD_STORED: unique symbol = Symbol('Game.foldStored');
