/** Interrupt on expiry, but wait for bounded active work to settle before caller cleanup. */
export async function awaitJourney(work, milliseconds, interrupt) {
  let expired = false;
  const timer = setTimeout(() => {
    expired = true;
    void Promise.resolve().then(interrupt).catch(() => {});
  }, Math.max(1, milliseconds));
  try {
    await work;
    if (expired) throw new Error('Global browser journey deadline exceeded');
  } finally {
    clearTimeout(timer);
  }
}

/** Port selection cannot reserve Docker's socket; retry only an actual startup bind collision. */
export async function startOnAvailablePort(choose, start) {
  for (let attempt = 0; attempt < 3; attempt++) {
    const port = await choose();
    try {
      await start(port);
      return port;
    } catch (error) {
      if (attempt === 2 || !/port is already allocated|address already in use|ports are not available|only one usage of each socket address/i.test(error.message)) throw error;
    }
  }
}
