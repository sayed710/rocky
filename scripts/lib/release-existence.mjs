/**
 * Whether a Helm release existed before a deploy, decided only from positive evidence, and whether
 * a release is still exactly the one revision an initial install created.
 *
 * deploy.yml's post-deploy rollback UNINSTALLS the release when it believes this run installed it.
 * Treating every `helm status` failure as "no release" therefore turns a cluster outage, an expired
 * credential or an RBAC change into `helm uninstall` of a live production release. Existence is
 * tri-state instead:
 *
 * - `exists`  — `helm status <release>` exited 0.
 * - `absent`  — `helm status <release>` failed with exactly Helm's not-found error as its whole
 *               (trimmed) stderr, AND `helm list --all --filter '^<release>$' -o json` succeeded with
 *               a JSON array of release objects none of which is named <release>.
 * - `unknown` — anything else. The caller must refuse to deploy and change nothing.
 *
 * Helm v3.16.3 facts relied on:
 * - pkg/storage/driver/driver.go: `ErrReleaseNotFound = errors.New("release: not found")`; the
 *   Secrets/ConfigMaps drivers' Query returns it when no record carries the release name, and a
 *   failing Kubernetes call is wrapped differently ("query: failed to query with labels: ...").
 *   `helm status` reaches it via pkg/action/status.go -> releaseContent -> Storage.Last -> History.
 *   An unreachable cluster fails earlier, in KubeClient.IsReachable ("Kubernetes cluster
 *   unreachable: ...").
 * - cmd/helm/root.go does not set cobra's SilenceErrors, so cobra (v1.8.1) prints the error as
 *   "Error: release: not found" on stderr and cmd/helm/helm.go exits 1.
 * - cmd/helm/list.go + pkg/action/list.go: `--all` sets StateMask = ListAll = deployed | uninstalled
 *   | uninstalling | pending-install | pending-upgrade | pending-rollback | superseded | failed, so
 *   no additional status flag is needed. Only a release whose latest record has status `unknown` is
 *   not listed; `helm status` (which reads every record regardless of status) would not report such
 *   a release as not found, so it can never be classified `absent`. `-o json` of an empty result is
 *   `[]` (newReleaseListWriter initialises the slice).
 */

/** Helm's not-found error exactly as the CLI prints it (see above). */
export const HELM_RELEASE_NOT_FOUND = 'Error: release: not found';

/**
 * @param {string} value
 * @returns {string}
 */
function oneLine(value, max = 300) {
  const flat = String(value).replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max)}...` : flat;
}

/**
 * Classifies release existence.
 *
 * @param {object} evidence
 * @param {string} evidence.release Release name.
 * @param {number} evidence.statusExitCode Exit code of `helm status <release>`.
 * @param {string} evidence.statusStderr Its stderr.
 * @param {number | null} [evidence.listExitCode] Exit code of `helm list --all --filter
 *   '^<release>$' -o json`; null/undefined when it was not run.
 * @param {string | null} [evidence.listStdout] Its stdout.
 * @returns {{state: 'exists' | 'absent' | 'unknown', reason: string}}
 */
export function classifyReleaseExistence({ release, statusExitCode, statusStderr, listExitCode = null, listStdout = null }) {
  const unknown = (reason) => ({ state: 'unknown', reason });
  if (typeof release !== 'string' || !/^[a-z0-9]([-a-z0-9]*[a-z0-9])?$/.test(release)) {
    return unknown(`invalid release name ${JSON.stringify(release)}`);
  }
  if (!Number.isInteger(statusExitCode) || statusExitCode < 0) {
    return unknown(`'helm status ${release}' exit code ${JSON.stringify(statusExitCode)} is not a valid exit code`);
  }
  if (statusExitCode === 0) {
    return { state: 'exists', reason: `'helm status ${release}' succeeded` };
  }
  const stderr = typeof statusStderr === 'string' ? statusStderr.trim() : '';
  if (stderr !== HELM_RELEASE_NOT_FOUND) {
    // The caller prints the stderr itself; the reason only says why it is not proof of absence.
    return unknown(stderr === ''
      ? `'helm status ${release}' failed with no error message`
      : `'helm status ${release}' failed with an error other than Helm's not-found error ("${HELM_RELEASE_NOT_FOUND}" as its whole stderr)`);
  }
  if (listExitCode === null || listExitCode === undefined) {
    return unknown(`'helm status ${release}' reported not found, but 'helm list --all' was not run to corroborate it`);
  }
  if (!Number.isInteger(listExitCode) || listExitCode !== 0) {
    return unknown(`'helm status ${release}' reported not found, but 'helm list --all' failed (exit ${listExitCode})`);
  }
  let list;
  try {
    list = JSON.parse(typeof listStdout === 'string' ? listStdout : '');
  } catch {
    return unknown(`'helm status ${release}' reported not found, but 'helm list --all' output is not JSON: ${oneLine(listStdout ?? '') || '<empty>'}`);
  }
  if (!Array.isArray(list)) {
    return unknown(`'helm status ${release}' reported not found, but 'helm list --all' output is not a JSON array`);
  }
  for (const [index, entry] of list.entries()) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry) || typeof entry.name !== 'string') {
      return unknown(`'helm status ${release}' reported not found, but 'helm list --all' entry #${index} is not a release object with a name: ${oneLine(JSON.stringify(entry))}`);
    }
    if (entry.name === release) {
      return unknown(`'helm status ${release}' reported not found, but 'helm list --all' lists release ${release} (status ${oneLine(JSON.stringify(entry.status))}); the evidence contradicts itself`);
    }
    if (entry.name.trim().toLowerCase() === release) {
      return unknown(`'helm status ${release}' reported not found, but 'helm list --all' lists a release named ${JSON.stringify(entry.name)}, which is ambiguous`);
    }
  }
  return {
    state: 'absent',
    reason: `'helm status ${release}' reported "${HELM_RELEASE_NOT_FOUND}" and 'helm list --all' lists no release named ${release}`,
  };
}

/**
 * Whether a fresh `helm history <release> -o json` shows exactly one revision, revision 1: the
 * only state in which uninstalling is known to remove nothing but the release this run installed.
 *
 * @param {unknown} history Parsed `helm history -o json`.
 * @returns {{ok: true} | {ok: false, reason: string}}
 */
export function checkOnlyInitialRevision(history) {
  if (!Array.isArray(history)) {
    return { ok: false, reason: 'helm history output is not a JSON array' };
  }
  if (history.length !== 1) {
    return { ok: false, reason: `helm history has ${history.length} revisions; only a release whose sole revision is 1 was created by this run` };
  }
  const [entry] = history;
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
    return { ok: false, reason: `helm history entry is not an object: ${oneLine(JSON.stringify(entry))}` };
  }
  if (entry.revision !== 1 && entry.revision !== '1') {
    return { ok: false, reason: `the only helm history revision is ${oneLine(JSON.stringify(entry.revision))}, not 1` };
  }
  return { ok: true };
}
