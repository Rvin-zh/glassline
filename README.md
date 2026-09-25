# Glassline

Glassline is a desktop overlay for live interviews and meetings. It transcribes system audio and the microphone, captures the screen, and answers from that context in an always-on-top window.

It runs on **macOS** and **Linux**.

**Folio** is the external resume layer. Choose Folio in the overlay to open it beside Interview. Folio writes the ATS-safe resume. It does not run inside the overlay. The program is in [`cv-studio/`](cv-studio/).

Use it only where recording, transcription, screenshots, and AI assistance are allowed.

## Origin

Glassline is an indirect fork of [Open-Cluely](https://github.com/shubhamshnd/Open-Cluely). This repository was not created with GitHub’s Fork button.

[`source/`](source/) is the whole Open-Cluely application: Electron main process, overlay UI, speech-to-text, AI providers, packaging, and tests. Glassline keeps that tree and changes it for Mac and Linux desktops — the glass window, dragging, host audio, speech-to-text sessions, and packaging. Upstream remains the Windows-first project. Glassline treats macOS and Linux as the platforms this tree is maintained for.

The upstream project is MIT licensed. See [shubhamshnd/Open-Cluely](https://github.com/shubhamshnd/Open-Cluely).

## Platforms

| Platform | Guide | Notes |
| --- | --- | --- |
| macOS 13+ | [source/MAC.md](source/MAC.md) | Microphone and Screen Recording prompts. Unsigned builds need a right-click Open the first time. |
| Fedora and other Linux desktops | [source/FEDORA.md](source/FEDORA.md) | XWayland by default on GNOME Wayland. PipeWire for host audio. The overlay can appear in screen shares. |

## Layout

```text
source/          Full Open-Cluely application, with the Glassline desktop changes
  src/           Electron app
  packaging/     macOS entitlements and the settings-seed template
  assets/        Icons
README.md        This page
```

These stay on your machine and are not in git:

- `.env` and `source/packaging/macos/settings-seed.json` (runtime flags and API keys)
- `config/` (browser profile)
- Cursor chat exports and installer archives

## Run from source

Requires Node.js 20 or newer.

```bash
cd source
npm ci
cp .env.example .env
npm start
```

API keys are entered in the in-app Settings panel. `.env` holds flags such as `HIDE_FROM_SCREEN_CAPTURE`, `START_HIDDEN`, and `MAX_SCREENSHOTS`. The template is [`source/.env.example`](source/.env.example).

Platform-specific setup, permissions, and package commands are in [source/MAC.md](source/MAC.md) and [source/FEDORA.md](source/FEDORA.md). Day-to-day behavior of the overlay is documented in [source/README.md](source/README.md).
