// Always-Aware: what J.A.R.V.I.S is allowed to know about your screen, and what happens to every picture it takes.
// Pure logic, so the tests can drive it; sidekick.mjs owns the config and the wiring.
//
// The always-in-context line (the app in front, its window title) only goes into a request while Always-Aware is
// on, and never while in private mode, on the lock screen, or on an excluded app. The on-demand tool
// (look_at_screen) still works for the user's explicit asks — except on excluded apps and the lock screen, which
// are off limits no matter what asked.
import { createHash } from 'node:crypto';

export const AWARE_DEFAULT_EXCLUSIONS = [
  '1password', 'bitwarden', 'keepass', 'lastpass', 'enpass', // password managers
  'logonui', 'lockapp', 'consent.exe', 'credential dialog', // the lock screen and UAC
  'InPrivate', 'Incognito', 'Private Browsing', // private windows
];
// Apps and titles the lock screen uses; on these, nothing is seen, saved or sent, ever.
const LOCKED = ['logonui', 'lockapp', 'consent.exe', 'credential dialog'];

const hay = (front) => [front?.app, front?.exe, front?.title].filter(Boolean).join('\n').toLowerCase();

export const hashShot = (buffer) => createHash('sha256').update(buffer).digest('hex');
export const cleanExclusion = (s) => { const t = String(s ?? '').trim().replace(/\s+/g, ' '); return t.length >= 2 && t.length <= 60 ? t : null; };
export const exclusionsOf = (config) => (Array.isArray(config?.awareExclusions) ? config.awareExclusions : AWARE_DEFAULT_EXCLUSIONS);
export const awareMode = (config) => (config?.awareMode === 'screen' ? 'screen' : 'front');
export const isLocked = (front) => { const h = hay(front); return !h || LOCKED.some((s) => h.includes(s)); };
export const excluded = (front, list) => { const h = hay(front); return h ? ((list ?? AWARE_DEFAULT_EXCLUSIONS).find((e) => h.includes(e.toLowerCase())) ?? null) : null; };

/** The one line about the screen that rides with a request; '' when there isn't one (AA off, private, locked or excluded). */
export function screenLine(front, config) {
  if (!config?.alwaysAware || config?.awarePrivate) return '';
  if (!front?.app || isLocked(front) || excluded(front, exclusionsOf(config))) return '';
  return screenLineOf(front, config);
}
const screenLineOf = (f, config) => {
  const cut = (t, n) => (t.length > n ? `${t.slice(0, n - 1)}…` : t);
  let url = '';
  try { if (f.url) { const u = new URL(f.url); url = /^https?:$/.test(u.protocol) ? cut(u.host + u.pathname.replace(/\/$/, ''), 120) : ''; } } catch { /* not a URL */ }
  const title = f.title ? ` — "${cut(String(f.title).replace(/\s+/g, ' ').trim(), 120)}"` : '';
  // Which scope it's in: the front window, or the whole screen when the user picked "screen".
  const lead = awareMode(config) === 'screen' ? `Right now they're on the whole screen` : `Right now they're in ${f.app}`;
  return `- ${lead}${title}${url ? ` (${url})` : ''}. This was just checked and overrides any app or page from earlier messages; they can still ask about something elsewhere.`;
};

/** Whether the on-demand tool may look, and why not when it may not. Never true on exclusions or the lock screen. */
export function mayLook(front, config) {
  if (isLocked(front)) return { ok: false, why: 'That looks like the lock screen, so I can’t see it.' };
  const hit = excluded(front, exclusionsOf(config));
  if (hit) return { ok: false, why: `That’s one of the apps or windows I never look at (it matches “${hit}” in Screen exclusions).` };
  return { ok: true };
}
