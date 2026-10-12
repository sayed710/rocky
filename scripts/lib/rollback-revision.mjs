/**
 * Which revision an automatic post-deploy rollback may target, decided from the pre-upgrade
 * `helm history <release> -o json` snapshot.
 *
 * deploy.yml rolls back with `helm rollback gambit <rev>` when the post-deploy smoke check fails
 * after a successful `helm upgrade --atomic`. Helm (v3.16.3) makes that dangerous to get wrong:
 *
 * - `helm rollback` copies the target revision's chart and values with no status check, so rolling
 *   back to a `failed` revision re-applies the configuration that already failed.
 * - A failed non-atomic upgrade leaves `N:deployed, N+1:failed`, and a later upgrade over that
 *   succeeds, so the newest revision before an upgrade is not necessarily a healthy one.
 * - After the upgrade the old `deployed` revision becomes `superseded`, so the decision can only be
 *   made from the history as it was BEFORE the upgrade.
 *
 * The only target this accepts is therefore the last configuration Helm recorded as successful: the
 * single `deployed` revision of a history that is entirely well formed, with nothing above it but
 * `failed` revisions and no `pending-*` revision anywhere (an operation that never finished). While a
 * `deployed` revision exists, a `failed` one is not Helm's recorded current release (Helm's
 * prepareUpgrade upgrades from the deployed revision when one exists; only when none exists does it
 * upgrade from the latest revision, which may then be `failed` or `superseded` — a history this
 * refuses, as it has no `deployed` revision). A `failed` revision's stored chart and values are the
 * configuration that failed, so it is never a safe target. This says nothing about the live cluster: a failed non-atomic upgrade can leave Kubernetes
 * resources partially applied. Anything else is refused, and the caller must leave the rollback to an
 * operator.
 */

/** Every release status Helm v3 defines (pkg/release/status.go). */
export const HELM_STATUSES = new Set([
  'unknown',
  'deployed',
  'uninstalled',
  'superseded',
  'failed',
  'uninstalling',
  'pending-install',
  'pending-upgrade',
  'pending-rollback',
]);

/**
 * The `helm history --max` window the workflow asks for. cmd/helm/history.go (v3.16.3) getHistory
 * sorts the release's records newest first and keeps only the first `--max` (default 256; `--max 0`
 * keeps none), so a history of this many entries may be missing older records — a `pending-*` or a
 * second `deployed` revision — that would disqualify it. Such a history is refused.
 */
export const HISTORY_WINDOW = 256;

/**
 * Why a `helm history --max HISTORY_WINDOW` result cannot be proven complete, or null when it can.
 *
 * @param {unknown[]} history
 * @returns {string | null}
 */
export function saturatedHistoryReason(history) {
  return history.length >= HISTORY_WINDOW
    ? `helm history returned ${history.length} revisions, which fills the --max ${HISTORY_WINDOW} window: revisions older than the window cannot be checked, so the history cannot be proven complete. Review the release's records (kubectl get secrets -l owner=helm,name=<release>) and reduce the stored history below ${HISTORY_WINDOW} revisions (Helm prunes it to --history-max on upgrade) before re-running`
    : null;
}

const CANONICAL_REVISION = /^[1-9][0-9]*$/;

/** Raised when no revision can be proven safe to roll back to. */
export class RollbackRevisionError extends Error {
  constructor(message) {
    super(message);
    this.name = 'RollbackRevisionError';
  }
}

function fail(message) {
  throw new RollbackRevisionError(message);
}

/**
 * A positive safe integer: a JSON number, or a canonical digit string (no sign, no leading zero).
 *
 * @param {unknown} value
 * @returns {number | null}
 */
export function parseRevision(value) {
  if (typeof value === 'number') {
    return Number.isSafeInteger(value) && value > 0 ? value : null;
  }
  if (typeof value === 'string' && CANONICAL_REVISION.test(value)) {
    const n = Number(value);
    return Number.isSafeInteger(n) ? n : null;
  }
  return null;
}

function text(value) {
  return typeof value === 'string' ? value : '';
}

/**
 * Resolves the revision an automatic rollback may target.
 *
 * @param {unknown} history Parsed pre-upgrade `helm history <release> -o json` output.
 * @returns {{revision: number, status: 'deployed', chart: string, appVersion: string,
 *   description: string, updated: string, newestRevision: number}}
 *   The target, with the evidence that makes it traceable, and the newest revision in the history.
 * @throws {RollbackRevisionError} Naming the first reason no target can be proven safe.
 */
export function resolveRollbackRevision(history) {
  if (!Array.isArray(history)) {
    fail('helm history output is not a JSON array');
  }
  if (history.length === 0) {
    fail('helm history is empty; there is no deployed revision to roll back to');
  }
  const saturated = saturatedHistoryReason(history);
  if (saturated) {
    fail(saturated);
  }

  const entries = [];
  const seen = new Set();
  history.forEach((entry, index) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      fail(`helm history entry #${index} is not an object: ${JSON.stringify(entry)}`);
    }
    const revision = parseRevision(entry.revision);
    if (revision === null) {
      fail(`helm history entry #${index} has an invalid revision ${JSON.stringify(entry.revision)} (expected a positive safe integer without leading zeros)`);
    }
    if (typeof entry.status !== 'string' || !HELM_STATUSES.has(entry.status)) {
      fail(`helm history revision ${revision} has an unknown status ${JSON.stringify(entry.status)}`);
    }
    if (seen.has(revision)) {
      fail(`helm history has duplicate revision ${revision}`);
    }
    seen.add(revision);
    entries.push({ entry, revision, status: entry.status });
  });

  const pending = entries.filter((e) => e.status.startsWith('pending-'));
  if (pending.length > 0) {
    fail(`helm history has an unfinished operation: ${pending.map((e) => `revision ${e.revision} is ${e.status}`).join(', ')}`);
  }

  const deployed = entries.filter((e) => e.status === 'deployed');
  if (deployed.length === 0) {
    fail('helm history has no revision with status "deployed"');
  }
  if (deployed.length > 1) {
    fail(`helm history has ${deployed.length} revisions with status "deployed" (${deployed.map((e) => e.revision).join(', ')}); the serving revision is ambiguous`);
  }

  const [target] = deployed;
  const contradicting = entries.filter((e) => e.revision > target.revision && e.status !== 'failed');
  if (contradicting.length > 0) {
    fail(`helm history has ${contradicting.map((e) => `revision ${e.revision} (${e.status})`).join(', ')} above deployed revision ${target.revision}; only failed revisions may sit above it`);
  }

  return {
    revision: target.revision,
    status: 'deployed',
    chart: text(target.entry.chart),
    appVersion: text(target.entry.app_version),
    description: text(target.entry.description),
    updated: text(target.entry.updated),
    newestRevision: Math.max(...entries.map((e) => e.revision)),
  };
}

/** One line, no control characters: safe as a $GITHUB_OUTPUT value and in a log line. */
function singleLine(value) {
  return String(value).replace(/[\u0000-\u001f\u007f]+/g, ' ').trim();
}

/**
 * Formats a resolved target as `key=value` lines for $GITHUB_OUTPUT.
 *
 * @param {ReturnType<typeof resolveRollbackRevision>} target
 * @returns {string}
 */
export function formatRollbackOutput(target) {
  const evidence = `status ${target.status} in the pre-upgrade helm history (newest revision ${target.newestRevision}); ` +
    `chart ${target.chart || '<none>'}, app ${target.appVersion || '<none>'}, updated ${target.updated || '<none>'}, ` +
    `description "${target.description}"`;
  return [
    `rollback_revision=${target.revision}`,
    `rollback_newest_revision=${target.newestRevision}`,
    `rollback_evidence=${singleLine(evidence)}`,
  ].join('\n') + '\n';
}
