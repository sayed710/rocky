/**
 * What is running now, read from the live Helm release, so a progressive deploy can keep it running.
 *
 * deploy.yml runs `helm upgrade` without --reuse-values, so every value a run does not set is
 * recomputed from the chart defaults and the environment values file. For canary and blue/green
 * that is wrong: everything the run is NOT changing — the canary's stable track, blue/green's other
 * colour, and the gateway and trust-worker, which no strategy versions — would silently move to the
 * baseline tag in deploy/environments/*.values.yaml instead of staying on the version that is live.
 * These helpers read the tags of the deployed revision so the workflow can pin them explicitly.
 */

/** Docker's tag grammar. Anything else is refused, which also keeps the value safe on a command line. */
const TAG_PATTERN = /^[A-Za-z0-9_][A-Za-z0-9_.-]{0,127}$/;

const STRATEGIES = new Set(['rolling', 'blueGreen', 'canary']);
const COLORS = ['blue', 'green'];

/**
 * Returns the number of the revision Helm currently has deployed, from `helm history -o json`.
 *
 * The newest revision is not necessarily the deployed one (a failed or pending upgrade can sit on top
 * of it), and the deployed one is what is serving traffic, so that is the one whose tags are kept.
 *
 * @param {unknown} history Parsed `helm history <release> -o json` output.
 * @returns {number} The highest revision whose status is "deployed".
 * @throws {Error} When the history is not a list or no revision is deployed.
 */
export function findDeployedRevision(history) {
  if (!Array.isArray(history)) {
    throw new Error('helm history output is not a JSON array');
  }
  let deployed = null;
  for (const entry of history) {
    if (!entry || entry.status !== 'deployed') continue;
    const revision = typeof entry.revision === 'string' && /^[0-9]+$/.test(entry.revision)
      ? Number(entry.revision)
      : entry.revision;
    if (Number.isSafeInteger(revision) && revision > 0 && (deployed === null || revision > deployed)) {
      deployed = revision;
    }
  }
  if (deployed === null) {
    throw new Error('helm history has no revision with status "deployed"');
  }
  return deployed;
}

function requiredTag(values, component) {
  const tag = values?.images?.[component]?.tag;
  const text = typeof tag === 'string' ? tag : '';
  if (!TAG_PATTERN.test(text)) {
    throw new Error(`deployed images.${component}.tag is missing or not a valid image tag: ${JSON.stringify(tag)}`);
  }
  return text;
}

function optionalTag(value, path) {
  if (value === undefined || value === null || value === '') return '';
  if (typeof value !== 'string' || !TAG_PATTERN.test(value)) {
    throw new Error(`deployed ${path} is not a valid image tag: ${JSON.stringify(value)}`);
  }
  return value;
}

/**
 * Resolves the image tags the deployed release is running, from `helm get values --all -o json`.
 *
 * `api`/`web`/`gateway` are the deployed `images.<component>.tag` values: the chart's fallback, and
 * what the gateway, the trust worker, the search indexer and their wait-for-api init containers run.
 * `liveApi`/`liveWeb` are the tags of the variant that takes production traffic: the active colour
 * under blue/green, otherwise `images.<component>.tag` (rolling's only track, canary's stable track).
 * `blue`/`green` are the colours' own tags, and are empty unless the deployed strategy is blueGreen,
 * since the chart only renders colours under that strategy.
 *
 * @param {unknown} values Parsed computed values of the deployed revision.
 * @returns {{strategy: string, activeColor: string, api: string, web: string, gateway: string,
 *   liveApi: string, liveWeb: string, blue: string, green: string}}
 * @throws {Error} When the strategy is unknown or a tag is missing or malformed.
 */
export function resolveDeployedImageTags(values) {
  if (!values || typeof values !== 'object' || Array.isArray(values)) {
    throw new Error('helm values output is not a JSON object');
  }
  const strategy = values.rollout?.strategy ?? 'rolling';
  if (!STRATEGIES.has(strategy)) {
    throw new Error(`deployed rollout.strategy is not one of rolling, blueGreen, canary: ${JSON.stringify(strategy)}`);
  }
  const api = requiredTag(values, 'api');
  const web = requiredTag(values, 'web');
  const gateway = requiredTag(values, 'gateway');

  const tags = { strategy, activeColor: '', api, web, gateway, liveApi: api, liveWeb: web, blue: '', green: '' };
  if (strategy === 'blueGreen') {
    const activeColor = values.rollout?.blueGreen?.activeColor;
    if (!COLORS.includes(activeColor)) {
      throw new Error(`deployed rollout.blueGreen.activeColor is not blue or green: ${JSON.stringify(activeColor)}`);
    }
    for (const color of COLORS) {
      tags[color] = optionalTag(values.rollout?.blueGreen?.colors?.[color]?.tag, `rollout.blueGreen.colors.${color}.tag`);
    }
    tags.activeColor = activeColor;
    // The chart's own resolution (gambit.variants): a colour without a tag runs images.<component>.tag.
    tags.liveApi = tags[activeColor] || api;
    tags.liveWeb = tags[activeColor] || web;
  }
  return tags;
}

/**
 * Formats resolved tags as `key=value` lines for $GITHUB_OUTPUT.
 *
 * @param {ReturnType<typeof resolveDeployedImageTags>} tags
 * @returns {string}
 */
export function formatGithubOutput(tags) {
  return [
    `deployed_strategy=${tags.strategy}`,
    `deployed_active_color=${tags.activeColor}`,
    `deployed_api_tag=${tags.api}`,
    `deployed_web_tag=${tags.web}`,
    `deployed_gateway_tag=${tags.gateway}`,
    `deployed_live_api_tag=${tags.liveApi}`,
    `deployed_live_web_tag=${tags.liveWeb}`,
    `deployed_blue_tag=${tags.blue}`,
    `deployed_green_tag=${tags.green}`,
  ].join('\n') + '\n';
}
