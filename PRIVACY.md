# Privacy

Effective date: 10 November 2026

J.A.R.V.I.S is an open-source desktop app made by an individual developer. This page says, in plain words, what
data J.A.R.V.I.S handles and where it goes.

## The short version

- The developer runs no servers and collects nothing from you.
- There is no analytics or telemetry.
- Data leaves your computer only to services you choose to use, listed below.

## What leaves your computer, and where it goes

**The AI provider you sign in to** (Anthropic via Claude Code, OpenAI/ChatGPT, Groq, or a provider you add with an API
key) receives:

- your messages and the conversation so far
- a "live state" block: the date and time, the name or title of the app and window in front, and the facts and
  commitments J.A.R.V.I.S has saved in memory
- screenshots or window text, when J.A.R.V.I.S looks at your screen to answer
- your time zone and locale, unless you turn off **Local awareness** on the General page (Settings → General)

**Fish Audio, Google or ElevenLabs**, whichever you pick as the voice, receives the text of each reply to speak it, only if spoken replies are on. It uses your own key for that service (for Gemini, the Gemini key you added for the AI is used unless you save a separate one for the voice).

**Gmail** is connected only when you set it up (an app password, stored encrypted on your computer). It receives
only the asks you make of it: reading a message sends that message's text to the model provider; sending or
replying happens only after you confirm it in the app.

**GitHub** is used only when you download a new version yourself. The app does not check for updates or contact
GitHub on its own.

**Hugging Face** is used once, on Windows and Linux, to download the speech model.

**Wikipedia** is used to fetch photos for photo cards, and websites' `favicon.ico` is fetched for source cards.

**Websites** that you or the agent open or fetch (for example with its `web_fetch` tool) receive the usual
request a browser would send.

**Search engines**: when the agent searches the web (its `web_search` tool) on a model from Anthropic, Anthropic
runs the search. On other providers, or when that search fails, the search words go to DuckDuckGo and, if it
doesn't answer, to Brave, Bing or Google.

Each provider's own privacy policy applies to what is sent to it.

## Speech, microphone and screen

- **macOS:** speech is turned into text on your Mac by Apple's on-device recognizer. On Macs where on-device
  recognition isn't available, Apple's recognizer may use Apple's servers, under Apple's terms.
- **Windows and Linux:** speech is turned into text on your computer (Parakeet).
- The microphone is used only while you hold the talk keys (or, on Linux with Wayland, from your talk shortcut
  until you press it again or pause), or while the wake word is on.
- **Wake word (macOS and Windows, off by default):** when you turn it on, the microphone stays open so
  J.A.R.V.I.S can hear "Hey Jarvis", and the system shows its microphone dot the whole time. On macOS the
  phrase is matched on your Mac by Apple's on-device recognizer. On Windows it is matched on this PC by the
  same Parakeet model that hears your requests. J.A.R.V.I.S keeps nothing and sends nothing from wake
  listening; the log notes only that the wake word was heard, never the words.
- **Memory sync (off by default):** if you choose a sync folder, J.A.R.V.I.S writes your reminders, commitments and
  remembered facts to the existing `Roamies Sync/<random id>.json` folder in it, so your other computer can read them. Everything in that
  folder is encrypted (AES-256-GCM) with a key made from a passphrase you type on each computer; the key is kept in
  your Keychain (macOS), with DPAPI (Windows) or in your keyring (Linux), and the passphrase itself isn't stored. Your
  sync service sees only encrypted files and random file names. Conversations, sign-ins and keys are never written
  there. Stop syncing in the panel to remove the key from this computer; the folder copy stays until you delete it.
- **Always-Aware (off by default):** when you switch it on, the app and window you're in ride along with each
  request (the app, the title, the page's address), so J.A.R.V.I.S knows what you're looking at when you ask. Exclusions
  never let me see the windows you list (password managers, private browsing and the lock screen are the defaults),
  and Private mode turns all of it off until you switch it back on. Nothing is recorded between requests; the only
  screen data kept is the picture taken to answer "what's on my screen?" — it's deleted right after it's used.
- **Session memory:** after each conversation ends, J.A.R.V.I.S saves a one-line recap of it ("Debugging their Rust
  build"), so it can pick up where you left off. The recap is one sentence, kept in `sidekick/summaries/`,
  alongside the session's transcript in `sidekick/sessions/`. Forget a session in the panel and both its recap and
  its transcript are deleted.
- **Working preferences:** how you like J.A.R.V.I.S to work (e.g. "run the tests before calling it done"), saved
  separately from facts and synced with your other computers if you set up sync.
- **Password fields** are blacked out of every picture that goes to the AI (Windows only, for now), however the
  picture was taken.
- The screen is captured only when J.A.R.V.I.S answers something about your screen, or when you mark an area. On Linux
  with Wayland it's taken through your desktop's screenshot portal; the copy the portal saves is deleted right away.

## What's stored on your computer

Everything lives in `~/.gg` (on Windows, `%USERPROFILE%\.gg`) and stays on your computer:

| File or folder           | What's in it                                                                        |
| ------------------------ | ----------------------------------------------------------------------------------- |
| `sidekick.json`          | your settings                                                                       |
| `sidekick/memory.json`   | facts J.A.R.V.I.S learned, your working preferences and your commitments                 |
| `sidekick/sessions/`     | conversations (the newest 60 are kept)                                              |
| `sidekick/summaries/`    | one-line recaps of past conversations (deleted with the session)                    |
| `sidekick/logs/`         | activity logs: tool names, timings, errors and short snippets of tool results (such as a line of window or page text); text you type into apps or files is reduced to its length; kept 7 days |
| `sidekick/usage.jsonl`   | token counts and timings only, never content                                       |
| `auth.json`              | your AI sign-ins, shared with GG Coder                                              |

**Save Diagnostics** (the panel's About page, or the tray icon's menu) writes one `jarvis-diagnostics-….log` file to
your Downloads folder, only when you ask. It holds the logs above, your system and screen details, your microphones and
permission states, and your settings. Keys, tokens, email addresses, names, your home folder and user name are removed
first. Nothing is uploaded: it stays on your computer unless you choose to send it (for example by attaching it to a
GitHub issue).

Your Fish Audio key and your Gemini voice key are kept in the macOS Keychain, encrypted with DPAPI on Windows, or in your desktop's keyring
(through the Secret Service) on Linux.

You can see what J.A.R.V.I.S remembers on the panel's **Memory** page, and remove it with **Forget** or
**Forget Everything**.

## Deleting everything

Follow the [Uninstall](README.md#uninstall) steps in the README.

## Children

J.A.R.V.I.S isn't made for children under 13 (or the minimum age in their country), and it doesn't ask about age.
Parents should supervise any use by children.

## Changes

Changes to this notice are made in this file on GitHub, so its history shows what changed and when.

## Questions

Email the repository's issue tracker (below) or [open an issue](https://github.com/xVort3x/JARVIS/issues).
