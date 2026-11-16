// The first-token deadline: a model that hasn't sent anything at all after `ms` is treated as stalled, even if the
// socket is still open. The first event of any kind disarms it; after that, stallWatch (agentstream.mjs) takes over.
export function firstEventWatch(ms, onTimeout) {
  let timer = null, done = false, fired = false;
  const fire = () => {
    timer = null;
    if (done) return;
    done = true; fired = true;
    onTimeout();
  };
  timer = setTimeout(fire, ms);
  timer.unref?.();
  return {
    /** Any event from the model: the deadline only covers silence before the first one. */
    event() { if (!done) { done = true; clearTimeout(timer); timer = null; } },
    stop() { done = true; clearTimeout(timer); timer = null; },
    get timedOut() { return fired; },
  };
}
