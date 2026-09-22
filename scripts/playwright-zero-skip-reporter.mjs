/**
 * Playwright reporter that makes the repository's zero-skip contract enforceable for browser
 * suites. Playwright's process exit status alone permits annotations such as `test.skip()`.
 */

/**
 * @param {string[]} outcomes Playwright TestCase.outcome() values.
 * @param {string} runStatus Playwright FullResult.status.
 */
export function summarizePlaywrightOutcomes(outcomes, runStatus) {
  const summary = {
    tests: outcomes.length,
    pass: 0,
    fail: 0,
    skipped: 0,
    todo: 0,
    cancelled: 0,
  };

  for (const outcome of outcomes) {
    if (outcome === 'skipped') summary.skipped++;
    else if (outcome === 'unexpected') summary.fail++;
    else if (outcome === 'expected' || outcome === 'flaky') summary.pass++;
    else summary.cancelled++;
  }

  // Preserve exact accounting while making a non-passing run visible in the summary. Playwright
  // can report every test as expected even when teardown later times out or is interrupted.
  if (runStatus !== 'passed' && summary.tests > 0 && summary.pass === summary.tests) {
    summary.pass--;
    if (runStatus === 'interrupted') summary.cancelled++;
    else summary.fail++;
  }

  return summary;
}

export default class ZeroSkipReporter {
  constructor() {
    this.suite = null;
    this.listOnly = process.argv.includes('--list');
  }

  onBegin(_config, suite) {
    this.suite = suite;
  }

  onEnd(result) {
    if (this.listOnly) return { status: result.status };
    const outcomes = this.suite?.allTests().map((testCase) => testCase.outcome()) ?? [];
    const summary = summarizePlaywrightOutcomes(outcomes, result.status);

    console.log(`# tests ${summary.tests}`);
    console.log(`# pass ${summary.pass}`);
    console.log(`# fail ${summary.fail}`);
    console.log(`# cancelled ${summary.cancelled}`);
    console.log(`# skipped ${summary.skipped}`);
    console.log(`# todo ${summary.todo}`);

    const clean =
      result.status === 'passed' &&
      summary.tests > 0 &&
      summary.pass === summary.tests &&
      summary.fail === 0 &&
      summary.cancelled === 0 &&
      summary.skipped === 0;
    return { status: clean ? 'passed' : 'failed' };
  }

  printsToStdio() {
    return true;
  }
}
