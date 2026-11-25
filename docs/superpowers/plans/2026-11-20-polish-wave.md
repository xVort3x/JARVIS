# J.A.R.V.I.S polish wave — 2026-11-20

Status: in progress

## Ask → work

1. **Remove the pill** (second screenshot). Delete the always-on-top pill window, page and wiring.
2. **Open apps by fuzzy name** ("Spotify", "spotify app") on Windows: Start-menu shortcuts + `Get-StartApps`
   (Store apps), scored match, then launch. No exact exe name needed.
3. **Real images, less blue.** Photo cards draw the actual full-colour photo (no LED dither); warm graphite/gold
   palette in the drawing tool and the panel.
4. **More image sources than Wikipedia.** Photo cards try Openverse (free CC photos) first, Wikipedia as fallback;
   `url` still pins any picture.
5. **Real alarm.** Generated chime WAV, platform player, rings whenever a timer/reminder fires or on demand;
   stops on "stop" / new speech; auto-stops after 45 s.
6. **Premium desktop tools.** `clipboard` (read/replace) and `system` (battery/CPU/memory/disk, volume, mute,
   media keys, lock).
7. **Niche manners.** Prompt learns alarms + clipboard + system; alarm nudge says what it is.

## Verify

- `npm test` green (alarm, app match, Openverse, tools).
- Panel + photo card screenshots.
- `cargo test` voice helper; cargo build clean.
- Install and check log; no pill window.
