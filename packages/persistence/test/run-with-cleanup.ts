/**
 * Runs `body`, then every cleanup step in order, whether or not `body` or an earlier step failed.
 * Nothing is swallowed: one failure is rethrown as is, several become an AggregateError that lists
 * the body's failure first and the cleanup failures after it, in the order they happened.
 */
export async function runWithCleanup(
  body: () => Promise<void>,
  cleanups: ReadonlyArray<{ readonly name: string; readonly run: () => Promise<unknown> }>,
): Promise<void> {
  const failures: unknown[] = [];
  try {
    await body();
  } catch (error) {
    failures.push(error);
  }
  for (const step of cleanups) {
    try {
      await step.run();
    } catch (error) {
      failures.push(new Error(`cleanup step "${step.name}" failed`, { cause: error }));
    }
  }
  if (failures.length === 1) throw failures[0];
  if (failures.length > 1) throw new AggregateError(failures, `test and cleanup failed (${failures.length} errors)`);
}
