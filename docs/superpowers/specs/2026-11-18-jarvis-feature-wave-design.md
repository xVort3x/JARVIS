# J.A.R.V.I.S — feature wave 2026-11-18 (phases A–D, then E–F; G deferred)

Date: 2026-11-18 · Author's decisions: all fixed-point ones above (this conversation).

## Intent

Make J.A.R.V.I.S feel like the films: fast grounded answers from anywhere on the web, shorter replies when
you need them terse, a real research mode, a drafting canvas, and a floating speaking pill that shows it's
speaking rather than a menu-bar dot.

## Goals / phases

- **Phase A — Brief Mode + Local Awareness + launch verification.** A Brief toggle in panel → General;
  while on, replies are cut to one or two sentences; locale/timezone only ride with the AI when the user
  enables them (General → Local awareness); the launch path ("open YouTube and search …") gets prompt
  examples if missing.
- **Phase B — Deep Search + Fact Check (voice).** Prompt-harness modes:
  "deep search …" → 3+ targeted searches, fetch best pages, answer with sources; "verify X" → an explicit
  cross-check of the claim against the web, with mismatches flagged; both already work through web_search
  and web_fetch — the harness shapes the model to use them that way.
- **Phase C — Prompt Studio.** New panel page: a calm canvas; "Add to Studio" mode appends what you dictate
  verbatim into it (same talk keys); presets (Polish / Shorten / Formalise / free instruction) send the
  canvas to the brain once; Export writes to `Desktop\studio-<date>.md` (ask-or-skip confirmation); draft
  persists at `~/.gg/studio-draft.md`.
- **Phase D — Speaking pill.** Our original take on the floating-pill form-factor: bottom-center,
  always-on-top, pass-through — a glowing pearl-gradient orb, a symmetric waveform lit while speech plays,
  and a chip carrying the current talk shortcut label. Wired to speech_start / speech_first_audio / idle.
  Click-through outside the chip.
- **Phase E — Multi-monitor screen analysis (after A–D).** Display index plumbing through the screenshot
  tools and Rust; `look_at_screen({ display: n })` and "capture the other monitor".
- **Phase F — Voice panel commands (after A–D).** A `panel_action` tool wiring speech to existing panel
  actions ("clear chat", "new conversation", "brief mode on/off", "switch to Flash", "show/hide you"…).
- **Phase G — Gmail:** blocked; needs a Gmail app password (IMAP) from the user. Not in this wave.

## Anti-goals

- Vanta Voice copied wholesale: no decompilation of their app, no their audio/graphics assets, no exact
  pixel replication. Inspiration lives in the general form-factor (orb, waveform, chip) only, and every part
  is our own art and copy.
- No deleting local data; no writes outside the home folder; existing safety rules stay.
- No email without the user's own authorization.

## Constraints

- Internal names stay (`roamies-*`, `com.kenkai.roamies`, `~/.gg`).
- Windows first (the user's machine); Linux/macOS unaffected wherever feasible.
- Tests for every rule; `npm test` stays green; `voice-win` cargo tests stay green.
- The panel's existing pages/components/patterns are extended, not replaced.

## Approaches considered

- Prompt-only BrierMode/Deep-Search vs. new tools/toggles: prompt-harness chosen (covers B & A cheaply, no
  state machine; gains via tests on prompt lines).
- Canvas dictation via a sidecar flag vs. a separate dictation shortcut: anchored-dictation via the existing
  hands-free/talk path chosen (keeps the keys the user already owns; no second shortcut).
- Pill as a Tauri overlay window vs. panel-side animation: new transparent overlay (Rust) chosen (bottom-center
  regardless of panel state).

## Builder calls

Everything else: builder's to settle, matching existing codebase patterns.
