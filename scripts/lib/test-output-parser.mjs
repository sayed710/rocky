/**
 * @file Reusable parsing helpers for test runner output metrics, directives, and plans.
 * Supports TAP and Node.js spec reporter formats, strictly enforcing zero-skip,
 * zero-todo, and zero-cancelled test quality gates.
 */

/**
 * Line-anchored regex matching individual TAP or spec skip directives.
 * TAP: "ok 1 - test # SKIP [reason]", "ok - test # SKIP [reason]", or "not ok ... # SKIP"
 * Spec: "- test # SKIP [reason]" or "- test (skipped)"
 * Ensures escaped hashes (`\#`) in descriptions are not misinterpreted as directives.
 */
export const TAP_OR_SPEC_SKIP_DIRECTIVE_REGEX =
  /^\s*(?:(?:ok|not ok)(?:\s+\d+)?\b[^\r\n]*?(?<!\\)#\s*SKIP(?:PED)?\b|[\ufe63\-]\s+[^\r\n]*?(?<!\\)#\s*SKIP(?:PED)?\b|[\ufe63\-]\s+[^\r\n]*\((?:skipped|skip)\b[^)]*\))/im;

/**
 * Line-anchored regex matching individual TAP or spec TODO directives.
 * TAP: "ok 1 - test # TODO [reason]", "ok - test # TODO [reason]", or "not ok ... # TODO"
 * Spec: "- test # TODO [reason]" or "- test (todo)"
 * Ensures escaped hashes (`\#`) in descriptions are not misinterpreted as directives.
 */
export const TAP_OR_SPEC_TODO_DIRECTIVE_REGEX =
  /^\s*(?:(?:ok|not ok)(?:\s+\d+)?\b[^\r\n]*?(?<!\\)#\s*TO-?DO\b|[\ufe63\-]\s+[^\r\n]*?(?<!\\)#\s*TO-?DO\b|[\ufe63\-]\s+[^\r\n]*\((?:to-?do)\b[^)]*\))/im;

/**
 * Line-anchored regex matching raw TAP failure test points ("not ok") that do NOT
 * represent TODO or SKIP directives.
 */
export const RAW_TAP_FAILURE_REGEX =
  /^\s*not ok(?:\s+\d+)?\b(?:(?!(?<!\\)#\s*(?:TO-?DO|SKIP(?:PED)?)\b).)*$/im;

/**
 * Resolves the total tests count from reporter summary lines or TAP plan headers.
 * If ANY recognized summary line or TAP plan line reports 0 executed tests, returns 0
 * to signal an invalid zero-test run immediately.
 *
 * @param {string} output - Combined stdout/stderr text output.
 * @returns {number|null} Total test count, 0 if any suite executed 0 tests, or null if not detected.
 */
export function parseTestCount(output) {
  const summaryMatches = [...output.matchAll(/^\s*(?:#|ℹ)\s+tests:?\s+(\d+)\b/gim)];
  const planMatches = [...output.matchAll(/^\s*1\.\.(\d+)\b/gm)];

  for (const match of summaryMatches) {
    if (Number.parseInt(match[1], 10) === 0) return 0;
  }
  for (const match of planMatches) {
    if (Number.parseInt(match[1], 10) === 0) return 0;
  }

  if (summaryMatches.length > 0) {
    return summaryMatches.reduce((sum, m) => sum + Number.parseInt(m[1], 10), 0);
  }
  if (planMatches.length > 0) {
    return planMatches.reduce((sum, m) => sum + Number.parseInt(m[1], 10), 0);
  }
  return null;
}

/**
 * Resolves the passing test count from reporter summary lines.
 *
 * @param {string} output - Combined stdout/stderr text output.
 * @returns {number|null} Aggregated passing count, or null if no pass summary lines exist.
 */
export function parsePassCount(output) {
  const matches = [...output.matchAll(/^\s*(?:#|ℹ)\s+pass(?:ed)?:?\s+(\d+)\b/gim)];
  if (matches.length === 0) return null;
  return matches.reduce((sum, m) => sum + Number.parseInt(m[1], 10), 0);
}

/**
 * Resolves the failure test count from reporter summary lines and raw TAP "not ok" records.
 *
 * @param {string} output - Combined stdout/stderr text output.
 * @returns {number} Aggregated failure count across summaries and raw TAP records.
 */
export function parseFailCount(output) {
  let count = 0;
  const matches = [...output.matchAll(/^\s*(?:#|ℹ)\s+fail(?:ed)?:?\s+(\d+)\b/gim)];
  for (const match of matches) {
    count += Number.parseInt(match[1], 10);
  }
  if (RAW_TAP_FAILURE_REGEX.test(output) && count === 0) {
    count = 1;
  }
  return count;
}

/**
 * Resolves the skipped test count from reporter summary lines and individual test skip directives.
 * Independently detects record-level # SKIP directives even if summary reports 0.
 *
 * @param {string} output - Combined stdout/stderr text output.
 * @returns {number} Aggregated skipped count across summaries and directives.
 */
export function parseSkippedCount(output) {
  let count = 0;
  const matches = [...output.matchAll(/^\s*(?:#|ℹ)\s+skipped:?\s+(\d+)\b/gim)];
  for (const match of matches) {
    count += Number.parseInt(match[1], 10);
  }
  if (TAP_OR_SPEC_SKIP_DIRECTIVE_REGEX.test(output) && count === 0) {
    count = 1;
  }
  return count;
}

/**
 * Resolves the TODO test count from reporter summary lines and individual test TODO directives.
 * Independently detects record-level # TODO directives even if summary reports 0.
 *
 * @param {string} output - Combined stdout/stderr text output.
 * @returns {number} Aggregated TODO count across summaries and directives.
 */
export function parseTodoCount(output) {
  let count = 0;
  const matches = [...output.matchAll(/^\s*(?:#|ℹ)\s+todo:?\s+(\d+)\b/gim)];
  for (const match of matches) {
    count += Number.parseInt(match[1], 10);
  }
  if (TAP_OR_SPEC_TODO_DIRECTIVE_REGEX.test(output) && count === 0) {
    count = 1;
  }
  return count;
}

/**
 * Resolves the cancelled test count from reporter summary lines and spec cancelled format.
 *
 * @param {string} output - Combined stdout/stderr text output.
 * @returns {number} Aggregated cancelled count.
 */
export function parseCancelledCount(output) {
  let count = 0;
  const matches = [...output.matchAll(/^\s*(?:#|ℹ)\s+cancelled:?\s+(\d+)\b/gim)];
  for (const match of matches) {
    count += Number.parseInt(match[1], 10);
  }
  const specCancelledRegex = /^\s*[\ufe63\-]\s+[^\r\n]*\((?:cancelled)\)/im;
  if (specCancelledRegex.test(output) && count === 0) {
    count = 1;
  }
  return count;
}
