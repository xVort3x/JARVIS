# VantaVoice feature map — honest equivalents we could build ourselves

Reviewed: 2026-11-18. Source: vantavoice.ai public pages (home, /features, /pricing) — marketing copy only.
Nothing decompiled; nothing behind login; no paid assets touched. Their implementation is unknown; every
line about "how" is inference from the feature page. Their plan structure (Free/Starter/Premium/Ultimate):

- Free — 1,000 credits/mo, voice selection, screen awareness, adaptive vision, app control, fact checking.
- Starter ($9.95/mo) — + multi-AI chat channels, personal memory, conversation search, en/es.
- Premium ($20.95/mo) — + credit rollover, deep web search, more voices, Windows Terminal assistant, skills + canvases.
- Ultimate ($44.90/mo) — + advanced models, 90+ langs, launch Windows apps, "active screen interaction".

## Feature → our-stack equivalent

| Vanta feature | What it almost certainly is (inference) | Our equivalent (how to build) |
| --- | --- | --- |
| Screen Analysis + multi-monitor | Screenshot + vision LLM over capture; display index arg | `look_at_screen` + `take_screenshot` + new `display: n` arg (EnumDisplayMonitors in Rust/windows helper) — Phase E |
| Adaptive Screen Vision | Screen context resized/auto-selected by question | Same as Always-Aware front-window line we ship |
| Deep Search | Multi-pass web via model + tools, cite sources | Phase B prompt harness (done) |
| Fact Check | Source fetch + claim comparison | Phase B (done) |
| Local Awareness | TZ/region in prompt (opt-in) | Phase A/B (done) |
| Custom Keybinds | Global hotkey | Done (Voice-win helper, Ctrl+Alt) |
| Voice Commands | Intent router to settings/actions | `panel_action` tool (Phase F idea) — one dispatch table, test |
| Voice Launch | open URL/app via shell | Done (`open` tool); prompt examples added Phase A |
| Brief Mode | Response-style toggle | Done (Phase A commit) |
| Voice Selection (+ recent) | Multi-voice picker with MRU | Done (ElevenLabs voices + MRU-ish panel pick) |
| Speech Speed Control | Text-to-speech rate | Exists param in Gemini path; add `ttsSpeed` config + UI line |
| Custom names/personality | System-prompt style overlay | New "style" preset page: 2–3 premade personalities (calm, witty, brief) — new module or config `voiceStyle` |
| Auto-start on boot | Startup registration | Exists (Open at login) |
| Tray Mode | Background shell + tray | Exists |
| Gmail / Calendar Sync / Speed Test | IMAP+SMTP / Graph API / ICMP+API | Needs user OAuth; Gmail app password — Phase G (blocked until you authorize) |
| Prompt Studio (coming soon) | Voice-dictated doc canvas | Phase C (done in this wave) |
| Fact Checking | Claim vs sources | Phase B |
| Credit Rollover / Credits | Usage metering at the provider layer | Skip — we call the providers directly; no keys of ours to consume |
| Multi-AI Chat Channels | Multiple live conversations with different models/voices | Ideas below |
| Personal Memory | Facts/summaries in file memory | Exists (memory.json + sessions + Get to Know Me) |
| Conversation Search History | Full-text search over past sessions | Sessions list exists; add a `/find <text>` over session digests (we have one already) — missing: plaintext search over transcripts |
| Multi-Lingual | Model answers in language of input; TTS in same | Works in Flash models already (language follows the model); nothing to build |
| Personalities / Personas | Named presets of tone | Small: preset picker on General page, three premade (Keeps J.A.R.V.I.S / Dry wit / Warm and plain) |
| Edit with Assistant Canvases | Prompt Studio formalization (voice-first rewrite) | Phase C |
| Manage Assistant Skills | Reusable instruction packs | Small: a Skills page listing named prompt snippets ("web research workflow", "tone my draft", "explain like I'm 5") — one file, one tool |
| Windows Terminal Assistant | Auto-context + command help in terminals | Medium: front-app detection → if terminal, set a `terminal` flag in live state with an extra prompt line |

## What I recommend building, in order of return per effort

1. **Skills** (~1 hour): named prompt-snippet picker on the General page ("Apply a skill" → 3 premades).
   Persist to config, fires in the live prompt. Highest feel-per-minute on "assistant is crafted for me".
2. **Personalities** (~1 hour): three tonal presets (Calm default / Dry wit / Warm plain).
3. **Conversation search** (small): search across the session digest list from the panel Home search
   box and open one.
4. **Per-conversation provider** (channels): agents already run against other models; a per-chat provider
   picker would cap rate-limited providers by spreading across providers. Big-ish; probably not worth it.
5. **Windows Terminal Assistant** (medium): only if you live in terminals.

Not worth it: credits/rollover/billing (no-account app), multi-lingual work (free with the Flash tiers),
Canvases beyond the Studio already planned.

## Pricing tier interpretation (private to us)

Their free tier gates **deep search** behind Premium and has a credits meter. Ours has neither; the
web tools are free-form and the Groq/Gemini providers carry the cost. We're strictly more open than
their Free tier, and comparable to Ultimate except their 90+ langs and "Advanced AI Models".
