# Always-on J.A.R.V.I.S (Windows) — implementation plan

Date: 2026-11-17 · Version: 0.6.0 · Spec: `docs/superpowers/specs/2026-11-17-always-on-jarvis-design.md`

Goal: Windows listens for "Jarvis" without a key, Always-Aware is on for this install, and every question
automatically consults the screen, the local files or the web before answering. Tests after every task;
one commit per task. Internal `roamies` names stay.

Order: tools first (pure Node, fast tests), then prompt/sidecar/panel copy, then the Rust wake engine,
then versions/docs, then build/install/verify.

---

## Task 1 — `recent_files` tool (newest first)

**Files:** `showcase/tauri/sidecar/tools.mjs`, new `showcase/tauri/sidecar/test/recent.test.mjs`.

1. In `createTools`, beside `list_files` (around line 938), add:

```js
{
  name: 'recent_files',
  description: `The newest files in a folder (${userName}'s Downloads folder by default), newest first, with when each last changed and how big it is. Read-only, no confirmation. Use it for "my latest download" or "what did I just save" instead of guessing names.`,
  parameters: z.object({ dir: z.string().optional(), limit: z.number().int().min(1).max(50).optional() }),
  execute: async ({ dir, limit }) => {
    const d = allowed(checkRead(at(dir || '~/Downloads'), HOME));
    const root = expand(d);
    const ents = await fs.readdir(root, { withFileTypes: true }).catch((e) => {
      if (e.code === 'ENOENT') return null;
      throw e;
    });
    if (!ents) throw new Error(`There's no folder at ${d}.`);
    const files = await Promise.all(ents.filter((e) => e.isFile()).map(async (e) => {
      const s = await fs.stat(path.join(root, e.name)).catch(() => null);
      return s && { name: e.name, at: s.mtimeMs, size: s.size };
    }));
    const newest = files.filter(Boolean).sort((a, b) => b.at - a.at).slice(0, limit ?? 10);
    if (!newest.length) return `No files in ${d}.`;
    const size = (n) => (n >= 1e9 ? `${(n / 1e9).toFixed(1)} GB` : n >= 1e6 ? `${(n / 1e6).toFixed(1)} MB` : n >= 1e3 ? `${Math.round(n / 1e3)} KB` : `${n} B`);
    const when = (t) => new Date(t).toLocaleString('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
    return `Newest in ${d}:\n${newest.map((f) => `${f.name}\t${when(f.at)}\t${size(f.size)}`).join('\n')}`;
  },
},
```

2. Add `test/recent.test.mjs` (picked up by `test/run.mjs` automatically):

```js
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createTools } from '../tools.mjs';

const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'jarvis-recent-'));
const write = async (name, secondsAgo, bytes) => {
  const p = path.join(dir, name);
  await fs.writeFile(p, 'x'.repeat(bytes));
  const t = Date.now() / 1000 - secondsAgo;
  await fs.utimes(p, t, t);
};
await write('old.txt', 86400, 10);
await write('new.pdf', 60, 2048);
await write('mid.zip', 3600, 5);

const noop = async () => {};
const { tools } = createTools({ allowActions: false, ui: () => {}, ask: noop, openUrl: noop, onCommitments: noop, showList: noop, fmtWhen: String, commitmentsText: () => '', userName: 'Test' });
const recent = tools.find((t) => t.name === 'recent_files');
assert.ok(recent, 'recent_files is a tool');

const text = await recent.execute({ dir }, {});
const lines = text.split('\n');
assert.match(lines[0], /^Newest in /);
assert.match(lines[1], /^new\.pdf\t/);
assert.match(lines[2], /^mid\.zip\t/);
assert.match(lines[3], /^old\.txt\t/);
assert.match(lines[1], /2\.0 MB/);
assert.match(lines[3], /10 B/);
assert.equal((await recent.execute({ dir, limit: 2 }, {})).split('\n').length, 3, 'limit caps the list');
await assert.rejects(recent.execute({ dir: path.join(dir, 'missing') }, {}), /no folder/);
await fs.rm(dir, { recursive: true, force: true });
console.log('recent files tests: passed');
```

3. Run `cd showcase/tauri/sidecar && npm test` (fails only if the sorting/format assertions are wrong).
4. Commit: `Phase 6: recent_files finds the newest download instantly`.

---

## Task 2 — native `search_files` fallback when `rg`/`grep` are missing

**File:** `showcase/tauri/sidecar/tools.mjs`; extend `test/toolschema.test.mjs` (or add
`test/searchtext.test.mjs`).

1. Export a bounded walker near the other exported helpers (top level, after `shellFor`):

```js
// Native content search for machines without ripgrep or grep (Windows). Bounded on purpose: a specific
// folder, small text files only, at most 3000 files / 30 MB / 200 hits.
const SKIP_DIRS = new Set(['node_modules', '.git', '.cache', 'AppData', 'Library', 'target', 'Windows', 'Program Files', 'Program Files (x86)']);
export async function searchText(dir, pattern) {
  let re;
  try { re = new RegExp(pattern); } catch { throw new Error(`"${pattern}" isn't a valid regular expression.`); }
  const out = [];
  let files = 0, bytes = 0;
  const walk = async (d) => {
    if (files >= 3000 || bytes >= 30 * 1024 * 1024 || out.length >= 200) return;
    const ents = await fs.readdir(d, { withFileTypes: true }).catch(() => null);
    if (!ents) return;
    for (const e of ents) {
      if (files >= 3000 || bytes >= 30 * 1024 * 1024 || out.length >= 200) return;
      const p = path.join(d, e.name);
      if (e.isDirectory()) {
        if (!e.name.startsWith('.') && !SKIP_DIRS.has(e.name)) await walk(p);
        continue;
      }
      if (!e.isFile()) continue;
      const st = await fs.stat(p).catch(() => null);
      if (!st || st.size > 2 * 1024 * 1024) continue;
      files += 1; bytes += st.size;
      const text = await fs.readFile(p, 'utf8').catch(() => '');
      if (!text || text.includes('\0')) continue;
      let hits = 0;
      const lines = text.split('\n');
      for (let i = 0; i < lines.length && hits < 5 && out.length < 200; i += 1) {
        if (!re.test(lines[i])) continue;
        out.push(`${p}:${i + 1}: ${lines[i].slice(0, 200)}`);
        hits += 1;
      }
    }
  };
  await walk(dir);
  return out.length ? out.join('\n') + (out.length >= 200 ? '\n…(stopped at 200 matches)' : '') : 'No matches.';
}
```

2. In the `search_files` execute, replace the two `run` lines with:

```js
const d = allowed(checkRead(at(dir), HOME, { recursive: true }));
let r = await run('rg', ['-n', '--max-count', '5', '--max-columns', '200', '-e', pattern, '--', d]);
if (r.err?.code === 'ENOENT') r = await run('grep', ['-rnI', '-m', '5', '-E', '-e', pattern, '--', d]);
if (r.err?.code === 'ENOENT') return clip(await searchText(d, pattern), 12_000);
return clip(r.stdout || 'No matches.', 12_000);
```

3. Add a test (new `test/searchtext.test.mjs`):

```js
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { searchText } from '../tools.mjs';

const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'jarvis-search-'));
await fs.mkdir(path.join(dir, 'notes'));
await fs.writeFile(path.join(dir, 'notes', 'a.txt'), 'first\nhere is the needle\nlast\n');
await fs.writeFile(path.join(dir, 'notes', 'b.bin'), 'needle\0binary');
assert.match(await searchText(dir, 'needle'), /a\.txt:2: here is the needle/);
assert.ok(!/b\.bin/.test(await searchText(dir, 'needle')), 'binary files are skipped');
assert.equal(await searchText(dir, 'absent'), 'No matches.');
await assert.rejects(searchText(dir, '('), /valid regular expression/);
await fs.rm(dir, { recursive: true, force: true });
console.log('native search tests: passed');
```

4. `npm test`.
5. Commit: `Phase 6: search files on Windows without ripgrep`.

---

## Task 3 — "Where the answer lives" prompt paragraph

**Files:** `showcase/tauri/sidecar/sidekick.mjs`, `showcase/tauri/sidecar/test/prompt.test.mjs`.

1. In `stablePrompt()` insert one paragraph after the capability line (the one starting
   `You can really help: look at the screen…`):

```
Where the answer lives: work it out before you answer, in this turn. Something on their screen ("this", "here", "what does this say") → look now with look_at_screen or read_window (for one app, that app's window). Something of theirs (a file, a download, their notes, "my latest…") → their files: recent_files for anything newest, read_file or search_files for the content; never guess a filename. Anything current or about the world (news, fixtures, scores, prices, weather, releases, "the next…", who holds an office) → web_search, then web_fetch the best page; never answer those from memory or say you can't check. Read-only looks and searches need no permission: do them in the same turn, in parallel where possible, without asking and without announcing them. Only ask when the answer needs something only they know (a password, a choice, a detail not on the machine).
```

2. In `test/prompt.test.mjs`, add:

```js
assert.match(side, /Where the answer lives: work it out before you answer, in this turn\./, 'the prompt routes questions to screen, files or web');
assert.match(side, /recent_files for anything newest/, 'newest files go to recent_files');
assert.match(side, /web_search, then web_fetch the best page; never answer those from memory/, 'current facts always use the web');
```

3. `npm test`.
4. Commit: `Phase 6: answer from the screen, the files or the web by itself`.

---

## Task 4 — sidecar: wake word on Windows

**File:** `showcase/tauri/sidecar/sidekick.mjs`.

1. `voiceConfig()` (line ~1928): `wake: MAC && !!config.wakeWord` → `wake: (MAC || WIN) && !!config.wakeWord`.
2. `holdWake()` (line ~1144): `if (MAC) send(...)` → `if (MAC || WIN) send(...)`; update the comment above it to
   say macOS and Windows.
3. Panel actions (lines ~2210-2217): `id === 'wakeword' && MAC` → `id === 'wakeword' && (MAC || WIN)` and the same
   for `wakename`.
4. Live prompt (line ~676): `${MAC && config.wakeWord ? …}` → `${(MAC || WIN) && config.wakeWord ? …}`.
5. Add a wake-problem flag near `let mics = …` (line ~1967):

```js
let wakeProblem = false; // Windows has no speech language, or its recognizer failed
```

In `onVoice`, before the generic `voice_error` outcome:

```js
if (m.code === 'wake') {
  wakeProblem = true; panel();
  say('The wake word needs a Windows speech language. Turn one on in Settings > Time & Language > Speech, or use your talk key.', 'concerned');
  return;
}
```

Add `wakeProblem,` to the `voice:` object in `state()` (line ~1912, next to `wakeWord`).
Do **not** change `obState()`'s `wakeWord: MAC && …` or `ob_wake`'s `&& MAC`: onboarding stays as it is.

6. `npm test`.
7. Commit: `Phase 6: wake word on Windows, held quiet while answering`.

---

## Task 5 — panel: wake controls on Windows

**File:** `showcase/panel/panel.js`.

1. In `listeningPage()` (line ~628), add:

```js
const canWake = mac || state.os === 'win';
```

2. Replace the two `mac ? … : null` wake rows (lines ~660-662) with `canWake ? … : null`, and use
   `v.wakeName || 'Jarvis'` instead of `'J.A.R.V.I.S'`.
3. The toggle subtitle: when `v.wakeProblem` is true, use
   `'Windows speech isn’t available on this PC; use your talk key'`, else the existing
   `needs(\`Say “Hey ${v.wakeName || 'Jarvis'}” to talk. Mic stays on.\`)`.
4. Fallback state at line ~932: `version: '0.5.0'` → `'0.6.0'`; in the mock at line ~975 change
   `wakeName: 'J.A.R.V.I.S'` → `wakeName: 'Jarvis'` and add `wakeProblem: false`.
5. No test harness for the panel; `npm test` (Task 4) still passes. Commit together with Task 4 or separately:
   `Phase 6: wake word setting on Windows`.

---

## Task 6 — about copy and its test

**Files:** `showcase/tauri/sidecar/about.mjs`, `test/about.test.mjs`, `sidekick.mjs` call site.

1. `aboutJarvis` options gain `wake` (boolean). In the Listening sentence replace

```js
${o.mac ? ', Wake word (say "Hey J.A.R.V.I.S" to talk; the name can be changed)' : ''}
```

with

```js
${o.wake ? ', Wake word (say "Hey Jarvis" to talk; the name can be changed)' : ''}
```

2. Call site line ~531: add `wake: MAC || WIN`.
3. `test/about.test.mjs`: `base` gains `wake: false`; mac call gains `wake: true`; make
   `const win = aboutJarvis({ ...base, wake: true });`.
   - Change the mac assertion to `/Wake word \(say "Hey Jarvis"/`.
   - Change the win assertion to `assert.match(win, /Wake word \(say "Hey Jarvis"/);` and keep the
     “Ask About an Area / Cursor” exclusions only: `assert.ok(!/Ask About an Area|Cursor, a little arrow/.test(win))`.
   - Keep `assert.ok(!/Wake word/.test(linux))`.
4. `npm test`.
5. Commit: `Phase 6: the app's own manual mentions the Windows wake word`.

---

## Task 7 — voice-win: Windows wake engine

**Superseded (2026-11-17):** the built-in recognizer was blocked by Windows' unaccepted speech privacy policy
(`0x80045509`), and the user chose a fully local wake word instead. The shipped implementation reuses the
Parakeet model that already hears requests: `voice-win/src/main.rs` keeps a rolling 2.5 s buffer while idle,
reads it at most once a second after the noise floor sees voice, and matches the name as a whole word in the
engine thread (`woke()`); a match sends `Ev::Wake` and opens a hands-free take. `wake.rs` and the `windows`
crate are gone. The sketch below is kept only as history.

**Files:** `showcase/tauri/src-tauri/voice-win/Cargo.toml`, new
`showcase/tauri/src-tauri/voice-win/src/wake.rs`, `src/main.rs`.

1. `Cargo.toml`, under `[target.'cfg(windows)'.dependencies]`:

```toml
windows = { version = "=0.62.2", features = ["Foundation", "Foundation_Collections", "Media_SpeechRecognition", "Win32_System_WinRT"] }
```

Keep `windows-sys` for the existing DPI/keys/ink code.

2. `main.rs`: add `#[cfg(windows)] mod wake;`.
3. `Ev` gains `Wake` (unconditional, so the match has no cfg):

```rust
pub enum Ev {
    Cmd(Value),
    StdinClosed,
    Level(f64),
    AudioFailed(MicError),
    Text { take: u64, text: String, last: bool },
    EngineFailed(String),
    Wake,
}
```

4. `Voice` gains (after `tx`):

```rust
#[cfg(windows)]
wake: Option<wake::Wake>,
#[cfg(windows)]
wake_name: String,
```

and `Voice::new` initializes them to `None` / `"jarvis".to_string()`.
5. Add methods:

```rust
#[cfg(windows)]
fn wake_on(&mut self, on: bool) {
    if on && self.wake.is_none() {
        self.wake = Some(wake::Wake::start(self.tx.clone()));
        if let Some(w) = &self.wake { w.name(&self.wake_name); }
    }
    if let Some(w) = &self.wake { w.on(on); }
}

#[cfg(windows)]
fn wake_set_name(&mut self, word: &str) {
    let w = word.trim().to_lowercase();
    if w.is_empty() { return; }
    self.wake_name = w.clone();
    if let Some(wake) = &self.wake { wake.name(&w); }
}

#[cfg(windows)]
fn wake_take(&mut self, on: bool) {
    if let Some(w) = &self.wake { w.take_hold(on); }
}
```

6. Handle the commands in `handle()` next to `"vad"`:

```rust
Some("wake") => {
    #[cfg(windows)]
    self.wake_on(msg.get("on").and_then(Value::as_bool).unwrap_or(false));
}
Some("wake_name") => {
    #[cfg(windows)]
    if let Some(w) = msg.get("word").and_then(Value::as_str) { self.wake_set_name(w); }
}
Some("wake_hold") => {
    #[cfg(windows)]
    if let Some(w) = &self.wake { w.app_hold(msg.get("on").and_then(Value::as_bool).unwrap_or(false)); }
}
```

7. In `arm()` call `#[cfg(windows)] self.wake_take(true);` first; in `finalize()` and `cancel()`
   call `#[cfg(windows)] self.wake_take(false);`.
8. Handle `Ev::Wake` in `handle()`:

```rust
Ev::Wake => {
    #[cfg(windows)]
    self.listen_now();
}
```

`listen_now()` already returns early when a take is active.
9. New `wake.rs` (full sketch; compile-iterate allowed):

```rust
// Windows wake word: Windows' built-in recognizer listens for a two-phrase list grammar ("jarvis",
// "hey jarvis"). It runs on its own thread; a match sends Ev::Wake to the voice loop, which opens a
// normal hands-free take. No download, no cloud by us; see PRIVACY.md.
use crate::{emit, log, Ev};
use serde_json::json;
use std::sync::mpsc::{self, RecvTimeoutError, Sender};
use std::thread;
use std::time::{Duration, Instant};
use windows::core::{Ref, HSTRING};
use windows::Foundation::Collections::IIterable;
use windows::Foundation::TypedEventHandler;
use windows::Media::SpeechRecognition::{
    SpeechContinuousRecognitionCompletedEventArgs, SpeechContinuousRecognitionResultGeneratedEventArgs,
    SpeechContinuousRecognitionSession, SpeechRecognitionConfidence, SpeechRecognitionListConstraint,
    SpeechRecognizer,
};
use windows::Win32::System::WinRT::{RoInitialize, RO_INIT_MULTITHREADED};

pub fn phrases(name: &str) -> Vec<HSTRING> {
    let n = name.trim().to_lowercase();
    vec![HSTRING::from(n.as_str()), HSTRING::from(format!("hey {n}"))]
}

pub fn confident(c: SpeechRecognitionConfidence) -> bool {
    c == SpeechRecognitionConfidence::High || c == SpeechRecognitionConfidence::Medium
}

pub enum Cmd {
    On(bool),
    Name(String),
    AppHold(bool),
    TakeHold(bool),
    Ended { gen: u64, status: i32 },
    Quit,
}

pub struct Wake { tx: Sender<Cmd> }

impl Wake {
    pub fn start(ev: Sender<Ev>) -> Wake {
        let (tx, rx) = mpsc::channel();
        thread::spawn(move || run(rx, ev));
        Wake { tx }
    }
    pub fn on(&self, on: bool) { let _ = self.tx.send(Cmd::On(on)); }
    pub fn name(&self, n: &str) { let _ = self.tx.send(Cmd::Name(n.to_string())); }
    pub fn app_hold(&self, on: bool) { let _ = self.tx.send(Cmd::AppHold(on)); }
    pub fn take_hold(&self, on: bool) { let _ = self.tx.send(Cmd::TakeHold(on)); }
}

impl Drop for Wake {
    fn drop(&mut self) { let _ = self.tx.send(Cmd::Quit); }
}

struct Live { gen: u64, session: SpeechContinuousRecognitionSession, _rec: SpeechRecognizer }

fn build(name: &str, gen: u64, ev: Sender<Ev>, cmds: Sender<Cmd>) -> windows::core::Result<Live> {
    let rec = SpeechRecognizer::new()?;
    let list = SpeechRecognitionListConstraint::Create(&IIterable::from(phrases(name)))?;
    rec.Constraints()?.Append(&list)?;
    let session = rec.ContinuousRecognitionSession()?;
    let heard = TypedEventHandler::new(move |_: Ref<SpeechContinuousRecognitionSession>, a: Ref<SpeechContinuousRecognitionResultGeneratedEventArgs>| {
        if let Some(r) = a.as_ref().and_then(|a| a.Result().ok()) {
            let ok = r.Confidence().map(confident).unwrap_or(false);
            if ok && !r.Text().map(|t| t.is_empty()).unwrap_or(true) { let _ = ev.send(Ev::Wake); }
        }
        Ok(())
    });
    session.ResultGenerated(&heard)?;
    let ended = TypedEventHandler::new(move |_: Ref<SpeechContinuousRecognitionSession>, a: Ref<SpeechContinuousRecognitionCompletedEventArgs>| {
        let status = a.as_ref().and_then(|a| a.Status().ok()).map(|s| s.0).unwrap_or(-1);
        let _ = cmds.send(Cmd::Ended { gen, status });
        Ok(())
    });
    session.Completed(&ended)?;
    Ok(Live { gen, session, _rec: rec })
}

fn run(rx: mpsc::Receiver<Cmd>, ev: Sender<Ev>) {
    // SAFETY: one WinRT initialization on the thread that owns the recognizer.
    unsafe { let _ = RoInitialize(RO_INIT_MULTITHREADED); }
    let cmds = /* the sender side lives in Wake; clone it before the thread starts */;
    ...
}
```

Finish `run` with this state machine (the sketch above is intentionally incomplete there):

- `on`, `app_hold`, `take_hold`, `name`, `live: Option<Live>`, `gen`, `warned`, `retry_at`.
- `recv_timeout(250ms)` loop; `Cmd::Quit` breaks.
- On any command, recompute `want = on && !app_hold && !take_hold`.
- When `!want` and `live` is `Some`, call `session.StopAsync()` and drop it.
- When `want && live.is_none() && retry_at` has passed, `gen += 1`, call `build`, `StartAsync()`.
  On build/start error: emit `{"type":"error","code":"wake","message":…}` once per enabling
  (`warned`), log, and retry in 30 s.
- `Cmd::Ended { gen, status }`: only if the live session has that `gen`; drop it, retry in 2 s
  (Success) or warn once and retry in 10 s.
- `Cmd::TakeHold(false)` sets `retry_at = now + 2 s` (cooldown so the reply/tail can't re-wake it).
- `Cmd::Name(n)` drops the live session (next loop rebuilds with the new grammar).
- If `RoInitialize` fails, emit the `wake` error once and wait for `Cmd::Quit`.

To let `run` send `Cmd::Ended`, create the channel in `run`, not in `start`: `start` sends the
`Sender<Cmd>` back through a `oneshot`-style `mpsc` (or pass a `Sender<Cmd>` cloned into `build`,
constructed by `run`). Simplest: `Wake::start` creates `(tx, rx)`; `run` gets a clone of `tx` passed
in as an argument, so `build` can receive it.

10. Add Windows-only unit tests at the bottom of `main.rs` or `wake.rs`:

```rust
#[cfg(all(test, windows))]
mod wake_tests {
    use super::*;
    #[test] fn grammar_is_the_name_and_hey_name() {
        let p = wake::phrases("Nova");
        assert_eq!(p[0], windows::core::HSTRING::from("nova"));
        assert_eq!(p[1], windows::core::HSTRING::from("hey nova"));
    }
    #[test] fn low_confidence_does_not_wake() {
        use windows::Media::SpeechRecognition::SpeechRecognitionConfidence as C;
        assert!(wake::confident(C::High) && wake::confident(C::Medium));
        assert!(!wake::confident(C::Low) && !wake::confident(C::Rejected));
    }
}
```

11. Update `voice-win/Cargo.lock` before any `--locked` build:
    `cd showcase/tauri/src-tauri/voice-win && cargo test` (no `--locked`). Then
    `cargo test --locked` to prove the lock is current.
12. Commit: `Phase 6: Windows wake word (built-in recognizer, list grammar)`.

---

## Task 8 — PRIVACY, versions, copy

**Files:** `PRIVACY.md`, `showcase/tauri/src-tauri/tauri.conf.json`,
`showcase/tauri/src-tauri/Cargo.toml`, `showcase/panel/panel.js` (already changed in Task 5).

1. `PRIVACY.md`:
   - Line 47's microphone bullet: add “or while the wake word is on”.
   - Replace the wake bullet with:

```
- **Wake word (macOS and Windows, off by default):** when you turn it on, the microphone stays open so
  J.A.R.V.I.S can hear "Hey Jarvis", and the system shows its microphone dot the whole time. On macOS the
  phrase is matched on your Mac by Apple's on-device recognizer. On Windows, Windows' own speech recognizer
  matches it against a short phrase list; if "Online speech recognition" is on in Windows Settings, Windows
  may use Microsoft's speech service for that, so turn it off to keep it on this device. J.A.R.V.I.S keeps
  nothing and sends nothing from wake listening; the log notes only that a phrase was heard, never the words.
```

2. `tauri.conf.json` line 4: `"version": "0.6.0"`.
3. `src-tauri/Cargo.toml` line 3: `version = "0.6.0"` (the lock updates on the next cargo build).
4. Commit: `Phase 6: always-on J.A.R.V.I.S 0.6.0`.

---

## Task 9 — verify, build, install

1. `cd showcase/tauri/sidecar && npm test` — all tests pass.
2. `cd showcase/tauri/src-tauri/voice-win && cargo test` — wake tests pass; lock current.
3. Stop the running 0.5.0 if any (`Get-Process roamies* | Stop-Process`), then build the release from
   Git Bash:

```powershell
& 'C:\Program Files\Git\bin\bash.exe' 'C:\Users\kiank\AppData\Local\Temp\opencode\build-phase1.sh'
```

Wait for `J.A.R.V.I.S_0.6.0_x64-setup.exe` in `src-tauri\target\release\bundle\nsis`.
4. Install silently and wait:

```powershell
Start-Process -FilePath 'C:\Users\kiank\Roamies\showcase\tauri\src-tauri\target\release\bundle\nsis\J.A.R.V.I.S_0.6.0_x64-setup.exe' -ArgumentList '/S' -Wait
```

5. Set this install's config before launch (`C:\Users\kiank\.gg\sidekick.json`): `"alwaysAware": true`,
   `"wakeWord": true` (keep every other saved value).
6. Launch `%LOCALAPPDATA%\J.A.R.V.I.S\roamies.exe`; confirm the log
   `C:\Users\kiank\.gg\sidekick\logs\2026-11-17.log` has `start {"version":"0.6.0"}` and a voice
   `ready` after it.
7. Manual checks, in order:
   - Panel → Listening shows **Wake word** and **Wake word name** (`Hey Jarvis`).
   - Say “Jarvis” with no keys → the listening pill opens; ask “what is my latest download?” → the
     newest file in `~/Downloads` is named with its time.
   - Say “Jarvis, when is the next Portugal game?” → the reply cites a current source, not memory.
   - While the reply is spoken, say “Jarvis” → it does not wake itself.
   - Turn the wake toggle off → the microphone is released.
8. Commit any build-version lock changes: `Phase 6: 0.6.0 lockfile`.
9. Report: what changed, test output, install log lines, and the two manual answers.

---

## Notes for the implementer

- Keep `MAC` vs `WIN` gates: macOS behavior must not change. `LINUX` never gets wake.
- `listen_now()` already handles “already in a take” and emits the listening state; do not duplicate it.
- The wake thread must never print what was heard. Only `Ev::Wake` (no text) reaches the app.
- `shortcut: on Windows the words after "Jarvis" in the same breath may be clipped by the take start; a pre-roll
  audio buffer is the upgrade if this proves annoying in daily use.`
- If `windows` crate compilation fights the handler signatures, adjust `Ref<T>`/`Option<&T>` usage to the
  compiler's suggestion; the rest of the design stands.
