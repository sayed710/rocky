/**
 * Source repository identity and build revision for source disclosure (ADR-0153).
 *
 * Trust boundary:
 * - The repository URL is a source-controlled constant, not a build input. Nothing at build or run
 *   time can point the disclosure link elsewhere; a fork that publishes its own source changes this
 *   constant in that source.
 * - The build revision is the only injected value. `vite.config.ts` reads `VITE_GIT_SHA` once, at
 *   build time, through {@link resolveBuildRevision} — which fails the build on a malformed value —
 *   and embeds the validated result as the compile-time constant `__ROOKZEN_SOURCE_REVISION__`.
 * - Nothing here fetches anything: no runtime network request, no secret, no external service.
 *
 * A missing revision is reported as unavailable. It is never guessed, abbreviated or derived.
 */

/** Substituted by Vite `define` at build time; absent (so `typeof` is 'undefined') everywhere else. */
declare const __ROOKZEN_SOURCE_REVISION__: string | null;

export interface SourceRepository {
  /** `owner/name` on the host, for display and tests. */
  readonly slug: string;
  /** Canonical public HTTPS URL of the repository. */
  readonly url: string;
}

export interface SourceRevision {
  /** Full, lowercase Git object name of the commit this build was made from. */
  readonly sha: string;
  /** HTTPS URL of that exact commit in {@link SOURCE_REPOSITORY}. */
  readonly commitUrl: string;
}

export interface SourceMetadata {
  readonly repository: SourceRepository;
  /** `null` when the build did not record a valid revision. */
  readonly revision: SourceRevision | null;
}

export const SOURCE_REPOSITORY: SourceRepository = Object.freeze({
  slug: 'sayed710/rocky',
  url: 'https://github.com/sayed710/rocky',
});

/** The build-time variable that carries the commit SHA into `vite build`. */
export const BUILD_REVISION_ENV = 'VITE_GIT_SHA';

// Full SHA-1 (40) or SHA-256 (64) object names only. An abbreviated name is not an exact identity.
const FULL_OBJECT_NAME = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i;
// Git's null object name stands for "no commit"; treating it as a revision would be a fake one.
const NULL_OBJECT_NAME = /^0+$/;

/** A validated, lowercase full commit SHA, or `null` for anything else. Never throws. */
export function parseRevision(raw: unknown): string | null {
  if (typeof raw !== 'string' || !FULL_OBJECT_NAME.test(raw) || NULL_OBJECT_NAME.test(raw)) {
    return null;
  }
  return raw.toLowerCase();
}

/**
 * Build-time resolution of {@link BUILD_REVISION_ENV}.
 *
 * Unset or empty → `null` (local and unpinned builds: the revision is unavailable, not invented).
 * Present but malformed → throws, so a pipeline that meant to stamp a revision cannot silently ship
 * a build that claims none or the wrong one.
 */
export function resolveBuildRevision(env: Readonly<Record<string, string | undefined>>): string | null {
  const raw = env[BUILD_REVISION_ENV];
  if (raw === undefined || raw === '') return null;
  const revision = parseRevision(raw);
  if (revision === null) {
    throw new Error(
      `${BUILD_REVISION_ENV} must be a full 40- or 64-character hexadecimal Git commit SHA, or unset. ` +
        `Received ${JSON.stringify(raw.slice(0, 80))}.`,
    );
  }
  return revision;
}

/** Combine the canonical repository with a revision, validating the revision again. */
export function createSourceMetadata(rawRevision: unknown): SourceMetadata {
  const sha = parseRevision(rawRevision);
  // `sha` is hex-only, so appending it cannot change the URL's origin or escape the path.
  const revision = sha === null
    ? null
    : Object.freeze({ sha, commitUrl: `${SOURCE_REPOSITORY.url}/commit/${sha}` });
  return Object.freeze({ repository: SOURCE_REPOSITORY, revision });
}

/** Metadata for the running bundle, from the compile-time constant when Vite supplied one. */
export function readBuildSourceMetadata(): SourceMetadata {
  return createSourceMetadata(
    typeof __ROOKZEN_SOURCE_REVISION__ === 'undefined' ? null : __ROOKZEN_SOURCE_REVISION__,
  );
}
