// Asking about an area in Classic: a ⌃⌥A crop, or a circle drawn with the highlight keys while nothing was said yet.

/** How long the mic waits hands-free for the question about the area. */
export const LISTEN_MS = 12_000;

/**
 * Listen hands-free for the question (up to LISTEN_MS); with nothing said, open the "What about this?" field. The
 * area waits as the shared pending snap: pending() is it, and the spoken path (onSpoken's takeSnap) takes it, which
 * ends the wait; drop() clears it. listen: opens the mic hands-free; ask: the field; enqueue: sends the typed
 * question with the area's image. → 'spoken', 'typed' or 'dropped' (Escape).
 */
export async function listenThenAsk({ pending, drop, voice, listen, ask, enqueue, ms = LISTEN_MS, step = 150 }) {
  if (voice) {
    pending().waitingVoice = true;
    listen();
    const t0 = Date.now();
    while (pending()?.waitingVoice && Date.now() - t0 < ms) await new Promise((r) => setTimeout(r, step));
    if (!pending()) return 'spoken';
    pending().waitingVoice = false;
  }
  const q = await ask({ placeholder: 'What about this?' });
  const s = pending();
  if (!s) return 'spoken'; // already sent by voice
  drop();
  if (q === null) return 'dropped';
  enqueue(q.trim() || 'What is this? Explain it simply.', { image: s.image });
  return 'typed';
}
