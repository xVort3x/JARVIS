# J.A.R.V.I.S

Personal AI assistant — a Tauri 2 desktop app (Rust shell) with a Node sidecar agent, shared browser JS, and native helpers.

## Build

```sh
cd showcase/tauri/sidecar && npm ci && npm test
cd .. && ./build.sh        # release bundle (installer on Windows, .app on macOS, AppImage/.deb/.rpm on Linux)
./build.sh dev             # debug binary only
```

Requires Rust, Node, and (on Windows) the voice/hands helpers built by `build.sh`.

## Notes

- `roamies-*` helper names, the `roamies` package, `com.kenkai.roamies` bundle id and `~/.gg` data paths are internal compatibility names — kept as-is.
- Memory, config and API keys live in `~/.gg` on your machine, never in this repo. Bring your own model/API keys.
- CI: `.github/workflows/ci.yml`.

J.A.R.V.I.S by xV0rt3_x