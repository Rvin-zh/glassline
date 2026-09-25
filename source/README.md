# Glassline application

This directory is the application. It is the full [Open-Cluely](https://github.com/shubhamshnd/Open-Cluely) tree — main process, overlay, speech-to-text, AI providers, tests, and packaging — with Glassline’s Mac and Linux changes applied on top.

Glassline is an indirect fork. It was not created with GitHub’s Fork button. The parent repository explains the split: [../README.md](../README.md).

The overlay transcribes host audio and the microphone, captures the screen, and answers in an always-on-top window. Use it only where recording, transcription, screenshots, and AI assistance are allowed.

## Requirements

- Node.js 20 or newer, npm 10 or newer
- A Gemini or Portkey key, entered in Settings after launch
- An AssemblyAI, OpenAI, or Portkey speech key if you use cloud transcription

## Run

macOS:

```bash
npm ci
cp .env.example .env
npm start
```

Permission prompts, Screen Recording, and `npm run build:mac` are in [MAC.md](./MAC.md).

Linux (Fedora 40+ is the tested desktop):

```bash
npm ci
cp .env.example .env
npm start
```

Packages, the XWayland default, and PipeWire host audio are in [FEDORA.md](./FEDORA.md). On a Wayland session the launcher uses XWayland so the window can be placed and kept on top. `npm run start:wayland` switches to native Wayland.

Useful variants:

```bash
npm run dev            # Electron logging
npm run start:hidden   # start without showing the window
```

## What the overlay does

- Live transcription from system audio and the microphone, with a per-source monitor.
- Answers from Gemini or Portkey. Gemini keys can be a comma-separated list; the app fails over on quota or auth errors.
- Screenshot and Auto Screen. Auto Screen repeats capture and analysis on a 5, 10, 15, or 30 second interval and keeps only the newest automatic capture.
- Separate actions for a full-context answer (Ask AI), the current screen (Screen AI), short cues (Suggest), and a structured record (Notes).
- Per-message AI / Off toggles, so a line can stay on screen without being sent on the next prompt.
- Output length: Quick, Adaptive, Detailed, or a local Custom template.
- Optional web search (Gemini grounding or Tavily), CV and job documents, and a short archive of previous interview notes.
- A mobile page on port 7823 for a phone on the same network. It can trigger a screenshot and Ask AI. Treat that port as trusted-network only: the server listens on all interfaces.

Each launch starts a new interview. Older summaries stay in Settings and are off until you select them.

## Configuration

| Variable | Default | Role |
| --- | --- | --- |
| `HIDE_FROM_SCREEN_CAPTURE` | `true` | Asks the OS to leave the overlay out of screen capture. Works on macOS. Linux cannot do this. |
| `START_HIDDEN` | `false` | Launch without showing the window. |
| `MAX_SCREENSHOTS` | `50` | Drops the oldest captures past this count. |
| `SCREENSHOT_DELAY` | `300` | Milliseconds the window is hidden before a capture. |
| `NODE_ENV` | `production` | `development` opens DevTools. |
| `NODE_OPTIONS` | `--max-old-space-size=4096` | Node heap for the Electron process. |

Model lists, speech models, programming-language options, and shortcuts live in [`src/config.js`](./src/config.js). The first entry in each list is the default.

Development state is `cache/app-state.json`. Development screenshots are `.stealth_screenshots/`. Packaged builds use Electron’s user-data directory. API keys are stored with Electron `safeStorage` when the OS keyring is available.

When you add an environment variable, update [`src/bootstrap/environment.js`](./src/bootstrap/environment.js), [`.env.example`](./.env.example), and this file together.

## Layout

```text
src/bootstrap/                         Environment loading
src/main-process/                      Startup, window, shortcuts, IPC
src/main-process/features/mobile-server/   Phone companion
src/services/                          AI, speech-to-text, documents, saved state
src/windows/assistant/                 Overlay window, preload bridge, renderer
src/windows/legacy/                    Old experiments, not on the launch path
assets/                                Icons
packaging/macos/                       Entitlements and the settings-seed template
test/                                  Node tests
```

File-level ownership is in [`notes.md`](./notes.md).

## Scripts

| Command | What it does |
| --- | --- |
| `npm test` | Fast Node tests. |
| `npm run test:e2e` | Electron scenarios against a local fake provider. No real API keys. |
| `npm run verify` | Tests, Electron scenarios, and the Fedora and macOS smoke checks. |
| `npm run build:mac` | macOS dmg and zip. See [MAC.md](./MAC.md). |
| `npm run build:linux` | Linux AppImage and rpm. See [FEDORA.md](./FEDORA.md). |

`npm run verify:live` also calls live model and speech providers and can spend API credit. It does not print keys or transcript text.

## Boundaries

- Renderer code talks to the main process through `src/windows/assistant/preload/`. It does not import main-process modules.
- New UI goes under `src/windows/assistant/renderer/features/`. New domain logic goes under `src/services/` or `src/main-process/features/`.
- Do not commit `.env` or `packaging/macos/settings-seed.json`. Commit `.env.example` and `settings-seed.example.json` when the contract changes.
