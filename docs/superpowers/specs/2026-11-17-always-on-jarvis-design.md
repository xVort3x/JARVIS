# Always-on J.A.R.V.I.S (Windows) — design

Date: 2026-11-17 · Version: 0.6.0

## Intent

Make J.A.R.V.I.S feel like the films on Windows: it listens for “Jarvis” without a key, and when a
question arrives it looks in the right place on its own — the screen, the user’s files, or the web —
then answers in seconds. The user asked for permanent access to the screen and files and for
automatic research.

## What exists today (recon)

- Wake word is **macOS-only**: the panel hides it, the sidecar sends `wake: false` on Windows, and
  `voice-win` ignores `cmd: wake` / `wake_name`. So “Hey Jarvis” cannot work on Windows today.
- Screen: Always-Aware is implemented (front-app line, exclusions, private mode, lock-screen guard,
  `look_at_screen` / `take_screenshot` / `read_window` tools) but is **off** in the saved config and
  off by default.
- Files: `read_file`, `list_files`, `search_files`, `write_file`, `run_command` exist. Reads never
  prompt. But there is no “newest files” tool, and `search_files` shells out to `rg`/`grep`, which
  are not on this Windows PC, so content search fails.
- Research: `web_search` and `web_fetch` exist and work without an app-specific key. The prompt says
  they exist, but it does not make current-fact questions go there first.

## Goals

1. **Wake word on Windows**: “Jarvis” (or a custom name) starts a hands-free take; the mic is held
   open only while the wake toggle is on; wake pauses while J.A.R.V.I.S answers or speaks; the panel
   shows the toggle and the name changer on Windows.
2. **Always-Aware on and permanent** for this install: the front app/window rides with every request;
   private mode and exclusions still work; screenshots and window reads stay on demand.
3. **Automatic gathering**: the model checks the screen, the files, or the web before answering,
   in the same turn, without asking and without announcing the look.
4. **Fast personal lookups**: a `recent_files` tool (newest first, with time and size) so “my latest
   download” is one local call; a native fallback for `search_files` when `rg`/`grep` are missing.
5. **Current facts from the web**: fixtures, news, prices, weather, releases and “the next …” always
   go through `web_search` first, never memory.

## Non-goals

- No cloud wake listening: wake detection runs on the PC (Windows’ built-in speech recognizer, which
  is local; if the speech engine/language pack is missing, the toggle explains it and the hotkey
  still works).
- No deletion/overwrite without confirmation, no writes outside the home folder, no reading of
  secrets (`.ssh`, `.env`, auth.json, keychains): the existing safety rules stay.
- No screenshot attached to every request: Always-Aware sends the front-app line; pixels are read
  when the question is about the screen.

## Wake word approach

| Option | Trade-off |
|---|---|
| **A. Windows built-in SpeechRecognizer with a list grammar** (pick) | No model download, low CPU, starts listening immediately; needs an installed speech language (en-US is present on this PC — verified). Local to the PC. |
| B. Small keyword-spotter model (openWakeWord / sherpa-onnx KWS) | Fully app-owned and portable, but adds a model download, an audio frontend and build weight. |
| C. Reuse Parakeet continuously with VAD | No new dependencies, fully on-device as today, but transcribes every utterance and costs noticeable CPU while media plays. |

A is the smallest complete change and has no download. B is the fallback if A proves unreliable in
practice; C is not chosen because of the CPU cost.

## Design

**voice-win (Rust, `cfg(windows)`)**
- A wake engine thread owns `Windows.Media.SpeechRecognition.SpeechRecognizer` with a
  `SpeechRecognitionListConstraint` of `["<name>", "hey <name>"]` (default `jarvis`, English).
- `cmd: wake {on}` starts/stops continuous recognition; `cmd: wake_name {word}` rebuilds the grammar.
- `cmd: wake_hold {on}` pauses while J.A.R.V.I.S answers/speaks (mic can stay open but unheard).
- On a result with confidence over the bar: stop the wake session, start a normal hands-free take
  (`Phase::HandsFree`), so the existing take/VAD/send path is reused; resume wake after the take.
- A 2-second cooldown after a take; never wake while muted or while a take is active; failures log
  and leave the hotkey path working.
- Linux keeps compiling: the WinRT module is `cfg(windows)`; wake stays off there.

**sidecar (`sidekick.mjs`)**
- Pass `wake: !!config.wakeWord` on every platform the helper supports (mac + Windows), send
  `wake_hold` on Windows too, and mention the wake word in the live prompt on Windows.
- `wakeword` / `wakename` panel actions allowed on Windows as well; lane for onboarding unchanged.
- Default wake name stays `Jarvis` (spoken form).

**panel (`panel.js`)**
- Voice page: show “Wake word” and “Wake word name” when `mac || win`; default label “Jarvis”.
- Screen page already exposes Always-Aware, Front window/Whole screen, private mode, exclusions.

**Tools (`tools.mjs`)**
- New `recent_files { dir? = ~/Downloads, limit? = 10 }`: newest first, time, size, folder mark;
  read-only and confirmation-free; `checkRead` applies.
- `search_files`: if `rg` and `grep` both fail to start, do a bounded native walk of the given folder
  (name/substring or regex over small text files, skip secrets and binaries, cap files/bytes) and
  say what was read. No whole-home searches (existing `checkRead` recursive guard stays).

**Prompt (`sidekick.mjs` stable prompt)**
- Add one “Where the answer lives” paragraph: screen questions → look now; their things → file tools
  (`recent_files` for newest); current/world facts → `web_search` + `web_fetch`, never memory; read
  looks cost no permission, so do them in the same turn, in parallel, without asking or announcing.
- Remove the macOS-only qualification from the wake-word line.

**Config for this install** (after reinstall, before launch): `alwaysAware: true`, `wakeWord: true`.
The product defaults stay opt-in, so other copies don't start listening on their own.

**About/PRIVACY/docs**
- About: wake word is no longer “Mac only”; Windows wording; “Hey Jarvis”.
- PRIVACY: wake word on Windows uses the built-in Windows speech recognizer, mic open while enabled,
  pausable, no request text logged.
- Version 0.6.0 in `tauri.conf.json`, `Cargo.toml`, panel fallback.

## Verification

- `npm test` in `showcase/tauri/sidecar` (new test: `recent_files` ordering/format; existing wake-name,
  aware, prompt tests updated).
- `./build.sh` release, install over 0.5.0, launch.
- Manual: say “Jarvis” → take opens; “Jarvis, what is my latest download?” → newest file in Downloads;
  “Jarvis, when is the next Portugal game?” → web-backed answer; panel toggle visible; wake pauses
  while answering; logs show start 0.6.0 and no text.

## Risks

- Windows speech language pack missing on another PC → wake toggle reports unavailable; hotkey path
  unaffected. (Present here: en-US.)
- False wakes from media saying “Jarvis” → 2s cooldown and wake-hold while answering; user can turn
  the toggle off.
- `search_files` native fallback is bounded (specific folder, capped files/bytes) to stay fast.
