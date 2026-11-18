# Feature wave (A–D) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans (this session) — subagents hit usage limits earlier today.

**Goal:** Brief Mode, Local Awareness opt-in, voice-driven deep search and fact check, a Prompt Studio that dictates/refines/exports, and an original floating speaking pill — all live on this machine.

**Architecture:** prompt-harness modes for A/B, a new panel page fed by the sidecar for C, a transparent always-on-top Tauri window for D. Config toggles in `~/.gg/sidekick.json` and the panel.

**Spec:** `docs/superpowers/specs/2026-11-18-jarvis-feature-wave-design.md`

## Global Constraints

- Tested with `npm test` in `showcase/tauri/sidecar` (stays green).
- Internal names kept: `roamies-*`, `com.kenkai.roamies`, `~/.gg`.
- No writes outside the home folder; no email access in this wave.

## Review Focus

- The prompt gains long conditional blocks; review that the wrong mode never sticks (Brief off → normal length again).
- The studio canvas appends raw STT text with no shot at the caret; watch text-append ordering.
- The pill must close/hide when speech ends — a stuck overlay is the worst failure it can have.
- Dictation must never go through the agent (it would answer itself!).
- All new config keys must survive `saveConfig()` either set or absent.

---

## Task A: Brief Mode toggle

**Files:** Modify `sidekick.mjs` (DEFAULTS, `livePrompt`, panel handlers), `panel.js` (General page), `test/defaults.test.mjs`, `test/prompt.test.mjs`.

Interfaces: new `config.brief` (default false); prompt line `- Brief mode: ON…` only while set; panel message `panel_brief` (`on` bool).

- [ ] A1: defaults test asserts `brief: false` in DEFAULTS; prompt test asserts the Brief line exists iff mode on.
- [ ] A2: prompt: `${config.brief ? 'Brief mode is ON: people want short answers — one or two sentences, no preamble, no plans, no "certainly". Cards only when they carry real value.' : ''}` in `livePrompt`; DEFAULTS `brief: false`.
- [ ] A3: panel → General: a `brief` toggle (`toggle('Brief mode', 'Shorter, punchier replies', config.brief, (v) => act('brief:'+v), 'brief')`); sidecar handles `brief:` → sets `config.brief`, saves, `menu()`.
- [ ] A4: `npm test`; commit.

## Task B: Local awareness opt-in toggle

**Files:** same as A (panel General, sidekick prompt, tests).

Interfaces: `config.local_awareness` (default true — behavior today, so it defaults honestly; the user can flip off).

- [ ] B1: defaults test asserts `local_awareness: true` in DEFAULTS.
- [ ] B2: prompt: while off, replace `Their time zone is …` with a neutral line that the user has not shared locale/timezone.
- [ ] B3: panel toggle, `panel_local_awareness` action; `PRIVACY.md` sentence documenting the opt-out.
- [ ] B4: `npm test`; commit.

## Task C: Launch path verified (docs + prompt examples)

**Files:** `sidekick.mjs` (STABLE prompt example line), `README.md` (two example voices), `test/prompt.test.mjs`.

- [ ] C1: prompt example: `Open YouTube and search for …` + `Play the first result`.
- [ ] C2: test asserts both lines.
- [ ] C3: `npm test`; commit.

## Task D: Deep Search + Fact Check (voice)

**Files:** `sidekick.mjs` (prompt), `test/prompt.test.mjs`.

- [ ] D1: tests assert `For a deeper answer…` and `Fact check` rules appear in the prompt.
- [ ] D2: prompt lines: `- Deep search: when asked to look something up properly ("dig", "do a deep search", "thorough"), run 3+ searches, fetch the best 2-3 pages, and answer with the findings and 3+ named sources.` / `- Fact check: when asked to check or verify a claim, fetch at least one source stating the fact, quote the number, and flag whether it matches, with the source name.`
- [ ] D3: commit.

## Task E: Prompt Studio (panel page + sidecar)

**Files:** Create `showcase/panel/studio.html`? No — extend `index.html` + `panel.js` + `panel.css` (Studio page, canvas id `studio-canvas`, buttons "Add to Studio", "Polish", "Shorten", "Formalise", "Export", "Copy"); Modify `sidekick.mjs` (page handling + `panel_studio_refine` + `panel_studio_export` + dictation routing in `onVoice`); Create `test/studio.test.mjs` for sidecar logic.

Interfaces: `panel_studio_refine { instruction, text }` → `ui({ kind: 'studio_refined', text })`; `panel_studio_export { text }` → writes `~/.gg/studio-draft.md` (current) + optional `Desktop/studio-<date>.md` on explicit instruction; `studioWriting` flag toggled by panel action; final transcripts while set append instead of answering.

- [ ] E1: sidecar test: `studioWriting` ON + voice final "hello" → no prompt dispatch, emits `studio_append`; OFF → agent turn normally.
- [ ] E2: `studio_append` → panel handler appends at caret (textarea.setRangeText).
- [ ] E3: refine: one-shot `brain.once`-style call ("text in / instruction → rewrite only the rewritten piece") with a timeout; failure → note.
- [ ] E4: export: `panel_studio_export` writes `~/.gg/studio-draft.md` + attempt `Desktop/studio-<date>.md`; on error returns `studio_export` with error.
- [ ] E5: panel page; `npm test`; `voice-win` cargo test (unaffected); commit.

## Task F: Speaking pill (own art, Rust overlay)

**Files:** Create Rust `src-tauri/src/talking.rs` (overlay window, show/hide on IPC); Modify `main.rs` (register overlay), `Cargo.toml`; Create web `panel/pill.html` + `panel/pill.js` + `panel/pill.css` (pearl orb on canvas, symmetric waveform, chip with label from Talk keys); Modify `sidekick.mjs` (UI events `speech start/first audio/idle` already flow; relay `Pill { on }` to the overlay).

- [ ] F1: Rust overlay: transparent, 24px from bottom centre, size ~ 320×84, no taskbar, always-on-top, ignores cursor except chip, show on `speech_start`, hide on `speech_final`/`idle`.
- [ ] F2: pill page: orb canvas (radial gradient + pulse) and waveform bars from an internal clock (sine × intensity ramp) while speech is active; hidden state unless `on`.
- [ ] F3: package frontend dir includes `pill`; progress via existing build; commit.

---

## Later (after A–D)

- **Screen analysis multi-monitor**: EnumDisplayMonitors + `take_screenshot({display: n})` + tool arg `display`; prompt guidance.
- **Voice panel commands**: new `panel_action` tool (`actions: ["clear_chat","brief","tts","model",…]`); each maps to an existing `act()` id; tests assert dispatch table.
- **Gmail** (blocked on user's app password): IMAP client for inbox reads (search headers, unread, read message); SMTP for replies; with its own safety rule authorising the action.
