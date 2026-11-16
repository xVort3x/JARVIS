// Remembers models that failed to start answering, so one bad provider doesn't take every later request with it.
// Keys are `provider:model`. A model is out of rotation until its cooldown passes; a success clears it.
export function createProviderHealth({ cooldownMs = 10 * 60_000, now = Date.now } = {}) {
  const entries = new Map();
  return {
    fail(key, reason) {
      const failures = (entries.get(key)?.failures ?? 0) + 1;
      entries.set(key, { failures, until: now() + cooldownMs, reason: String(reason ?? '').slice(0, 300) });
    },
    ok(key) {
      const e = entries.get(key);
      if (e) entries.set(key, { failures: 0, until: 0, reason: '' });
    },
    down(key) {
      const e = entries.get(key);
      return !!e && e.until > now();
    },
    reason(key) {
      const e = entries.get(key);
      return e && e.until > now() ? e.reason : null;
    },
    snapshot() {
      return Object.fromEntries([...entries].filter(([, e]) => e.until > now()).map(([key, e]) => [key, { ...e }]));
    },
  };
}

/** The first candidate that isn't in cooldown, skipping the one that just failed. Candidates are { provider, model }. */
export function pickFallback(candidates, health, failed) {
  for (const c of candidates) {
    if (!c?.provider || !c?.model) continue;
    if (failed && c.provider === failed.provider && c.model === failed.model) continue;
    if (health.down(`${c.provider}:${c.model}`)) continue;
    return c;
  }
  return null;
}
