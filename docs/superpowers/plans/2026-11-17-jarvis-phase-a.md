# J.A.R.V.I.S renovation — Phase A: the voice and the brain (0.7.0)

Date: 2026-11-17 · Builds on `2026-11-17-always-on-jarvis.md` (0.6.0, superseded wake task noted there)

Goal: make Groq the default brain for everything, speak the reply with ElevenLabs, keep the wake word as
the only summon path, open nothing on arrival, and get the user through getting a J.A.R.V.I.S ElevenLabs
voice ID.

User decisions (confirmed 2026-11-17, "Now, using these guidelines, build it"):
- Groq is the default brain for everything (not a fast lane). OpenAI-compatible endpoint
  (`https://api.groq.com/openai/v1`), curated models, tools + vision must keep working through gg-ai's
  OpenAI-compatible transport.
- Clap summon: off by default; the wake word stays primary.
- Arrival ritual: opens no apps/URLs; greeting voice only (if any).
- ElevenLabs voice: user has no voice ID; we walk them through getting one for J.A.R.V.I.S.
- OpenJarvis architecture borrowed, not installed (no Python runtime, no uv, no Ollama, no GUI).
- Privacy: reply text → ElevenLabs, prompts → Groq, wake/STT → Gemini (user-chosen).
- Never touch secrets; risky actions behind confirmation; phase-by-phase reporting; each phase
  buildable/installable and user-testable.

## Task 1 — ElevenLabs TTS provider (`eleven.mjs`) + registration in `speaker.mjs`

**Files:** new `showcase/tauri/sidecar/eleven.mjs`, `showcase/tauri/sidecar/speaker.mjs`,
`showcase/tauri/sidecar/test/eleven.test.mjs`, `showcase/tauri/sidecar/test/speaker.test.mjs`.

1. Research (done 2026-11-17): TTS streaming via `wss://api.elevenlabs.io/v1/text-to-speech/{voice_id}/stream-input`
   (WebSocket; init `{text:' '}`, send `{text}` (ends with a space), `{flush:true}`, close `{text:''}`;
   audio chunks `{audio: <base64>}` or final `{isFinal:true}`), header `xi-api-key`, query `model_id`,
   `output_format`, `voice_settings {stability, similarity_boost, style, use_speaker_boost, speed}`;
   models `eleven_v4`, `eleven_v4_turbo`, `eleven_flash_v2_5`, `eleven_multilingual_v2`; voices at
   `/v1/voices`. PCM in 16-bit mono at the requested rate.
2. Implement in `eleven.mjs`: `ELEVEN_API`, `ELEVEN_TTS` (socket path + query defaults), `ELEVEN_MODELS`
   (curated picks), `ELEVEN_MODEL` (default), `ELEVEN_VOICES` (the library list), `ELEVEN_DEFAULT_VOICE`,
   `elevenAccount(key)` (never throws → `{ok, credit}`), `ElevenVoice` (same `Voice` shape as FishVoice:
   open/say/end/abort/onAudio(Uint8Array PCM)/onEnd/onError, one socket per reply, sentence text + flush,
   finish on final, error → onError with `heard`).
3. Register in `speaker.mjs`: add `eleven` to `PROVIDERS` (models priciest-first, pick, freeModel null,
   rate = the PCM rate it will use, defaultVoice, warmDelay) and export `ELEVEN_*` re-exports the tests use.
4. Tests in `test/eleven.test.mjs`: voices list shape, request/flush/send sequence, final → end, error →
   onError, nothing-said → no request. Speaker-level: setProvider('eleven') speaks through ElevenLabs with
   the default voice and model, account check drives the model, beats work, stop/abort behave, key problem.

## Task 2 — Groq as the default brain

**Files:** `showcase/tauri/sidecar/local.mjs` or gg-core-facing helpers, `sidekick.mjs`, `providers.mjs`,
`panel/panel.js`, `PRIVACY.md`, `about.mjs`, tests (`local.test.mjs`, `providers.test.mjs`, `about.test.mjs`).

1. gg-ai already streams OpenAI-compatible (chat completions + tools + vision) through its provider
   registry with an optional `baseUrl`; gg-core exposes OpenAI-compatible third parties through the same
   registry (Sakana is the in-tree precedent). Groq rides `https://api.groq.com/openai/v1` with curated
   models; only touch gg-core if the existing path can't stream tools/vision (it can, per registry design —
   no gg-core change expected).
2. Curate the Groq model list (fast first): `openai/gpt-oss-20b`, `openai/gpt-oss-120b`, `llama-4-scout-70b`,
   `llama-3.3-70b-versatile`, … (fill from Groq's model catalog). Register as a provider/credentials shape
   gg-core understands (or the custom OpenAI-compatible local-server path if the provider id isn't a
   built-in).
3. `sidekick.mjs`: default provider/model to Groq (`ensureModel` picks Groq's curated fast model as the
   default; `FAST` map gains a groq entry; fallback list includes Groq first).
4. Panel: Groq appears in the Model menu with its key card (key link `https://console.groq.com/keys`);
   key save/login flows work through the existing apiKey path (provider id `groq`).
5. Privacy copy: prompts now go to Groq (ElevenLabs for reply text).

## Task 3 — Defaults: clap/summon off, arrival silent, wake primary

**Files:** `sidekick.mjs` (DEFAULTS), `panel.js`, `about.mjs`, `PRIVACY.md`, tests.

1. Wake word stays the primary summon path; the summon/hotkey path is off by default (clap off by default).
2. Arrival ritual: no actions, greeting voice only (no intro beats/actions).

## Task 4 — verify, build, install, ElevenLabs voice ID walkthrough

1. `cd showcase/tauri/sidecar && npm test` (all green, new eleven/groq/provider tests).
2. `cd showcase/tauri/src-tauri/voice-win && cargo test` (+ lock check).
3. `./build.sh` release, install over the running copy, launch; verify Groq answers + ElevenLabs speaks.
4. Walk the user through creating/getting an ElevenLabs voice ID for J.A.R.V.I.S (account → voice list →
   copy voice id → paste as J.A.R.V.I.S's ElevenLabs voice).

## Task 5 — commit Phase A

`Phase A: Groq as the default brain, ElevenLabs to speak`.

---

# SDD ledger — plan: Roamies/docs/superpowers/plans/2026-11-17-jarvis-phase-a.md
