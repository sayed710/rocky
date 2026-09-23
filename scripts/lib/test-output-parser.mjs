/**
 * @file Reusable parsing helpers for test runner output metrics, directives, and plans.
 * Supports TAP and Node.js spec reporter formats, strictly enforcing zero-skip,
 * zero-todo, and zero-cancelled test quality gates.
 */
import { StringDecoder } from 'node:string_decoder';

const ANSI_ESCAPE_REGEX = /\x1b\[[0-?]*[ -/]*[@-~]/g;

/**
 * Removes terminal color/control sequences before matching line-anchored reporter records.
 *
 * @param {string} value - Raw reporter output.
 * @returns {string} Output without ANSI CSI escape sequences.
 */
export function stripAnsi(value) {
  return value.replace(ANSI_ESCAPE_REGEX, '');
}

/**
 * Line-anchored regex matching individual TAP or spec skip directives.
 * TAP: "ok 1 - test # SKIP [reason]", "ok - test # SKIP [reason]", or "not ok ... # SKIP"
 * Spec: "- test # SKIP [reason]" or "- test (skipped)"
 * Ensures escaped hashes (`\#`) in descriptions are not misinterpreted as directives.
 */
export const TAP_OR_SPEC_SKIP_DIRECTIVE_REGEX =
  /^[ \t]*(?:(?:ok|not ok)(?=[ \t]|$)[^\r\n]*?(?<!\\)#\s*SKIP(?:PED)?\b|[\ufe63\-]\s+[^\r\n]*?(?<!\\)#\s*SKIP(?:PED)?\b|[\ufe63\-]\s+[^\r\n]*\((?:skipped|skip)\b[^)]*\))/im;

/**
 * Line-anchored regex matching individual TAP or spec TODO directives.
 * TAP: "ok 1 - test # TODO [reason]", "ok - test # TODO [reason]", or "not ok ... # TODO"
 * Spec: "- test # TODO [reason]" or "- test (todo)"
 * Ensures escaped hashes (`\#`) in descriptions are not misinterpreted as directives.
 */
export const TAP_OR_SPEC_TODO_DIRECTIVE_REGEX =
  /^[ \t]*(?:(?:ok|not ok)(?=[ \t]|$)[^\r\n]*?(?<!\\)#\s*TO-?DO\b|[\ufe63\-]\s+[^\r\n]*?(?<!\\)#\s*TO-?DO\b|[\ufe63\-]\s+[^\r\n]*\((?:to-?do)\b[^)]*\))/im;

/**
 * Line-anchored regex matching raw TAP failure test points ("not ok") that do NOT
 * represent TODO or SKIP directives.
 */
export const RAW_TAP_FAILURE_REGEX =
  /^[ \t]*not ok(?=[ \t]|$)(?:(?!(?<!\\)#\s*(?:TO-?DO|SKIP(?:PED)?)\b).)*$/im;

/**
 * Resolves the total tests count from reporter summary lines or TAP plan headers.
 * If ANY recognized summary line or TAP plan line reports 0 executed tests, returns 0
 * to signal an invalid zero-test run immediately.
 *
 * @param {string} output - Combined stdout/stderr text output.
 * @returns {number|null} Total test count, 0 if any suite executed 0 tests, or null if not detected.
 */
export function parseTestCount(output) {
  output = stripAnsi(output);
  const summaryMatches = [...output.matchAll(/^\s*(?:#|ℹ)\s+tests:?\s+(\d+)\b/gim)];
  const planMatches = [...output.matchAll(/^[ \t]*1\.\.(\d+)(?:[ \t]*#.*)?[ \t]*\r?$/gm)];
  const topLevelPlanMatches = [...output.matchAll(/^1\.\.(\d+)(?:[ \t]*#.*)?[ \t]*\r?$/gm)];

  for (const match of summaryMatches) {
    if (Number.parseInt(match[1], 10) === 0) return 0;
  }
  for (const match of planMatches) {
    if (Number.parseInt(match[1], 10) === 0) return 0;
  }

  if (summaryMatches.length > 0) {
    return summaryMatches.reduce((sum, m) => sum + Number.parseInt(m[1], 10), 0);
  }
  if (topLevelPlanMatches.length === 1) {
    return Number.parseInt(topLevelPlanMatches[0][1], 10);
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
  output = stripAnsi(output);
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
  output = stripAnsi(output);
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
  output = stripAnsi(output);
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
  output = stripAnsi(output);
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
  output = stripAnsi(output);
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
  let hasSpecTestSummary = false;
  let hasTapTestSummary = false;
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

  const summaryMetricNames = ['tests', 'pass', 'fail', 'skipped', 'todo', 'cancelled'];
  let currentSummary = null;
  let completedSummaryCount = 0;
  let topLevelPlanCount = 0;
  let topLevelPlanValue = null;
  let topLevelTapPoints = 0;
  let topLevelNumberedTapPoints = 0;
  let topLevelPassPoints = 0;
  let malformedSummary = null;

  const metricPrefixRegex = /^\s*(?:#|ℹ)\s+(tests|pass(?:ed)?|fail(?:ed)?|skipped|todo|cancelled)(?::|\s*$|\s+[-+\d])/i;
  const numericMetrics = {
    tests: /^\s*(?:#|ℹ)\s+tests:?\s+(\d+)\s*$/i,
    pass: /^\s*(?:#|ℹ)\s+pass(?:ed)?:?\s+(\d+)\s*$/i,
    fail: /^\s*(?:#|ℹ)\s+fail(?:ed)?:?\s+(\d+)\s*$/i,
    skipped: /^\s*(?:#|ℹ)\s+skipped:?\s+(\d+)\s*$/i,
    todo: /^\s*(?:#|ℹ)\s+todo:?\s+(\d+)\s*$/i,
    cancelled: /^\s*(?:#|ℹ)\s+cancelled:?\s+(\d+)\s*$/i,
  };

  function recordSummaryMetric(metric, value) {
    if (metric === 'tests') {
      if (currentSummary !== null) {
        const missing = summaryMetricNames.filter((name) => currentSummary[name] === null);
        malformedSummary ??= `Incomplete reporter summary before next tests field: missing ${missing.join(', ')}`;
      }
      currentSummary = {
        tests: value,
        pass: null,
        fail: null,
        skipped: null,
        todo: null,
        cancelled: null,
      };
      return;
    }

    if (currentSummary === null) {
      malformedSummary ??= `Reporter ${metric} field appeared without a preceding tests field`;
      return;
    }

    if (currentSummary[metric] !== null) {
      malformedSummary ??= `Duplicate ${metric} field in reporter summary`;
      return;
    }

    currentSummary[metric] = value;
    if (summaryMetricNames.some((name) => currentSummary[name] === null)) return;

    const accounted = currentSummary.pass
      + currentSummary.fail
      + currentSummary.skipped
      + currentSummary.todo
      + currentSummary.cancelled;
    if (accounted !== currentSummary.tests) {
      malformedSummary ??= `Contradictory reporter summary: tests=${currentSummary.tests} but pass+fail+skipped+todo+cancelled=${accounted}`;
    }
    completedSummaryCount++;
    currentSummary = null;
  }

  return {
    pushLine(line) {
      line = stripAnsi(line).replace(/\r$/, '');

      const summaryLike = line.match(metricPrefixRegex);
      if (summaryLike && !/^\s*(?:#|ℹ)\s+(?:tests|pass(?:ed)?|fail(?:ed)?|skipped|todo|cancelled):?\s+\d+\s*$/i.test(line)) {
        malformedSummary ??= `Malformed ${summaryLike[1]} summary line: ${line}`;
      }

      // 1. Tests summary: # tests N or ℹ tests N
      const testMatch = line.match(numericMetrics.tests);
      if (testMatch) {
        const val = Number.parseInt(testMatch[1], 10);
        if (val === 0) hasZeroTestSummary = true;
        if (/^\s*ℹ/.test(line)) hasSpecTestSummary = true;
        else hasTapTestSummary = true;
        summaryTests += val;
        summaryTestsCount++;
        recordSummaryMetric('tests', val);
      }

      // 2. TAP plan: 1..N
      const planMatch = line.match(/^[ \t]*1\.\.(\d+)(?:[ \t]*#.*)?[ \t]*$/);
      if (planMatch) {
        const val = Number.parseInt(planMatch[1], 10);
        if (val === 0) hasZeroTestSummary = true;
        planTestsCount++;
        if (/^1\.\./.test(line)) {
          topLevelPlanCount++;
          topLevelPlanValue = val;
        }
      }

      const tapPoint = line.match(/^(ok|not ok)(?=[ \t]|$)/i);
      if (tapPoint) {
        topLevelTapPoints++;
        if (/^(?:ok|not ok)[ \t]+\d+(?=[ \t]|$)/i.test(line)) topLevelNumberedTapPoints++;
        if (tapPoint[1].toLowerCase() === 'ok'
          && !TAP_OR_SPEC_SKIP_DIRECTIVE_REGEX.test(line)
          && !TAP_OR_SPEC_TODO_DIRECTIVE_REGEX.test(line)) {
          topLevelPassPoints++;
        }
      }

      // 3. Pass summary: # pass N or ℹ pass N
      const passMatch = line.match(numericMetrics.pass);
      if (passMatch) {
        const val = Number.parseInt(passMatch[1], 10);
        summaryPass += val;
        summaryPassCount++;
        recordSummaryMetric('pass', val);
      }

      // 4. Skipped summary or directive: # skipped N or ℹ skipped N or TAP/spec skip
      const skipMatch = line.match(numericMetrics.skipped);
      if (skipMatch) {
        const val = Number.parseInt(skipMatch[1], 10);
        summarySkipped += val;
        recordSummaryMetric('skipped', val);
      } else if (TAP_OR_SPEC_SKIP_DIRECTIVE_REGEX.test(line)) {
        hasSkipDirective = true;
      }

      // 5. TODO summary or directive: # todo N or ℹ todo N or TAP/spec todo
      const todoMatch = line.match(numericMetrics.todo);
      if (todoMatch) {
        const val = Number.parseInt(todoMatch[1], 10);
        summaryTodo += val;
        recordSummaryMetric('todo', val);
      } else if (TAP_OR_SPEC_TODO_DIRECTIVE_REGEX.test(line)) {
        hasTodoDirective = true;
      }

      // 6. Cancelled summary or directive: # cancelled N or spec (cancelled)
      const cancelledMatch = line.match(numericMetrics.cancelled);
      if (cancelledMatch) {
        const val = Number.parseInt(cancelledMatch[1], 10);
        summaryCancelled += val;
        recordSummaryMetric('cancelled', val);
      } else if (/^\s*[\ufe63\-]\s+[^\r\n]*\((?:cancelled)\)/i.test(line)) {
        hasCancelledDirective = true;
      }

      // 7. Fail summary or raw TAP "not ok": # fail N or not ok
      const failMatch = line.match(numericMetrics.fail);
      if (failMatch) {
        const val = Number.parseInt(failMatch[1], 10);
        summaryFail += val;
        recordSummaryMetric('fail', val);
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
      } else if (topLevelPlanCount === 1) {
        totalTests = topLevelPlanValue;
      }

      let passCount = summaryPassCount > 0 ? summaryPass : null;

      let accountingError = malformedSummary;
      if (!accountingError && summaryTestsCount > 0) {
        if (currentSummary !== null) {
          const missing = summaryMetricNames.filter((name) => currentSummary[name] === null);
          accountingError = `Incomplete reporter summary: missing ${missing.join(', ')}`;
        } else if (completedSummaryCount !== summaryTestsCount) {
          accountingError = `Incomplete reporter summaries: completed ${completedSummaryCount} of ${summaryTestsCount}`;
        } else {
          const accounted = summaryPass + summaryFail + summarySkipped + summaryTodo + summaryCancelled;
          if (accounted !== summaryTests) {
            accountingError = `Contradictory reporter summaries: tests=${summaryTests} but pass+fail+skipped+todo+cancelled=${accounted}`;
          }
        }
      }

      // A reporter summary does not excuse missing or contradictory top-level TAP evidence.
      // Indented subtest plans describe a different scope and cannot be added to this plan.
      // Spec reporters use the ℹ summary and can include application logs beginning
      // with TAP-like words. TAP summaries and plan-only streams remain fail-closed.
      const specOnlySummary = hasSpecTestSummary && !hasTapTestSummary;
      const requiresTapReconciliation = planTestsCount > 0
        || (topLevelTapPoints > 0 && (!specOnlySummary || topLevelNumberedTapPoints > 0));
      if (!accountingError && requiresTapReconciliation) {
        if (topLevelPlanCount !== 1 || topLevelPlanValue === null) {
          accountingError = `Incomplete TAP evidence: expected exactly one top-level plan, found ${topLevelPlanCount}`;
        } else if (topLevelTapPoints !== topLevelPlanValue) {
          accountingError = `Contradictory TAP evidence: top-level plan declares ${topLevelPlanValue} test point(s) but ${topLevelTapPoints} top-level point(s) were observed`;
        } else if (summaryTestsCount === 0) {
          passCount = topLevelPassPoints;
        }
      }

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
        accountingValid: accountingError === null,
        accountingError,
      };
    },
    reportMalformedOutput(reason) {
      malformedSummary ??= reason;
    },
  };
}

/**
 * Parses a completed in-memory transcript with the same strict accounting rules used by the
 * streaming zero-skip runner.
 *
 * @param {string} output - Complete stdout/stderr transcript.
 * @returns {ReturnType<ReturnType<typeof createStreamingTestParser>['getResults']>}
 */
export function parseCompleteTestOutput(output) {
  const parser = createStreamingTestParser();
  for (const line of output.split(/\r?\n/)) {
    if (line.length > 0) parser.pushLine(line);
  }
  return parser.getResults();
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
  const MAX_TEST_OUTPUT_LINE_LENGTH = 1024 * 1024;
  const stdoutDecoder = new StringDecoder('utf8');
  const stderrDecoder = new StringDecoder('utf8');
  let stdoutLineBuffer = '';
  let stderrLineBuffer = '';

  function processChunk(chunk, decoder, getBuffer, setBuffer) {
    const text = typeof chunk === 'string' ? chunk : decoder.write(chunk);
    const combined = getBuffer() + text;
    const lines = combined.split(/\r?\n/);
    const pending = lines.pop() ?? '';
    if (pending.length > MAX_TEST_OUTPUT_LINE_LENGTH) {
      parser.reportMalformedOutput(`Test output line exceeds ${MAX_TEST_OUTPUT_LINE_LENGTH} characters`);
      setBuffer('');
    } else {
      setBuffer(pending);
    }
    for (const line of lines) {
      if (line.length > MAX_TEST_OUTPUT_LINE_LENGTH) {
        parser.reportMalformedOutput(`Test output line exceeds ${MAX_TEST_OUTPUT_LINE_LENGTH} characters`);
      } else {
        parser.pushLine(line);
      }
    }
  }

  function flushStream(decoder, getBuffer, setBuffer) {
    const finalStr = decoder.end();
    const combined = getBuffer() + finalStr;
    const lines = combined.split(/\r?\n/);
    setBuffer('');
    for (const line of lines) {
      if (line.length > 0) {
        if (line.length > MAX_TEST_OUTPUT_LINE_LENGTH) {
          parser.reportMalformedOutput(`Test output line exceeds ${MAX_TEST_OUTPUT_LINE_LENGTH} characters`);
        } else {
          parser.pushLine(line);
        }
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

