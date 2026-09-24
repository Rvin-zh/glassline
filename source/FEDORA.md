# Fedora / Linux Notes

Open-Cluely now targets Fedora as a first-class desktop platform.

## Quick start (Fedora 40+)

```bash
sudo dnf install -y nodejs npm gcc-c++ make python3 \
  gtk3 nss atk at-spi2-atk cups-libs libdrm libxcb libX11 libXrandr \
  libxkbcommon mesa-libgbm alsa-lib ImageMagick xrandr \
  pipewire pipewire-pulseaudio pipewire-utils \
  xdg-desktop-portal xdg-desktop-portal-gnome fuse fuse-libs

npm ci
cp .env.example .env
npm start
```

Recommended Node: 20+. Verified on Node 22.

## Display profiles

On GNOME Wayland, the launcher defaults to **XWayland compatibility**:

```bash
npm start                 # XWayland by default on Wayland sessions
npm run start:xwayland    # force XWayland
npm run start:wayland     # native Wayland (window move/always-on-top may be limited)
```

Overrides:

- `OPEN_CLUELY_DISPLAY_PROFILE=xwayland|wayland|x11`
- `OPEN_CLUELY_ENABLE_GPU=1` to re-enable GPU (off by default on Linux for stability)
- `OPEN_CLUELY_FULL_EFFECTS=1` to restore blur/animation effects (reduced by default on Linux for responsiveness)

## Known Linux limitations

- `setContentProtection` is **unsupported** on Linux. The overlay can appear in screen shares.
- Global shortcuts need a valid desktop identity / portal consent. A helper desktop file is in `assets/com.opencluely.assistant.desktop`.
- Host audio uses direct `pactl`/`parec` PipeWire monitor capture first, so browser screen sharing cannot block microphone transcription.
- On Wayland sessions, screenshots use the XDG Screenshot portal and briefly hide this app from its own image. Backends are bounded so a dismissed portal cannot hang the UI.
- **Screenshot** now analyzes immediately; **Auto Screen** repeats capture and streamed analysis at the configured interval (10 seconds by default).

If GNOME repeatedly denies noninteractive screenshot requests for the installed desktop identity:

```bash
flatpak permission-set screenshot screenshot com.opencluely.assistant yes
```

Linux still cannot exclude a visible overlay from third-party screen sharing. Hiding or closing the window is the only reliable exclusion.

## Packaging

```bash
npm run build:linux:appimage
npm run build:linux:rpm
```

Artifacts land in `dist/`.

## Diagnostics

Settings → **Fedora / Platform Diagnostics**, or:

```bash
npm run smoke:fedora
```

## Test tiers

- `npm test` runs the fast Node test suite.
- `npm run test:e2e` runs isolated, deterministic Electron scenarios against a loopback fake provider. It uses temporary state, does not read the normal `.env`, app state, or API keys, and blocks external network access.
- `npm run verify` runs the fast tests, Electron E2E suite, and Fedora smoke checks. Its Fedora check runs in isolated no-write mode: it does not inspect the normal `.env` or create a timestamped diagnostics report. Run it after every feature change.
- `npm run verify:live` adds the Portkey model benchmark and realtime STT smoke test. `PORTKEY_API_KEY` is required because the benchmark always uses Portkey. `OPENAI_API_KEY` is optional and only selects direct OpenAI STT; without it, the STT smoke uses the Portkey OpenAI virtual-key fallback. This tier may incur paid provider usage. It does not print credentials or transcript text; STT output is limited to connection/status/error metadata and event/character counts.

## Portkey / model benchmark

Use a Portkey integration that can reach Gemini 3.x (often `@vertex` on Vertex-backed workspaces). Plain `google` fails if the linked Google API key in Portkey is invalid.

```bash
PORTKEY_API_KEY=… PORTKEY_PROVIDER=@vertex npm run benchmark:models
```

Reports land in `cache/benchmarks/` (gitignored). Rotate any keys pasted into chat.

## Privacy

- Application API keys belong in Settings / `cache/app-state.json`. Export live-verification credentials only in the invoking shell; do not add them to `.env` or source.
- `smoke:stt` never prints transcript text. It reports connection/status/error metadata plus event and character counts.
- CV / durable memory are **not** sent to the mobile companion until pairing is implemented.
- Rotate any keys that were pasted into chat.
