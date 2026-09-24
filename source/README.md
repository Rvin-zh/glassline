# Glassline

Glassline is a live interview and meeting overlay for **macOS and Linux**.

This repository is an **indirect fork** of [Open-Cluely](https://github.com/shubhamshnd/Open-Cluely). It was not created with GitHub's Fork button. The code started from that project and was then changed for first-class Mac and Linux desktops: the glass overlay, window dragging, speech-to-text sessions, host audio, and packaging.

Open-Cluely is an Electron desktop copilot for technical interviews and live meetings. It combines AssemblyAI streaming transcription, screenshot capture, and Gemini-powered responses in a compact always-on-top window.

Use it only in environments where recording, transcription, screenshots, and AI assistance are allowed.

Open source alternative for Cluely and Parakeetai. Your Real-Time AI Interview Assistant 😉

## Looks

<img width="1137" height="1014" alt="image" src="https://github.com/user-attachments/assets/b9250f36-5623-45da-ab8e-8265ee079e92" />
<img width="1137" height="1019" alt="image" src="https://github.com/user-attachments/assets/68c14d18-fcb3-4ee5-9f98-d137b744156e" />

---

## Features

- Dual-source live transcription for host/system audio and microphone input, with per-source toggles and a live monitor.
- AI providers: **Gemini** and **Portkey**, with current Gemini Flash models (`gemini-3.8-flash`, `gemini-3.7-flash`, `gemini-3.5-flash-lite`).
- Prompt caching, CV/job document pinning, background Flash-Lite session memory, and toggleable web search (Gemini grounding / Tavily).
- Each launch starts a fresh interview. Up to 10 summary/note archives remain excluded by default and can be selected individually in Settings.
- Manual Screenshot immediately streams Screen AI. **Auto Screen** can repeat capture+analysis every 5/10/15/30 seconds (10-second default) while retaining only the newest automatic capture.
- Cloud STT: AssemblyAI, OpenAI `gpt-live-transcribe`, and Portkey Whisper fallback.
- **Fedora / Linux first-class support** — see [FEDORA.md](./FEDORA.md) for XWayland defaults, PipeWire host audio, packaging, and known limitations.
- **macOS first-class support** — see [MAC.md](./MAC.md) for Microphone / Screen Recording prompts, `setContentProtection` hide, unsigned Gatekeeper runbook, host-audio loopback, and `npm run build:mac` (icon: `assets/open-cluely.icns`).
- AI action controls have distinct context boundaries, described below.
- Per-message `AI` / `Off` controls let you keep transcript chunks, screenshots, and prior AI replies visible while excluding them from future prompts.
- Multiple Gemini API keys are supported as a comma-separated list, with automatic failover on quota or authentication errors.
- Settings support provider/model selection, AssemblyAI/OpenAI speech settings, programming language preference, and window opacity.
- Session state is persisted to `cache/app-state.json`, and screenshot retention is bounded by `MAX_SCREENSHOTS`.
- **Mobile companion** — a built-in web server exposes a mobile-optimised chat interface on port `7823`. Open the **Network** URL printed at startup (e.g. `http://192.168.1.42:7823`) on a phone that shares the same network as the PC. USB tethering, Wi-Fi hotspot from the phone, or both being on the same Wi-Fi all work. CV and durable memory are not exposed to mobile until pairing is implemented.

## AI Action Buttons

Each button sends a different slice of context to the AI and is designed for a different moment in the workflow.

### Output Formats

Choose a per-interview format from the compact toolbar; set the launch default in Settings.

- **Quick:** 2–4 glanceable non-coding cues, maximum 30 words; coding remains complete.
- **Adaptive:** domain-aware interview structure—coding clarification/complexity, behavioral STAR/impact, or system-design requirements/scale/components/trade-offs—bounded to 5–7 non-coding bullets.
- **Detailed:** full structured explanation, trade-offs, edge cases, and likely follow-ups.
- **Custom:** an encrypted local template up to 4,000 characters; empty templates safely fall back to Quick.

Notes, Insights, follow-up email, and background memory keep their dedicated document formats.

### Ask AI

The full-context answer button.

**What it sends:** all enabled transcript messages + all enabled screenshots + full conversation history.

**What it does:** reads the entire context as one unified thread, silently corrects speech-to-text errors, and identifies the actual question being asked.

**Output:**
- Non-coding: **2–4 glanceable cue bullets**, 3–7 words each, maximum 30 words total
- Coding: full code-first solution, approach, complexity, and edge cases; no 30-word cap

---

### Screen AI

The screenshot interpreter. Use this when the question or problem is visible on screen.

**What it sends:** only the screenshots currently enabled in context.

**What it does:** reads all visible text in the screenshot (constraints, function signatures, error messages, sample I/O), identifies what type of content it is (LeetCode problem, stack trace, terminal output, UI layout, architecture diagram), and responds accordingly.

**Output (for coding/debugging):**
- **Understanding → Approach → Complexity → Full runnable solution code → Explanation** (only if it adds value)

**Output (for non-coding screenshots — UI, architecture, docs):**
- **2–4 glanceable cue bullets**, maximum 30 words total

Use Screen AI when the problem is on your screen and you do not want to retype it.

---

### Screenshot and Auto Screen

- **Screenshot** performs one portal capture and immediately streams Screen AI.
- **Auto Screen** is off on launch. When enabled, it captures immediately, then repeats after each completed analysis using the configured 5/10/15/30-second interval.
- Cycles never overlap. Three consecutive failures turn Auto Screen off with an actionable error.
- Manual screenshots remain available; only the latest automatic screenshot is retained.

---

### Suggest

The cue button. Use it for short anchors you can expand in your own words.

**What it sends:** only the enabled transcript messages.

**What it does:** reads the conversation flow and identifies the strongest points to cover next.

**Output:**
- **2–4 cue fragments**, 3–7 words each, maximum 30 words total
- No dialogue script or full-sentence paragraph

---

### Notes

The structured record button. Use this at any point to capture what has happened in the session.

**What it sends:** all enabled transcript messages and context.

**What it does:** organizes the conversation into a clean, topic-grouped document — correcting for STT noise throughout. Does not add inferences or assumptions not grounded in the actual conversation.

**Output (always all five sections, even if empty):**
- **Key Discussion Points** — main topics covered
- **Decisions Made** — with owner if mentioned
- **Action Items** — checkboxed, with owner and deadline if mentioned
- **Open Questions / Unresolved Items** — what was raised but not resolved
- **Next Steps** — what happens next based on the conversation

Use Notes to produce a shareable record at the end of a meeting or interview debrief.

## Installation

### Requirements

- Windows 10/11 is the primary development target for this repo.
- Node.js `20.x` is recommended. The existing docs and environment were prepared around `20.20.1`.
- npm `10+`
- At least one Gemini API key (configured in the app Settings UI)
- One AssemblyAI API key (configured in the app Settings UI)

### Setup

```powershell
nvm install 20.20.1
nvm use 20.20.1
npm ci
Copy-Item .env.example .env
```

API keys are configured from the in-app Settings panel after launch.

Start the app:

```powershell
npm start
```

Useful variants:

```powershell
npm run dev
npm run start:hidden
```

### Recommended For Windows Use

For day-to-day use on Windows, prefer building the portable app and running the generated `.exe` instead of launching from source every time.

```powershell
npm run build:win
```

This creates:

```text
dist/GoogleChrome.exe
```

You can then run the packaged app directly by double-clicking `dist/GoogleChrome.exe`.

### Native Windows Build Tools

This app depends on native modules. If `npm ci` fails with `node-gyp` or Visual Studio toolchain errors, install the C++ build tools and Python:

```powershell
winget install --id Microsoft.VisualStudio.2022.BuildTools --exact --accept-package-agreements --accept-source-agreements --override "--passive --wait --add Microsoft.VisualStudio.Workload.VCTools --includeRecommended"
```

## Configuration

### Environment Variables

| Variable | Required | Notes |
|----------|----------|-------|
| `HIDE_FROM_SCREEN_CAPTURE` | No | Defaults to `true`; supported only on Windows/macOS. Linux cannot exclude a visible overlay from third-party screen sharing. |
| `START_HIDDEN` | No | Defaults to `false`. Also available at runtime via `npm run start:hidden` or `--start-hidden`. |
| `MAX_SCREENSHOTS` | No | Defaults to `50`. Old screenshots are deleted when the limit is exceeded. |
| `SCREENSHOT_DELAY` | No | Defaults to `300` ms. Delay used while briefly hiding the window before capture. |
| `NODE_ENV` | No | Defaults to `production`. `development` opens DevTools automatically. |
| `NODE_OPTIONS` | No | Defaults to `--max-old-space-size=4096`. |

### Source-Of-Truth Config

[`src/config.js`](./src/config.js) defines the app's configurable lists and defaults:

- Gemini models
- AssemblyAI speech models
- Programming language options for code-oriented prompts
- Global keyboard shortcuts

The first item in each model/language list is treated as the default.

### Persisted Files

- In development, state is written to `cache/app-state.json` at the repo root. Packaged builds use the Electron user-data directory.
- Development screenshots are stored in `.stealth_screenshots/`. Packaged builds store screenshots under the app's user-data path.
- API keys and sensitive context are encrypted with Electron `safeStorage` when the OS keyring is available; otherwise the app logs a plaintext-fallback warning.

### Previous Interviews

On each launch, a non-empty prior summary and its approved notes move into an archive capped at 10 entries. The new interview starts with empty session memory and no archives selected. Use **Settings → Previous Interviews** to include specific archives for the current interview or delete them. Full transcripts and screenshots are not archived.

## Mobile Companion

When the app starts, a lightweight HTTP + WebSocket server starts automatically on port `7823`, bound to all interfaces. Open the **Network** URL printed at startup (e.g. `http://192.168.1.42:7823`) on a phone that shares the same network as the PC. USB tethering, Wi-Fi hotspot from the phone, or both being on the same Wi-Fi all work — no app install required.

### Setup (one time)

1. Make sure the phone and PC can reach each other over the network. Any of these works:
   - **USB tethering** — plug your phone into your PC and enable tethering. On Android: **Settings → Network → Hotspot & Tethering → USB Tethering**. On iOS: **Settings → Personal Hotspot** (then connect via USB).
   - **Phone Wi-Fi hotspot** — turn on the phone's hotspot and connect the PC to it.
   - **Same Wi-Fi** — connect both devices to the same Wi-Fi network.
2. Look at the Electron app's terminal output for lines like `[MobileServer] Network: http://192.168.1.42:7823  (Wi-Fi)`.
3. Open one of those Network URLs in your phone's browser.

### Mobile interface

| Button | What it does |
|--------|-------------|
| **Screenshot** | Triggers a stealth desktop capture. A badge shows the current count. |
| **Ask AI** | Sends the typed context (and any captured screenshots) to the AI; response streams in real time. |
| **Auto-scroll** | Toggles whether new messages snap the view to the bottom. |
| **Clear** | Clears the Gemini conversation history. |

The text input above the toolbar lets you type a question or extra context before pressing **Ask AI** or the send button. The desktop view always shows the live transcript; the mobile view receives finalised transcripts and AI streams in sync.

The desktop top bar shows a **Mobile** pill with the LAN URL and connected-client count. Click it to copy the URL — handy for typing into the phone browser.

### If the URL doesn't work on a phone

If the phone shows `connection refused` or just times out while loading the URL, **Windows Firewall is almost always the cause**. Allow inbound TCP 7823 once, from an elevated PowerShell prompt:

```powershell
New-NetFirewallRule -DisplayName "Open-Cluely Mobile" -Direction Inbound -LocalPort 7823 -Protocol TCP -Action Allow -Profile Any
```

`-Profile Any` is important: rules created without it default to Domain/Private profiles only. A phone hotspot or unknown public Wi-Fi is usually classified as **Public**, which the default rule does not cover. This is the most common reason "other tools on ports 5000/5500 work but ours doesn't" — VS Code's Live Server and similar dev tools often add a `Profile=Any` rule the first time they prompt.

To remove the rule later:

```powershell
Remove-NetFirewallRule -DisplayName "Open-Cluely Mobile"
```

Other things to check:

- The **Mobile** pill in the desktop top bar must be lit (green or amber). Grey means the server is not running.
- Use a **non-virtual** LAN URL. Docker, WSL, VMware, Hyper-V, Tailscale, and similar tools add IPv4 interfaces that the phone cannot route to. The startup log and the pill tooltip flag these with `[virtual — phone probably cannot reach]`; pick a different URL.
- The phone must be on a network that can route to the PC. Public Wi-Fi (especially café/hotel) often blocks peer-to-peer traffic; switch to USB tethering or a phone hotspot.
- A VPN client on the PC sometimes hijacks LAN routing. Disconnect it, or add the LAN range to its split-tunnel exceptions.

Quick test (one-liner, from any shell on the PC) to confirm whether the firewall is the blocker:

```powershell
Test-NetConnection -ComputerName <your-LAN-IP> -Port 7823
```

If `TcpTestSucceeded : True` from the PC but the phone still cannot connect, the firewall rule is missing or wrong-profile. If `TcpTestSucceeded : False` even from the PC itself, the server isn't really listening (check the **Mobile** pill).

> The server binds to `0.0.0.0`. Anyone who can reach the host on port 7823 can drive the assistant — only run the app on networks you trust, or pair this with a firewall rule that allows only your phone's IP.

---

## Basic Workflow

1. Launch the app, confirm API settings, and optionally select specific previous interview summaries. None are selected by default.
2. Start transcription and enable whichever sources you need: `Host`, `Mic`, or both.
3. Click **Screenshot** for one capture plus immediate analysis, or enable **Auto Screen** for repeated capture and streamed analysis.
4. Use the right button for the moment:
   - **Suggest** for 2–4 glanceable cue fragments from the transcript
   - **Ask AI** for concise non-coding cues or a full code-first answer
   - **Screen AI** when the problem is on your screen and you want a direct solution
   - **Notes** to capture a structured record of what was discussed and decided
5. Toggle noisy messages to `Off` before the next AI call so the prompt stays focused on what matters.
6. Optionally use the **mobile companion** on a trusted network to trigger screenshots, ask AI, or run the mic.

## Project Structure (Brief)

- `src/main-process/` is the Electron control plane (startup flow, window behavior, global shortcuts, and IPC registration).
- `src/main-process/features/mobile-server/` is the mobile companion — HTTP + WebSocket server (`server.js`) and the mobile UI (`mobile.html`).
- `src/services/` contains reusable domain logic (Gemini prompts/runtime behavior, AssemblyAI streaming/transcript history, persisted app-state).
- `src/windows/assistant/preload/` is the renderer-safe API boundary (`window.electronAPI` invoke + event wrappers).
- `src/windows/assistant/renderer/features/` contains modular UI logic (chat, listeners, settings, transcription, context bundling, layout).
- `src/windows/legacy/` contains old experiments and is not part of the active runtime path.

Detailed, file-by-file ownership is documented in [`notes.md`](./notes.md).

```text
src/
  bootstrap/             Environment loading, validation, and persistence
  main-process/          Startup orchestration, IPC wiring, window control, assistant runtime
    features/
      mobile-server/     Mobile companion HTTP+WS server and mobile UI HTML
  services/
    ai/                  Gemini service + prompt builders
    assembly-ai/         Streaming STT service + transcript history manager
    state/               App-state load/save helpers
  windows/
    assistant/
      preload/           `window.electronAPI` invoke/listener bridge
      renderer/features/ Renderer feature modules (chat, listeners, settings, transcription, AI context, layout)
      window.js          BrowserWindow creation/config
      renderer.js        Renderer composition root
    legacy/              Older experimental files kept out of the active flow
assets/                  Build icons and packaging assets
cache/                   Generated app state in development
.stealth_screenshots/    Session screenshots in development
dist/                    Packaged build output
repomix-output.txt       Single-file repository snapshot for AI/code review tooling
```

## Shortcuts

All keyboard shortcuts are customizable. Configure them in `src/config.js` to match your preference before building or running the app.

## Scripts

- `npm start` runs the app from source.
- `npm run start:hidden` launches it in background mode from source.
- `npm run dev` enables Electron logging.
- `npm run build:win` creates the portable Windows executable.
- `npm run build` runs the default `electron-builder` flow.

### Test Tiers

- `npm test` runs the fast Node test suite.
- `npm run test:e2e` runs isolated, deterministic Electron scenarios against a loopback fake provider. It uses temporary state, does not read the normal `.env`, app state, or API keys, and blocks external network access.
- `npm run verify` runs the fast tests, Electron E2E suite, and Fedora smoke checks. Its Fedora check runs in isolated no-write mode: it does not inspect the normal `.env` or create a timestamped diagnostics report. Run it after every feature change.
- `npm run verify:live` adds the Portkey model benchmark and realtime STT smoke test. `PORTKEY_API_KEY` is required because the benchmark always uses Portkey. `OPENAI_API_KEY` is optional and only selects direct OpenAI STT; without it, the STT smoke uses the Portkey OpenAI virtual-key fallback. This tier may incur paid provider usage. It does not print credentials or transcript text; STT output is limited to connection/status/error metadata and event/character counts.

## Build

The recommended Windows build is the portable executable:

```powershell
npm run build:win
```

Expected output:

```text
dist/GoogleChrome.exe
```

Notes:

- This is the recommended way to use the app outside development because it gives you a standalone `.exe` to launch directly.
- `.env` is bundled as an extra resource during packaging.
- The current Windows build is configured as a portable `x64` target with:
  - Product name: `Google Chrome (2)`
  - Executable name: `GoogleChrome.exe`
  - App ID: `com.google.chrome`
  - Publisher name: `Google LLC`
- If the build fails with a symlink privilege error, enable Windows Developer Mode or run the build from an elevated terminal.
- The repo already includes [`assets/chrome.ico`](./assets/chrome.ico) for the Windows target. Add `assets/chrome.icns` and `assets/chrome.png` before relying on the macOS or Linux targets defined in `package.json`.

### Running The Built App

After building:

1. Open the `dist/` folder.
2. Run `GoogleChrome.exe`.
3. If you want background launch behavior, either set `START_HIDDEN=true` before building or launch with:

```powershell
.\dist\GoogleChrome.exe --start-hidden
```

### Build Checks

After packaging, verify:

- `dist/GoogleChrome.exe` exists
- the executable shows the Chrome icon
- the app launches correctly without needing `npm start`

For a build-focused walkthrough, see [`BUILD_INSTRUCTIONS.md`](./BUILD_INSTRUCTIONS.md).

## Good Practices

- Keep `src/config.js` as the single source of truth for model lists, programming languages, and keyboard shortcuts.
- When adding or changing environment variables, update all three places together: [`src/bootstrap/environment.js`](./src/bootstrap/environment.js), [`.env.example`](./.env.example), and this README.
- Preserve Electron boundaries: renderer code should go through `preload` and IPC, not import main-process modules directly.
- Keep cursor behavior stealth-safe: interactive controls intentionally do not switch to per-button pointer cursors. This prevents screen-sharing viewers from inferring user actions from cursor-shape changes while hidden mode is active.
- Add new UI logic under `src/windows/assistant/renderer/features/` and new domain logic under `src/services/` or `src/main-process/features/`.
- The mobile server (`src/main-process/features/mobile-server/`) binds to `0.0.0.0`. Anyone who can reach the host on port 7823 can drive the assistant — only run the app on networks you trust, or pair this with a firewall rule that allows only your phone's IP.
- Treat [`src/windows/legacy/`](./src/windows/legacy/) as reference material unless you are intentionally reviving an old experiment.
- Re-test both `npm start` and the relevant packaging path when changing startup flow, window behavior, screenshots, IPC, or global shortcuts.
- Keep real keys out of Git. Use `.env`, and rely on `.env.example` for the documented contract.

## Repomix Snapshot

To regenerate the packed repository snapshot:

```powershell
npx repomix . --style plain -o repomix-output.txt
```

If you want to exclude generated artifacts while experimenting:

```powershell
npx repomix . --style plain -o repomix-output.txt -i "repomix-output.txt,cache/**"
```
## Star History

[![Star History Chart](https://api.star-history.com/svg?repos=shubhamshnd/Open-Cluely&type=Date)](https://star-history.com/#shubhamshnd/Open-Cluely&Date)
