// Voice helper for Roamies on Windows and Linux: the twin of voice/main.swift, with the same JSON lines in and out.
// Watches the talk chord (GetAsyncKeyState on Windows, the X server on Linux X11 sessions; neither needs a
// permission), records the default microphone and
// transcribes on this PC with NVIDIA Parakeet TDT 0.6B v3 (int8 ONNX via parakeet-rs). Parakeet isn't a
// streaming model, so live text comes from re-reading the take about once a second.
// Hold the chord = push-to-talk (release sends). Quick tap = hands-free (ends on a pause or another tap).
// While the chord is held, moving the cursor round something circles it (ink.rs); the circled area goes out with
// what was said, as on macOS (Windows only). On Wayland no app can watch the keyboard, so there {"cmd":"toggle"}
// (sent for `roamies --talk`, which people bind to a key) starts a take, and sends it when it comes again or on a
// pause. Exits when stdin closes.
//
// roamies-voice --model <dir> [--chord control,option]   normal use (Roamies starts it)
// roamies-voice --perms                                   prints {"type":"perms","mic":…}
// roamies-voice --devices                                 prints {"type":"devices",…}: every mic, the default, formats
// roamies-voice --model <dir> --transcribe <wav>          dev: transcribe a file and exit
// roamies-voice --model <dir> --test-audio <wav>          dev: a file stands in for the mic ({"cmd":"listen"} starts)

mod audio;
mod ink;
mod keys;

use audio::{MicError, Sink, Source};
use parakeet_rs::{ExecutionConfig, ParakeetTDT, Transcriber};
use serde_json::{json, Value};
use std::io::{BufRead, Write};
use std::path::{Path, PathBuf};
use std::sync::mpsc::{self, Receiver, RecvTimeoutError, Sender};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::{Duration, Instant};

pub const RATE: u32 = 16_000;

pub fn emit(v: Value) {
    let mut out = std::io::stdout().lock();
    let _ = writeln!(out, "{v}");
    let _ = out.flush();
}

pub fn log(s: &str) {
    eprintln!("[voice] {s}");
}

/// The error the app shows when the microphone can't be used; `reason` picks what the Roamie says.
fn mic_error(e: &MicError) -> Value {
    json!({ "type": "error", "code": "no_input", "reason": e.reason, "message": e.detail })
}

pub enum Ev {
    Cmd(Value),
    StdinClosed,
    Level(f64),
    AudioFailed(MicError),
    Text { take: u64, text: String, last: bool },
    EngineFailed(String),
    Wake,
}

// ---------- transcription (its own thread: loading and reading never stall the hotkey loop) ----------

struct Job {
    take: u64,
    audio: Vec<f32>,
    last: bool,
    // Some(name): a wake-word listen. Its text is matched in the engine thread and never sent on.
    wake: Option<String>,
}

fn model_present(dir: &Path) -> bool {
    dir.join("vocab.txt").is_file() && dir.join("encoder-model.int8.onnx").is_file() && dir.join("decoder_joint-model.int8.onnx").is_file()
}

fn load_model(dir: &Path) -> Result<ParakeetTDT, String> {
    // Half the cores: quick enough to read a minute of speech in a second or two, without starving the PC.
    let threads = thread::available_parallelism().map(|n| n.get() / 2).unwrap_or(2).clamp(1, 8);
    let t0 = Instant::now();
    let env = parakeet_rs::ort::init().with_name("roamies-voice").build().map_err(|e| e.to_string())?;
    let config = ExecutionConfig::new().with_environment(env).with_intra_threads(threads);
    let mut asr = ParakeetTDT::from_pretrained(dir, Some(config)).map_err(|e| e.to_string())?;
    // One short warm-up run, so the first real request doesn't pay for ONNX Runtime's setup.
    let _ = asr.transcribe_samples(vec![0.0; RATE as usize / 2], RATE, 1, None);
    log(&format!("model ready in {:.1}s ({threads} threads)", t0.elapsed().as_secs_f64()));
    Ok(asr)
}

fn transcribe(asr: &mut ParakeetTDT, audio: Vec<f32>) -> String {
    if audio.len() < RATE as usize / 5 {
        return String::new();
    }
    match asr.transcribe_samples(audio, RATE, 1, None) {
        Ok(r) => r.text.split_whitespace().collect::<Vec<_>>().join(" "),
        Err(e) => {
            log(&format!("transcribe: {e}"));
            String::new()
        }
    }
}

fn spawn_engine(dir: PathBuf, tx: Sender<Ev>) -> (Sender<Job>, thread::JoinHandle<()>) {
    let (jtx, jrx) = mpsc::channel::<Job>();
    let handle = thread::spawn(move || {
        let mut asr = match load_model(&dir) {
            Ok(a) => a,
            Err(e) => {
                log(&format!("model failed to load: {e}"));
                let _ = tx.send(Ev::EngineFailed(e));
                return;
            }
        };
        while let Ok(first) = jrx.recv() {
            // Only the newest live read matters; a closing read always runs. A take's read comes before a wake
            // listen, so the wake word never makes a take wait.
            let mut jobs = vec![first];
            jobs.extend(jrx.try_iter());
            let job = match jobs.iter().rposition(|j| j.last) {
                Some(i) => jobs.swap_remove(i),
                None => match jobs.iter().rposition(|j| j.wake.is_none()) {
                    Some(i) => jobs.swap_remove(i),
                    None => jobs.pop().expect("at least one job"),
                },
            };
            if let Some(name) = job.wake {
                // A wake listen: only the match leaves this thread, never the words.
                if woke(&transcribe(&mut asr, job.audio), &name) {
                    log("wake word heard");
                    if tx.send(Ev::Wake).is_err() { return; }
                }
                continue;
            }
            let text = transcribe(&mut asr, job.audio);
            if tx.send(Ev::Text { take: job.take, text, last: job.last }).is_err() {
                return;
            }
        }
    });
    (jtx, handle)
}

// ---------- the talk session (port of the Voice class in voice/main.swift) ----------

#[derive(Clone, Copy, PartialEq, Debug)]
enum Phase {
    Idle,
    Armed,
    Holding,
    HandsFree,
    Finishing,
}

const TAP_LIMIT: f64 = 0.25;
// A release must last this long to count, so one glitchy frame of key state can't end a session.
const RELEASE_DEBOUNCE: f64 = 0.09;
// Hands-free: how much silence ends a take (the panel's "Pause to send", 0.5 to 4.0 s; this is the Normal default).
const PAUSE_ENDS: f64 = 1.5;
const MAX_SESSION: f64 = 60.0;
// Keep the mic open a moment after release so a word said while letting go isn't clipped.
const TAIL: f64 = 0.3;
const FINAL_TIMEOUT: f64 = 30.0;
const READ_EVERY: f64 = 0.8;
// Parakeet makes up words ("Thank you.") from silence, so a take is only read once the mic heard a voice:
// about -49 dBFS, above room noise and below quiet speech. The panel's "Mic sensitivity" tunes this.
const SPEECH_LEVEL: f64 = 0.15;
// Hands-free, a take also ends once this much more sound came in without new words: steady noise or a voice in the
// background can keep the level up, but it doesn't keep adding to what was said (#64).
const STALE_ENDS: f64 = 4.0;
// Wake word: how much of the last thing said one read covers, and how often a read runs while there's voice.
const WAKE_WINDOW: f64 = 2.5;
const WAKE_EVERY: f64 = 1.0;

/// The room's steady noise on the level scale, so background noise (a fan, a TV, a busy room) doesn't count as talking
/// and keep a hands-free take open (#64). It starts at the take's first reading, falls almost at once to a quieter
/// level and rises slowly to a louder one: speech dips between words, so it barely moves the floor, while noise that
/// stays up soon becomes it.
struct NoiseFloor {
    level: f64,
    at: Option<f64>,
    voice: f64, // the bar a voice has to clear over the room; the panel's Mic sensitivity sets it
}

impl Default for NoiseFloor {
    fn default() -> NoiseFloor {
        NoiseFloor { level: 0.0, at: None, voice: Self::VOICE }
    }
}

impl NoiseFloor {
    const FALL: f64 = 0.05;
    const RISE: f64 = 4.0;
    // A voice is at least this far above the floor (0.25 is 10 dB) and above the bar the config sets.
    const ABOVE: f64 = 0.25;
    const VOICE: f64 = 0.2;

    /// Takes the next level reading; true when it's loud enough over the room to be someone talking.
    fn is_voice(&mut self, v: f64, now: f64) -> bool {
        let Some(at) = self.at.replace(now) else {
            self.level = v;
            return v > self.voice;
        };
        let dt = (now - at).clamp(0.0, 1.0);
        let voice = v > self.voice.max(self.level + Self::ABOVE);
        let tau = if v < self.level { Self::FALL } else { Self::RISE };
        self.level += (v - self.level) * (dt / tau).min(1.0);
        voice
    }
}

/// What was said, ignoring case and punctuation: a re-read that only moves a comma isn't new words.
fn words(text: &str) -> String {
    text.chars().filter(|c| c.is_alphanumeric() || c.is_whitespace()).flat_map(char::to_lowercase).collect::<String>().split_whitespace().collect::<Vec<_>>().join(" ")
}

/// Whether a wake listen heard the name as a word of its own ("Jarvis", "hey Jarvis", …). The name is one word
/// (wakename.mjs allows no spaces), so a plain token match is enough and can't be fooled by "jarvison".
fn woke(text: &str, name: &str) -> bool {
    let name = name.trim().to_lowercase();
    !name.is_empty() && words(text).split(' ').any(|w| w == name)
}

/// The take's words with the name taken off the front: a wake listen already heard "Jarvis, what's my latest
/// download?", and the request is what came after the name. A leading "hey" is left alone on purpose.
fn without_wake(text: &str, name: &str) -> String {
    let name = name.trim().to_lowercase();
    let s = text.trim_start();
    let end = s.find(char::is_whitespace).unwrap_or(s.len());
    if name.is_empty() || words(&s[..end]) != name {
        return text.to_string();
    }
    s[end..].trim_start_matches(|c: char| c.is_whitespace() || c.is_ascii_punctuation()).to_string()
}

struct Voice {
    phase: Phase,
    chord: u8,
    chord_at: f64,
    listen_at: f64,
    heard_at: f64,
    voice_at: f64,
    floor: NoiseFloor,
    // The hands-free behaviour the panel asks for: whether a quick tap starts a hands-free take, how many seconds
    // of silence end it, and how loud over the room it has to be to count as talking.
    handsfree: bool,
    pause_ends: f64,
    speech_level: f64,
    level_at: f64,
    released_at: Option<f64>,
    blocked: bool,
    prev_chord: bool,
    report_empty: bool,
    spoke: bool,
    best: String,
    // Each session gets a new take number; results for older takes are ignored.
    take: u64,
    buf: Arc<Mutex<Vec<f32>>>,
    source: Option<Source>,
    engine: Option<Sender<Job>>,
    engine_error: Option<String>,
    reading: bool,
    read_at: f64,
    read_len: usize,
    // How much of the take had come in when its words last changed.
    heard_len: usize,
    tail_until: Option<f64>,
    final_until: Option<f64>,
    test_audio: Option<PathBuf>,
    ink: ink::Ink,
    tx: Sender<Ev>,
    // Wake word (Windows): the mic listens quietly while idle, and a short read that says the name starts a take.
    wake_on: bool,
    wake_hold: bool,
    wake_name: String,
    wake_buf: Arc<Mutex<Vec<f32>>>,
    wake_src: Option<Source>,
    wake_at: f64,
    wake_voice_at: f64,
    wake_cooldown: f64,
    wake_bad: bool,
    wake_floor: NoiseFloor,
    // A wake-started take begins with the audio that was already read, including the name: drop the name from
    // the text so "Jarvis, what's my latest download?" is the request, not a request to talk to "Jarvis".
    strip_wake: bool,
    t0: Instant,
}

impl Voice {
    fn new(engine: Option<Sender<Job>>, test_audio: Option<PathBuf>, tx: Sender<Ev>) -> Voice {
        Voice {
            phase: Phase::Idle,
            chord: keys::mask(&["control".into(), "option".into()]).expect("default chord"),
            chord_at: 0.0,
            listen_at: 0.0,
            heard_at: 0.0,
            voice_at: 0.0,
            floor: NoiseFloor::default(),
            handsfree: true,
            pause_ends: PAUSE_ENDS,
            speech_level: SPEECH_LEVEL,
            level_at: 0.0,
            released_at: None,
            blocked: false,
            prev_chord: false,
            report_empty: false,
            spoke: false,
            best: String::new(),
            take: 0,
            buf: Arc::new(Mutex::new(Vec::new())),
            source: None,
            engine,
            engine_error: None,
            reading: false,
            read_at: 0.0,
            read_len: 0,
            heard_len: 0,
            tail_until: None,
            final_until: None,
            test_audio,
            ink: ink::Ink::default(),
            tx,
            wake_on: false,
            wake_hold: false,
            wake_name: "jarvis".to_string(),
            wake_buf: Arc::new(Mutex::new(Vec::new())),
            wake_src: None,
            wake_at: 0.0,
            wake_voice_at: 0.0,
            wake_cooldown: 0.0,
            wake_bad: false,
            wake_floor: NoiseFloor::default(),
            strip_wake: false,
            t0: Instant::now(),
        }
    }

    fn wake_on(&mut self, on: bool) {
        if self.wake_on == on { return; }
        self.wake_on = on;
        self.wake_bad = false;
        self.wake_cooldown = 0.0;
        if !on { self.wake_stop(); }
    }

    fn wake_set_name(&mut self, word: &str) {
        let w = word.trim().to_lowercase();
        if w.is_empty() { return; }
        self.wake_name = w;
        self.wake_stop(); // the next listen matches the new name
    }

    fn wake_hush(&mut self, on: bool) {
        self.wake_hold = on;
        self.wake_stop();
        // Let the reply's last words die away before listening again, so it can't wake itself.
        if !on { self.wake_cooldown = self.now() + 1.0; }
    }

    fn wake_take(&mut self, on: bool) {
        self.wake_stop();
        // The request's tail (and then the reply) is still in the air: wait it out.
        if !on { self.wake_cooldown = self.now() + 2.0; }
    }

    fn now(&self) -> f64 {
        self.t0.elapsed().as_secs_f64()
    }

    fn set_chord(&mut self, names: &[String]) {
        let Some(m) = keys::mask(names) else { return log(&format!("ignored chord {names:?}")) };
        if self.phase != Phase::Idle {
            self.cancel();
        }
        self.chord = m;
        self.blocked = true;
        log(&format!("talk chord: {}", names.join("+")));
    }

    fn tick(&mut self) {
        let now = self.now();
        self.tick_keys(now);
        self.wake_tick(now);
        self.ink.set_armed(matches!(self.phase, Phase::Armed | Phase::Holding), now);
        self.ink.follow(now);
        match self.phase {
            Phase::Holding | Phase::HandsFree => self.maybe_read(now),
            Phase::Finishing => {
                if self.tail_until.is_some_and(|t| now >= t) {
                    self.tail_until = None;
                    self.close_take(now);
                } else if self.final_until.is_some_and(|t| now >= t) {
                    log("final read timed out");
                    self.finalize();
                }
            }
            _ => {}
        }
    }

    fn tick_keys(&mut self, now: f64) {
        let f = keys::held();
        let held = f.mods & self.chord;
        let down = held == self.chord; // once talking, a stray extra modifier doesn't count as letting go
        let extra = f.mods & !self.chord != 0 || f.altgr;
        let chord = down && !extra;
        let prev = self.prev_chord;
        self.prev_chord = chord;
        if held == 0 {
            self.blocked = false;
        }
        let released = if down {
            self.released_at = None;
            false
        } else {
            let at = *self.released_at.get_or_insert(now);
            now - at >= RELEASE_DEBOUNCE
        };

        match self.phase {
            Phase::Idle => {
                if chord && !prev && !self.blocked {
                    self.arm(now);
                }
            }
            Phase::Armed => {
                // Only the first moment decides shortcut vs. talk: the chord plus a key or another modifier is a shortcut.
                if down && (extra || keys::other_key_down()) {
                    log("not a talk: the chord was part of a shortcut");
                    self.cancel();
                    self.blocked = true;
                } else if released {
                    if self.handsfree {
                        self.phase = Phase::HandsFree;
                        self.show_listening("handsfree", now);
                    } else {
                        // Push to talk: a quick tap is not a take; only holding talks.
                        log("tap ignored (push to talk)");
                        self.phase = Phase::Idle;
                        self.released_at = None;
                    }
                } else if down && now - self.chord_at >= TAP_LIMIT {
                    self.phase = Phase::Holding;
                    self.show_listening("hold", now);
                }
            }
            Phase::Holding => {
                if released {
                    self.end("released", now);
                    self.finish();
                } else if now - self.listen_at > MAX_SESSION {
                    self.end("max length", now);
                    self.finish();
                }
            }
            Phase::HandsFree => {
                // Pressing again switches to push-to-talk; letting go then sends.
                if chord && !prev && !self.blocked {
                    self.phase = Phase::Holding;
                    self.released_at = None;
                    return;
                }
                let quiet = now - self.heard_at.max(self.voice_at);
                let stale = self.read_len.saturating_sub(self.heard_len) as f64 / RATE as f64;
                if !self.best.is_empty() && quiet > self.pause_ends {
                    self.end("pause", now);
                    self.finish();
                } else if !self.best.is_empty() && stale > STALE_ENDS {
                    self.end("no new words", now);
                    self.finish();
                } else if self.best.is_empty() && !self.reading && now - self.listen_at > 8.0 && now - self.voice_at > self.pause_ends {
                    self.end("nothing heard", now);
                    self.cancel();
                } else if now - self.listen_at > MAX_SESSION {
                    self.end("max length", now);
                    self.finish();
                }
            }
            Phase::Finishing => {}
        }
    }

    fn end(&self, why: &str, now: f64) {
        log(&format!("session end: {why} after {:.1}s", now - self.listen_at));
    }

    fn arm(&mut self, now: f64) {
        self.wake_take(true); // the mic is this take's now: stop listening for the wake word
        self.strip_wake = false;
        self.phase = Phase::Armed;
        self.chord_at = now;
        self.best.clear();
        self.spoke = false;
        self.take += 1;
        self.reading = false;
        self.read_len = 0;
        self.heard_len = 0;
        // Start the mic now so the first word isn't lost (a shortcut cancels it a moment later).
        if self.engine.is_some() && keys::mic_allowed() {
            self.start_audio();
        }
    }

    fn show_listening(&mut self, mode: &str, now: f64) {
        self.listen_at = now;
        self.heard_at = now;
        self.voice_at = now;
        self.read_at = now;
        if self.engine.is_none() {
            let code = if self.engine_error.is_some() { "recognition" } else { "model_missing" };
            emit(json!({ "type": "error", "code": code, "message": self.engine_error.clone().unwrap_or_default() }));
            return self.cancel();
        }
        if !keys::mic_allowed() {
            emit(json!({ "type": "error", "code": "permission", "what": "microphone" }));
            return self.cancel();
        }
        if self.source.is_none() {
            self.start_audio();
            if self.phase == Phase::Idle {
                return;
            }
        }
        emit(json!({ "type": "state", "state": "listening", "mode": mode }));
        if !self.best.is_empty() {
            emit(json!({ "type": "partial", "text": self.best }));
        }
    }

    fn start_audio(&mut self) {
        self.buf.lock().unwrap().clear();
        let bar = self.floor.voice; // keep the configured Mic sensitivity across takes
        self.floor = NoiseFloor { level: 0.0, at: None, voice: bar };
        let sink = Sink::new(self.buf.clone(), self.tx.clone());
        let started = match &self.test_audio {
            Some(p) => audio::play_file(p, sink).map_err(|e| MicError::new("failed", e)),
            None => audio::open_mic(sink),
        };
        match started {
            Ok(s) => self.source = Some(s),
            Err(e) => {
                log(&format!("audio: {} ({})", e.detail, e.reason));
                emit(mic_error(&e));
                self.cancel();
            }
        }
    }

    fn stop_audio(&mut self) {
        self.source = None;
    }

    // Wake word: while idle, the mic listens quietly, and after each second of voice the last window is read by the
    // same on-device model that hears requests. A read that says the name sends Ev::Wake and a take opens.
    fn wake_tick(&mut self, now: f64) {
        let want = self.wake_on && !self.wake_hold && self.phase == Phase::Idle && now >= self.wake_cooldown;
        if !want {
            if self.wake_src.is_some() { self.wake_stop(); }
            return;
        }
        let engine = match &self.engine { Some(e) => e.clone(), None => return };
        if self.wake_src.is_none() {
            if !keys::mic_allowed() { return self.wake_problem(now, "microphone blocked"); }
            self.wake_buf.lock().unwrap().clear();
            self.wake_floor = NoiseFloor { level: 0.0, at: None, voice: self.speech_level };
            let sink = Sink::new(self.wake_buf.clone(), self.tx.clone());
            match audio::open_mic(sink) {
                Ok(s) => {
                    self.wake_src = Some(s);
                    self.wake_at = now;
                    self.wake_voice_at = now;
                    if self.wake_bad {
                        // Recovered: the panel can stop showing the wake problem.
                        self.wake_bad = false;
                        emit(json!({ "type": "wake_ok" }));
                        log("wake listening again");
                    } else {
                        log("wake listening");
                    }
                }
                Err(e) => {
                    log(&format!("wake audio: {} ({})", e.detail, e.reason));
                    self.wake_problem(now, &e.detail);
                }
            }
            return;
        }
        // Keep the buffer at the last window even while the room is quiet, so it can't grow for hours.
        let window = (RATE as f64 * WAKE_WINDOW) as usize;
        let audio = {
            let mut b = self.wake_buf.lock().unwrap();
            if b.len() > window {
                let cut = b.len() - window;
                b.drain(..cut);
            }
            if now - self.wake_at < WAKE_EVERY || now - self.wake_voice_at > 1.5 || b.len() < RATE as usize / 2 {
                return;
            }
            self.wake_at = now;
            b.clone()
        };
        let _ = engine.send(Job { take: 0, audio, last: false, wake: Some(self.wake_name.clone()) });
    }

    fn wake_stop(&mut self) {
        self.wake_src = None;
        self.wake_buf.lock().unwrap().clear();
    }

    // Say it once per enabling; the panel shows the wake problem until it's turned off and on again.
    fn wake_problem(&mut self, now: f64, why: &str) {
        self.wake_src = None;
        self.wake_cooldown = now + 30.0;
        if self.wake_bad { return; }
        self.wake_bad = true;
        emit(json!({ "type": "error", "code": "wake", "message": why }));
    }

    // While listening: re-read the whole take now and then, for live text and pause detection.
    fn maybe_read(&mut self, now: f64) {
        let Some(engine) = &self.engine else { return };
        if !self.spoke || self.reading || now - self.read_at < READ_EVERY {
            return;
        }
        let audio = self.buf.lock().unwrap().clone();
        if audio.len() < RATE as usize / 2 || audio.len() < self.read_len + RATE as usize * 3 / 10 {
            return;
        }
        self.read_at = now;
        self.read_len = audio.len();
        self.reading = engine.send(Job { take: self.take, audio, last: false, wake: None }).is_ok();
    }

    fn finish(&mut self) {
        if !matches!(self.phase, Phase::Armed | Phase::Holding | Phase::HandsFree) {
            return;
        }
        let shown = self.phase != Phase::Armed;
        self.report_empty = shown;
        self.phase = Phase::Finishing;
        self.ink.capture(self.now());
        if shown {
            emit(json!({ "type": "state", "state": "processing" }));
        }
        if self.source.is_none() {
            return self.finalize();
        }
        self.tail_until = Some(self.now() + TAIL);
    }

    // Mic off, then one last read of the whole take; its result ends the session.
    fn close_take(&mut self, now: f64) {
        self.stop_audio();
        let audio = std::mem::take(&mut *self.buf.lock().unwrap());
        match &self.engine {
            Some(engine) if self.spoke && engine.send(Job { take: self.take, audio, last: true, wake: None }).is_ok() => self.final_until = Some(now + FINAL_TIMEOUT),
            _ => self.finalize(),
        }
    }

    fn on_text(&mut self, take: u64, text: String, last: bool) {
        if take != self.take {
            return;
        }
        let text = if self.strip_wake { without_wake(&text, &self.wake_name) } else { text };
        if !last {
            self.reading = false;
        }
        // A closing read that came back empty keeps whatever the live reads heard.
        if !text.is_empty() && text != self.best {
            if words(&text) != words(&self.best) {
                self.heard_at = self.now();
                if !last {
                    self.heard_len = self.read_len;
                }
            }
            self.best = text;
            if !matches!(self.phase, Phase::Idle | Phase::Armed) {
                emit(json!({ "type": "partial", "text": self.best }));
            }
        }
        if last && self.phase == Phase::Finishing {
            self.finalize();
        }
    }

    fn on_level(&mut self, v: f64) {
        let now = self.now();
        // A voice during a wake listen: the read that follows covers it.
        if self.wake_src.is_some() && self.wake_floor.is_voice(v, now) { self.wake_voice_at = now; }
        if self.floor.is_voice(v, now) {
            self.voice_at = now;
        }
        if v > self.speech_level && self.phase != Phase::Idle {
            self.spoke = true;
        }
        if !matches!(self.phase, Phase::Holding | Phase::HandsFree) || now - self.level_at < 0.05 {
            return;
        }
        self.level_at = now;
        emit(json!({ "type": "level", "v": (v * 100.0).round() / 100.0 }));
    }

    fn finalize(&mut self) {
        if self.phase != Phase::Finishing {
            return;
        }
        self.stop_audio();
        self.wake_take(false);
        self.tail_until = None;
        self.final_until = None;
        self.take += 1;
        self.phase = Phase::Idle;
        let text = self.best.trim().to_string();
        let area = self.ink.take();
        if !text.is_empty() {
            // What was circled on screen while talking rides along with the words.
            let mut msg = json!({ "type": "final", "text": text });
            if let Some(a) = area {
                msg["area"] = a;
                log("sent what was said, with the circled area");
            }
            emit(msg);
        } else if let Some(f) = area.as_ref().and_then(|a| a["file"].as_str()) {
            // Circled something but said nothing: drop it quietly (no "I didn't hear you").
            let _ = std::fs::remove_file(f);
            log("nothing said, dropped the circled area");
            self.report_empty = false;
        }
        emit(json!({ "type": "state", "state": "idle" }));
        // Listened but got no words: say so instead of closing silently.
        if text.is_empty() && self.report_empty {
            emit(json!({ "type": "error", "code": "nothing_heard", "spoke": self.voice_at > self.listen_at + 0.05 }));
        }
        self.report_empty = false;
    }

    fn cancel(&mut self) {
        self.stop_audio();
        self.wake_take(false);
        self.buf.lock().unwrap().clear();
        self.tail_until = None;
        self.final_until = None;
        self.take += 1;
        self.reading = false;
        self.phase = Phase::Idle;
        self.report_empty = false;
        let now = self.now();
        self.ink.clear(now);
        emit(json!({ "type": "state", "state": "idle", "cancelled": true }));
    }

    /// Start listening hands-free without a key press (after an area snap). Ends on a pause or a tap.
    fn listen_now(&mut self) {
        if self.phase != Phase::Idle {
            return;
        }
        let now = self.now();
        self.arm(now);
        self.phase = Phase::HandsFree;
        self.blocked = true; // the snap shortcut's keys may still be held: don't read them as a tap
        self.show_listening("handsfree", now);
    }

    /// The wake word was heard: open a take that already holds what was said after the name, so a quick
    /// "Jarvis, what's my latest download?" isn't cut down to "what's my latest download?" missing its start.
    fn wake_start(&mut self) {
        let heard = std::mem::take(&mut *self.wake_buf.lock().unwrap());
        self.listen_now();
        if self.phase != Phase::HandsFree || heard.is_empty() {
            return;
        }
        {
            let mut buf = self.buf.lock().unwrap();
            buf.splice(0..0, heard);
        }
        self.spoke = true; // the carried words are speech, even if the room is quiet now
        self.strip_wake = true;
        self.read_at = 0.0; // read them now, not a second from now
    }

    /// The talk shortcut where the keys can't be watched (`roamies --talk`): the first one starts listening
    /// hands-free, the next one sends what was said (so does a pause).
    fn toggle(&mut self) {
        match self.phase {
            Phase::Idle => self.listen_now(),
            Phase::Armed | Phase::Holding | Phase::HandsFree => {
                let now = self.now();
                self.end("toggled", now);
                self.finish();
            }
            Phase::Finishing => {}
        }
    }

    /// Roamies saw its show/hide shortcut: that chord press was a shortcut, not a request to talk.
    fn external_cancel(&mut self) {
        if matches!(self.phase, Phase::Armed | Phase::Holding | Phase::HandsFree) {
            self.cancel();
        }
        self.blocked = true;
    }

    /// Returns true when Roamies has gone (stdin closed) and the helper should exit.
    fn handle(&mut self, ev: Ev) -> bool {
        match ev {
            Ev::Cmd(msg) => match msg.get("cmd").and_then(Value::as_str) {
                Some("cancel") => self.external_cancel(),
                Some("listen") => self.listen_now(),
                Some("toggle") => self.toggle(),
                // The panel's mic picker: the list, and a pick (a name from it; none or "" is the default), used from the
                // next time the mic opens.
                Some("mics") => emit(audio::mics()),
                Some("mic") => {
                    let id = msg.get("id").and_then(Value::as_str).filter(|s| !s.is_empty()).map(str::to_owned);
                    log(&format!("mic: {}", id.as_deref().unwrap_or("default")));
                    *audio::CHOSEN.lock().unwrap() = id;
                }
                Some("chord") => {
                    let mods: Vec<String> = msg.get("mods").and_then(Value::as_array).map(|a| a.iter().filter_map(|v| v.as_str().map(str::to_owned)).collect()).unwrap_or_default();
                    self.set_chord(&mods);
                }
                // The panel's voice settings, applied to whatever the helper is doing: hands-free tap-to-talk on or
                // off, the pause that ends a hands-free take, and mic sensitivity (the bar a voice must clear over
                // the room).
                Some("vad") => {
                    if let Some(b) = msg.get("handsfree").and_then(Value::as_bool) { self.handsfree = b; }
                    if let Some(p) = msg.get("pause").and_then(Value::as_f64) { self.pause_ends = p.clamp(0.5, 4.0); }
                    if let Some(bar) = msg.get("voice").and_then(Value::as_f64) { self.floor.voice = bar.clamp(0.01, 1.0); }
                    if let Some(sp) = msg.get("level").and_then(Value::as_f64) { self.speech_level = sp.clamp(0.01, 1.0); }
                    log(&format!("vad: handsfree {}, pause {:.2}s, voice bar {:.2}, floor {:.2}", self.handsfree, self.pause_ends, self.floor.voice, self.speech_level));
                }
                // Wake word: on/off, the name it listens for, and quiet while a reply runs.
                Some("wake") => self.wake_on(msg.get("on").and_then(Value::as_bool).unwrap_or(false)),
                Some("wake_name") => {
                    if let Some(w) = msg.get("word").and_then(Value::as_str) { self.wake_set_name(w); }
                }
                Some("wake_hold") => self.wake_hush(msg.get("on").and_then(Value::as_bool).unwrap_or(false)),
                // Muting the speakers while listening is macOS-only for now.
                _ => {}
            },
            Ev::StdinClosed => return true,
            Ev::Level(v) => self.on_level(v),
            Ev::AudioFailed(e) => {
                log(&format!("audio stream: {} ({})", e.detail, e.reason));
                if matches!(self.phase, Phase::Armed | Phase::Holding | Phase::HandsFree) {
                    emit(mic_error(&e));
                    self.cancel();
                }
            }
            Ev::Text { take, text, last } => self.on_text(take, text, last),
            Ev::EngineFailed(e) => {
                self.engine = None;
                self.engine_error = Some(e);
            }
            Ev::Wake => self.wake_start(),
        }
        false
    }
}

fn arg(args: &[String], name: &str) -> Option<String> {
    args.iter().position(|a| a == name).and_then(|i| args.get(i + 1)).cloned()
}

fn main() {
    let args: Vec<String> = std::env::args().collect();
    if args.iter().any(|a| a == "--perms") {
        emit(json!({ "type": "perms", "mic": if keys::mic_allowed() { "granted" } else { "denied" }, "input": audio::has_input() }));
        return;
    }
    if args.iter().any(|a| a == "--devices") {
        let mut v = audio::devices();
        v["mic_allowed"] = json!(keys::mic_allowed());
        emit(v);
        return;
    }
    let model = arg(&args, "--model").map(PathBuf::from);
    // Cursor positions and captures in real pixels on every monitor (ink.rs turns them into screen points).
    #[cfg(windows)]
    // SAFETY: a plain call at startup, before any window or thread exists.
    unsafe {
        windows_sys::Win32::UI::HiDpi::SetProcessDpiAwarenessContext(windows_sys::Win32::UI::HiDpi::DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2);
    }

    if let Some(wav) = arg(&args, "--transcribe") {
        let dir = model.expect("--transcribe needs --model <dir>");
        let mut asr = load_model(&dir).unwrap_or_else(|e| panic!("model: {e}"));
        let (samples, rate) = audio::read_wav(Path::new(&wav)).unwrap_or_else(|e| panic!("{wav}: {e}"));
        let t0 = Instant::now();
        let text = transcribe(&mut asr, samples.clone());
        emit(json!({ "text": text, "seconds": (t0.elapsed().as_secs_f64() * 100.0).round() / 100.0, "audio": samples.len() as f64 / rate as f64 }));
        return;
    }

    let (tx, rx): (Sender<Ev>, Receiver<Ev>) = mpsc::channel();
    let (engine, engine_thread) = match &model {
        Some(dir) if model_present(dir) => {
            let (jobs, handle) = spawn_engine(dir.clone(), tx.clone());
            (Some(jobs), Some(handle))
        }
        _ => {
            log("speech model not downloaded yet");
            (None, None)
        }
    };
    let mut voice = Voice::new(engine, arg(&args, "--test-audio").map(PathBuf::from), tx.clone());
    if let Some(c) = arg(&args, "--chord") {
        voice.set_chord(&c.split(',').map(str::to_owned).collect::<Vec<_>>());
    }

    let stdin_tx = tx.clone();
    thread::spawn(move || {
        for line in std::io::stdin().lock().lines().map_while(Result::ok) {
            if let Ok(v) = serde_json::from_str::<Value>(&line) {
                let _ = stdin_tx.send(Ev::Cmd(v));
            }
        }
        let _ = stdin_tx.send(Ev::StdinClosed);
    });

    emit(json!({ "type": "ready", "engine": "parakeet", "model": voice.engine.is_some() }));
    loop {
        let quit = match rx.recv_timeout(Duration::from_millis(16)) {
            Ok(ev) => {
                let mut quit = voice.handle(ev);
                while let Ok(ev) = rx.try_recv() {
                    quit |= voice.handle(ev);
                }
                quit
            }
            Err(RecvTimeoutError::Timeout) => false,
            Err(RecvTimeoutError::Disconnected) => true,
        };
        if quit {
            break;
        }
        voice.tick();
    }
    // Let the engine thread finish (a model still loading included) before exiting: tearing ONNX Runtime
    // down under it crashes.
    drop(voice);
    if let Some(h) = engine_thread {
        let _ = h.join();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    // A Voice with a stand-in engine (the test reads its jobs) and a short WAV in place of the microphone.
    fn voice() -> (Voice, Receiver<Job>, PathBuf) {
        static N: std::sync::atomic::AtomicUsize = std::sync::atomic::AtomicUsize::new(0);
        let wav = std::env::temp_dir().join(format!("roamies-voice-test-{}-{}.wav", std::process::id(), N.fetch_add(1, std::sync::atomic::Ordering::Relaxed)));
        let spec = hound::WavSpec { channels: 1, sample_rate: RATE, bits_per_sample: 16, sample_format: hound::SampleFormat::Int };
        let mut w = hound::WavWriter::create(&wav, spec).expect("test wav");
        for i in 0..RATE / 2 {
            w.write_sample(((i as f32 * 0.2).sin() * 8000.0) as i16).expect("sample");
        }
        w.finalize().expect("wav written");
        let (jobs, jrx) = mpsc::channel();
        let (tx, _events) = mpsc::channel();
        (Voice::new(Some(jobs), Some(wav.clone()), tx), jrx, wav)
    }

    #[test]
    fn toggle_starts_a_take_and_the_next_one_sends_it() {
        let (mut v, jobs, wav) = voice();
        v.toggle();
        assert_eq!(v.phase, Phase::HandsFree, "the first toggle listens hands-free");
        assert!(v.source.is_some(), "the microphone is on");
        v.on_level(0.5);
        v.on_text(v.take, "hello there".into(), false);
        v.toggle();
        assert_eq!(v.phase, Phase::Finishing, "the second toggle ends the take");
        v.toggle();
        assert_eq!(v.phase, Phase::Finishing, "a third one while it finishes changes nothing");
        // The mic's tail is over: the whole take goes for one last read.
        v.tail_until = Some(0.0);
        v.tick();
        let job = jobs.try_recv().expect("a closing read");
        assert!(job.last && job.take == v.take);
        assert!(v.source.is_none(), "the microphone is off");
        v.on_text(job.take, "hello there friend".into(), true);
        assert_eq!(v.phase, Phase::Idle);
        assert_eq!(v.best, "hello there friend");
        // And it's ready to go again.
        v.toggle();
        assert_eq!(v.phase, Phase::HandsFree);
        let _ = std::fs::remove_file(wav);
    }

    #[test]
    fn steady_background_noise_stops_counting_as_a_voice() {
        // Regression (#64): a fan or TV at a steady level kept a hands-free take open until its 60 s limit.
        let mut f = NoiseFloor::default();
        let mut t = 0.0;
        let mut voiced = 0;
        for i in 0..400 {
            t += 0.01;
            if f.is_voice(0.45 + if i % 2 == 0 { 0.03 } else { -0.03 }, t) && i > 4 {
                voiced += 1;
            }
        }
        assert_eq!(voiced, 0, "steady noise is the floor, not a voice");
        assert!(f.is_voice(0.8, t + 0.01), "speech well above the noise still counts");
        // Speech in a quiet room: from the first dip between words, every word counts.
        let mut q = NoiseFloor::default();
        let mut t = 0.0;
        let (mut spoken, mut voiced) = (0, 0);
        for i in 0..300 {
            t += 0.01;
            let v = if i % 30 < 22 { 0.6 } else { 0.05 };
            let voice = q.is_voice(v, t);
            if i >= 30 && v > 0.5 {
                spoken += 1;
                voiced += voice as u32;
            }
        }
        assert_eq!(voiced, spoken, "a voice over a quiet room counts throughout");
        assert!(!NoiseFloor::default().is_voice(0.19, 0.0), "never below the old fixed bar");
    }

    #[test]
    fn a_hands_free_take_ends_when_no_new_words_come() {
        let (mut v, _jobs, wav) = voice();
        v.toggle();
        v.on_level(0.5);
        v.read_len = RATE as usize * 2;
        v.on_text(v.take, "turn on the".into(), false);
        assert_eq!(v.heard_len, RATE as usize * 2);
        // More sound, but a re-read that only changes punctuation or case isn't new words.
        v.read_len = RATE as usize * 5;
        v.on_text(v.take, "Turn on the.".into(), false);
        assert_eq!(v.heard_len, RATE as usize * 2);
        v.voice_at = v.now();
        v.heard_at = v.now();
        v.tick();
        assert_eq!(v.phase, Phase::HandsFree, "3 s without new words: still listening");
        v.read_len = RATE as usize * 7;
        v.tick();
        assert_eq!(v.phase, Phase::Finishing, "5 s of sound without new words ends it, noise or not");
        let _ = std::fs::remove_file(wav);
    }

    #[test]
    fn the_mic_list_names_each_mic_once() {
        let names = ["USB Mic", "Built-in", "USB Mic", "", "Headset"].map(String::from);
        assert_eq!(audio::unique(names), ["USB Mic", "Built-in", "Headset"]);
    }

    #[test]
    fn words_ignores_case_and_punctuation() {
        assert_eq!(words("Turn on the, lights."), "turn on the lights");
        assert_eq!(words("  Hello   there "), words("hello there!"));
        assert_ne!(words("hello there"), words("hello there friend"));
    }

    #[test]
    fn woke_matches_the_name_as_a_whole_word() {
        assert!(woke("Jarvis, what's the weather?", "jarvis"));
        assert!(woke("hey JARVIS", "jarvis"));
        assert!(woke("Okay. Jarvis!", "Jarvis "));
        assert!(!woke("jarvison is not it", "jarvis"), "no substring match");
        assert!(!woke("what's the weather", "jarvis"));
        assert!(!woke("jarvis", ""), "an empty name never matches");
    }

    #[test]
    fn without_wake_drops_a_leading_name() {
        assert_eq!(without_wake("Jarvis, what's my latest download?", "jarvis"), "what's my latest download?");
        assert_eq!(without_wake("JARVIS!", "jarvis"), "");
        assert_eq!(without_wake("hey Jarvis, what's up", "jarvis"), "hey Jarvis, what's up", "a leading hey is left for the model");
        assert_eq!(without_wake("what's up", "jarvis"), "what's up");
        assert_eq!(without_wake("", "jarvis"), "");
    }

    #[test]
    fn waking_carries_what_was_said_after_the_name() {
        let (mut v, _jobs, wav) = voice();
        v.wake_buf.lock().unwrap().extend([0.123f32; 800]);
        v.wake_start();
        assert_eq!(v.phase, Phase::HandsFree);
        assert!(v.spoke && v.strip_wake, "the carried words count as speech and the name is stripped");
        assert_eq!(v.buf.lock().unwrap()[0], 0.123, "the wake tail starts the take");
        let _ = std::fs::remove_file(wav);
    }

    #[test]
    fn toggle_without_a_speech_model_stays_idle() {
        let (tx, _events) = mpsc::channel();
        let mut v = Voice::new(None, None, tx);
        v.toggle();
        assert_eq!(v.phase, Phase::Idle);
        assert!(v.source.is_none());
    }

    #[test]
    fn a_toggled_take_with_nothing_said_ends_without_a_read() {
        let (mut v, jobs, wav) = voice();
        v.toggle();
        v.toggle();
        v.tail_until = Some(0.0);
        v.tick();
        assert!(jobs.try_recv().is_err(), "silence isn't read (Parakeet makes words up from it)");
        assert_eq!(v.phase, Phase::Idle);
        let _ = std::fs::remove_file(wav);
    }

    #[test]
    fn a_mic_error_tells_the_app_why() {
        let v = mic_error(&MicError::new("busy", "device in use"));
        assert_eq!(v["code"], "no_input", "the code older app builds already handle");
        assert_eq!(v["reason"], "busy");
        assert_eq!(v["message"], "device in use");
    }

    #[test]
    fn the_vad_command_sets_the_listening_behaviour() {
        let (mut v, _jobs, wav) = voice();
        assert!(v.handsfree && (v.pause_ends - PAUSE_ENDS).abs() < f64::EPSILON, "the default is Normal hands-free");
        let exit = v.handle(Ev::Cmd(json!({ "cmd": "vad", "handsfree": false, "pause": 3.0, "voice": 0.3, "level": 0.25 })));
        assert!(!exit);
        assert!(!v.handsfree);
        assert_eq!(v.pause_ends, 3.0);
        assert_eq!(v.floor.voice, 0.3);
        assert_eq!(v.speech_level, 0.25);
        // Out-of-range values are clamped, never trusted.
        v.handle(Ev::Cmd(json!({ "cmd": "vad", "pause": 99.0, "voice": -1.0, "level": 7.0 })));
        assert_eq!(v.pause_ends, 4.0);
        assert_eq!(v.floor.voice, 0.01);
        assert_eq!(v.speech_level, 1.0);
        let _ = std::fs::remove_file(wav);
    }

    #[test]
    fn a_shorter_pause_ends_a_hands_free_take_sooner() {
        let (mut v, _jobs, wav) = voice();
        v.toggle();
        v.on_level(0.5);
        v.on_text(v.take, "lights off".into(), false);
        v.heard_at = v.now() - 1.0;
        v.voice_at = v.now() - 1.0;
        v.handle(Ev::Cmd(json!({ "cmd": "vad", "pause": 0.75 })));
        v.tick();
        assert_eq!(v.phase, Phase::Finishing, "with a Short pause, a second of silence ends the take");
        let _ = std::fs::remove_file(wav);
    }

    #[test]
    fn a_new_take_keeps_the_configured_sensitivity() {
        let (mut v, _jobs, wav) = voice();
        v.handle(Ev::Cmd(json!({ "cmd": "vad", "voice": 0.1 })));
        v.toggle();
        assert_eq!(v.floor.voice, 0.1, "a take starts with the configured bar");
        v.cancel();
        assert_eq!(v.floor.voice, 0.1, "and it survives the take ending");
        let _ = std::fs::remove_file(wav);
    }

    #[test]
    fn losing_the_mic_mid_take_ends_it_and_idle_ignores_it() {
        let (mut v, _jobs, wav) = voice();
        v.handle(Ev::AudioFailed(MicError::new("lost", "unplugged")));
        assert_eq!(v.phase, Phase::Idle, "nothing to end while idle");
        v.toggle();
        assert_eq!(v.phase, Phase::HandsFree);
        v.handle(Ev::AudioFailed(MicError::new("lost", "unplugged")));
        assert_eq!(v.phase, Phase::Idle, "the take ends");
        assert!(v.source.is_none(), "the microphone is off");
        let _ = std::fs::remove_file(wav);
    }
}
