/**
 * @file Reusable parsing helpers for test runner output metrics, directives, and plans.
 * Supports TAP and Node.js spec reporter formats, strictly enforcing zero-skip,
 * zero-todo, and zero-cancelled test quality gates.
 */
import { StringDecoder } from 'node:string_decoder';


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

/**
 * Creates a stateful streaming test runner output parser that maintains strictly O(1)
 * bounded memory by updating scalar counters and flags line-by-line as chunks arrive.
 * Eliminates transcript accumulation while guaranteeing exact parity with static summary
 * and directive quality gates (zero skip, zero todo, zero cancelled, zero unhandled failures).
 *
 * @returns {{
 *   pushLine: (line: string) => void,
 *   getResults: () => {
 *     totalTests: number | null,
 *     passCount: number | null,
 *     failCount: number,
 *     skippedCount: number,
 *     todoCount: number,
 *     cancelledCount: number
 *   }
 * }}
 */
export function createStreamingTestParser() {
  let summaryTests = 0;
  let summaryTestsCount = 0;
  let planTests = 0;
  let planTestsCount = 0;
  let hasZeroTestSummary = false;

  let summaryPass = 0;
  let summaryPassCount = 0;

  let summarySkipped = 0;
  let hasSkipDirective = false;

  let summaryTodo = 0;
  let hasTodoDirective = false;

  let summaryCancelled = 0;
  let hasCancelledDirective = false;

  let summaryFail = 0;
  let hasRawFailure = false;

  return {
    pushLine(line) {
      // 1. Tests summary: # tests N or ℹ tests N
      const testMatch = line.match(/^\s*(?:#|ℹ)\s+tests:?\s+(\d+)\b/i);
      if (testMatch) {
        const val = Number.parseInt(testMatch[1], 10);
        if (val === 0) hasZeroTestSummary = true;
        summaryTests += val;
        summaryTestsCount++;
      }

      // 2. TAP plan: 1..N
      const planMatch = line.match(/^\s*1\.\.(\d+)\b/);
      if (planMatch) {
        const val = Number.parseInt(planMatch[1], 10);
        if (val === 0) hasZeroTestSummary = true;
        planTests += val;
        planTestsCount++;
      }

      // 3. Pass summary: # pass N or ℹ pass N
      const passMatch = line.match(/^\s*(?:#|ℹ)\s+pass(?:ed)?:?\s+(\d+)\b/i);
      if (passMatch) {
        summaryPass += Number.parseInt(passMatch[1], 10);
        summaryPassCount++;
      }

      // 4. Skipped summary or directive: # skipped N or ℹ skipped N or TAP/spec skip
      const skipMatch = line.match(/^\s*(?:#|ℹ)\s+skipped:?\s+(\d+)\b/i);
      if (skipMatch) {
        summarySkipped += Number.parseInt(skipMatch[1], 10);
      } else if (TAP_OR_SPEC_SKIP_DIRECTIVE_REGEX.test(line)) {
        hasSkipDirective = true;
      }

      // 5. TODO summary or directive: # todo N or ℹ todo N or TAP/spec todo
      const todoMatch = line.match(/^\s*(?:#|ℹ)\s+todo:?\s+(\d+)\b/i);
      if (todoMatch) {
        summaryTodo += Number.parseInt(todoMatch[1], 10);
      } else if (TAP_OR_SPEC_TODO_DIRECTIVE_REGEX.test(line)) {
        hasTodoDirective = true;
      }

      // 6. Cancelled summary or directive: # cancelled N or spec (cancelled)
      const cancelledMatch = line.match(/^\s*(?:#|ℹ)\s+cancelled:?\s+(\d+)\b/i);
      if (cancelledMatch) {
        summaryCancelled += Number.parseInt(cancelledMatch[1], 10);
      } else if (/^\s*[\ufe63\-]\s+[^\r\n]*\((?:cancelled)\)/i.test(line)) {
        hasCancelledDirective = true;
      }

      // 7. Fail summary or raw TAP "not ok": # fail N or not ok
      const failMatch = line.match(/^\s*(?:#|ℹ)\s+fail(?:ed)?:?\s+(\d+)\b/i);
      if (failMatch) {
        summaryFail += Number.parseInt(failMatch[1], 10);
      } else if (RAW_TAP_FAILURE_REGEX.test(line)) {
        hasRawFailure = true;
      }
    },

    getResults() {
      let totalTests = null;
      if (hasZeroTestSummary) {
        totalTests = 0;
      } else if (summaryTestsCount > 0) {
        totalTests = summaryTests;
      } else if (planTestsCount > 0) {
        totalTests = planTests;
      }

      const passCount = summaryPassCount > 0 ? summaryPass : null;

      let skippedCount = summarySkipped;
      if (skippedCount === 0 && hasSkipDirective) skippedCount = 1;

      let todoCount = summaryTodo;
      if (todoCount === 0 && hasTodoDirective) todoCount = 1;

      let cancelledCount = summaryCancelled;
      if (cancelledCount === 0 && hasCancelledDirective) cancelledCount = 1;

      let failCount = summaryFail;
      if (failCount === 0 && hasRawFailure) failCount = 1;

      return {
        totalTests,
        passCount,
        failCount,
        skippedCount,
        todoCount,
        cancelledCount,
      };
    },
  };
}

/**
 * Wraps a parser or test receiver to process streaming binary or string chunks from stdout
 * and stderr independently.
 *
 * Maintains separate UTF-8 StringDecoder instances and line buffers for stdout and stderr,
 * preventing cross-stream line interleaving corruption and multibyte sequence splitting.
 *
 * @param {ReturnType<typeof createStreamingTestParser>} parser
 * @returns {{
 *   pushStdoutChunk: (chunk: Buffer|string) => void,
 *   pushStderrChunk: (chunk: Buffer|string) => void,
 *   flush: () => void,
 *   getResults: () => ReturnType<typeof parser.getResults>
 * }}
 */
export function createStreamLineProcessor(parser) {
  const stdoutDecoder = new StringDecoder('utf8');
  const stderrDecoder = new StringDecoder('utf8');
  let stdoutLineBuffer = '';
  let stderrLineBuffer = '';

  function processChunk(chunk, decoder, getBuffer, setBuffer) {
    const text = typeof chunk === 'string' ? chunk : decoder.write(chunk);
    const combined = getBuffer() + text;
    const lines = combined.split(/\r?\n/);
    setBuffer(lines.pop() ?? '');
    for (const line of lines) {
      parser.pushLine(line);
    }
  }

  function flushStream(decoder, getBuffer, setBuffer) {
    const finalStr = decoder.end();
    const combined = getBuffer() + finalStr;
    const lines = combined.split(/\r?\n/);
    setBuffer('');
    for (const line of lines) {
      if (line.length > 0) {
        parser.pushLine(line);
      }
    }
  }

  return {
    pushStdoutChunk(chunk) {
      processChunk(chunk, stdoutDecoder, () => stdoutLineBuffer, (v) => { stdoutLineBuffer = v; });
    },
    pushStderrChunk(chunk) {
      processChunk(chunk, stderrDecoder, () => stderrLineBuffer, (v) => { stderrLineBuffer = v; });
    },
    flush() {
      flushStream(stdoutDecoder, () => stdoutLineBuffer, (v) => { stdoutLineBuffer = v; });
      flushStream(stderrDecoder, () => stderrLineBuffer, (v) => { stderrLineBuffer = v; });
    },
    getResults() {
      this.flush();
      return parser.getResults();
    },
  };
}

