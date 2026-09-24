# macOS First-Class Support and Official Capture Hide

## Goal

Make Open-Cluely first-class on macOS in this same Electron repository. The overlay stays visible to the local user and is excluded from macOS screen capture and screen sharing through Electron’s supported `setContentProtection` API. The Fedora/Linux path stays unchanged.

## Non-goals

- No Linux covert capture bypass, PipeWire spoofing, or compositor tricks.
- No Chrome, Google, or other third-party impersonation. The Mac product name, icon, and bundle stay Open-Cluely.
- No Apple Developer ID signing or notarization in this pass. Those need an Apple account and a Mac.
- No live launch of the `.app` on this Fedora machine. Fedora verifies wiring, packaging contracts, and unit/E2E suites only.

## Success criteria

1. `npm run build:mac` produces unsigned `dmg` and `zip` artifacts under `dist/` for `arm64` and `x64`.
2. On macOS, `HIDE_FROM_SCREEN_CAPTURE` defaults to `true` and the assistant window calls `setContentProtection(true)` at create time and again when Settings saves a change.
3. Settings exposes an honest toggle: **Hide overlay from screen sharing**. It is enabled on macOS and Windows. On Linux it is visible, disabled, and explains that capture exclusion is unsupported.
4. Packaged Mac builds include hardened-runtime entitlements and usage strings for microphone and screen recording.
5. `MAC.md` documents run-from-source, Screen Recording / Microphone prompts, the official hide, Gatekeeper on unsigned builds, and host-audio limits.
6. `npm test`, `npm run test:e2e`, and a new Linux-runnable `smoke:macos --no-write` check pass after the work. `npm run verify` includes that smoke check.

## Architecture

Keep one Electron app. Add a small macOS packaging/permissions layer and persist the existing hide flag through Settings.

```text
Settings / .env  →  hideFromScreenCapture
                 →  createAssistantWindow / windowController.applyContentProtection
                 →  BrowserWindow.setContentProtection (darwin, win32 only)

packaging/macos/ →  entitlements + Info.plist usage strings
electron-builder →  Open-Cluely.app / .dmg / .zip
capabilities.js  →  darwin screenshot + host-audio backends
```

Units and responsibilities:

| Unit | Purpose | Depends on |
| --- | --- | --- |
| `src/platform/capabilities.js` | Reports `contentProtectionSupported`, screenshot backend, host-audio backend, and mac permission notes | `process.platform` |
| `src/windows/assistant/window.js` | Creates the overlay; applies dock hide, Mission Control hide, always-on-top, and `setContentProtection` | capabilities + env flag |
| `window-controller` | Re-applies content protection after Settings save without recreating the window | live `BrowserWindow` |
| Settings IPC + panel | Read/write `hideFromScreenCapture`; disable the control on Linux | existing env save path |
| `packaging/macos/` | Entitlements and usage strings committed to git (`build/` is gitignored) | electron-builder |
| `scripts/smoke-macos.js` | Contract checks that run on Linux | files + `package.json` |

## Official hide

“Hidden” means the supported Electron API, not invisibility to the local user.

On macOS and Windows, when `hideFromScreenCapture` is true:

- Call `mainWindow.setContentProtection(true)` after window creation.
- After Settings save, call the same method on the live window so the change applies immediately.
- Keep the window visible, focusable, and usable.

On Linux, never call `setContentProtection`. The toggle stays off-limits and the helper text states that a visible overlay cannot be excluded from PipeWire or compositor capture.

Default remains `HIDE_FROM_SCREEN_CAPTURE=true` in `src/bootstrap/environment.js`. `START_HIDDEN` stays `false`; this work does not change background-launch defaults.

Existing macOS overlay chrome stays:

- `app.dock.hide()`
- `setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true, skipTransformProcessType: true })`
- `setAlwaysOnTop(true, 'pop-up-menu', 1)`
- `setHiddenInMissionControl(true)`
- `skipTaskbar: true`

Do not add fake process names, fake bundle IDs, or Chrome icons on Mac.

## Permissions and packaging

Add committed files under `packaging/macos/`:

- `entitlements.mac.plist` — hardened runtime, `com.apple.security.device.audio-input`, `com.apple.security.cs.allow-jit` (Electron), and no camera entitlement unless a later change actually uses the camera.
- `entitlements.mac.inherit.plist` — helper/inherit entitlements required by electron-builder.

`package.json` `build.mac` becomes:

- `icon`: `assets/open-cluely.icns` generated from `assets/open-cluely.png`
- `category`: `public.app-category.productivity`
- `hardenedRuntime`: `true`
- `gatekeeperAssess`: `false`
- `identity`: `null` (unsigned in this pass)
- `entitlements` / `entitlementsInherit`: the packaging files above
- `target`: `dmg` and `zip` for `arm64` and `x64`
- `extendInfo` usage strings only:
  - `NSMicrophoneUsageDescription`: Open-Cluely needs the microphone for live interview transcription.
  - `NSCameraUsageDescription`: Open-Cluely does not use the webcam. Chromium’s desktop-capture pipeline requires this string for Screenshot, Auto Screen, and host-audio loopback.
  - Do not add `com.apple.security.device.camera`. Screen Recording remains a user TCC grant, not a camera-hardware entitlement.

Screen Recording and Microphone remain user-granted TCC permissions. The app must not try to bypass System Settings. If mic or host-audio start fails with a permission error, the UI shows an actionable message to open **System Settings → Privacy & Security**.

`scripts/run-build.js` already maps `darwin` to `--mac`. Keep `npm run build:mac`. On Linux, electron-builder may emit unsigned darwin artifacts; if the host cannot download darwin Electron binaries, the packaging smoke still checks config and files, and the build failure message must be explicit.

Do not put entitlements under `build/`; that directory is gitignored.

## Screenshots and host audio

Darwin screenshot backend stays `screenshot-desktop`, with the existing `desktopCapturer` fallback. During this app’s own capture, keep the current non-Linux behavior: drop opacity briefly so the overlay does not photograph itself. That is separate from `setContentProtection`.

Darwin host audio stays `desktop-capturer-loopback`. Document the macOS limit honestly: Chromium loopback needs Screen Recording permission and may not match Fedora’s PipeWire monitor completeness. Microphone capture uses standard `getUserMedia` plus the audio-input entitlement.

No new native Swift/Objective-C screen or audio helpers in this pass.

## Settings and diagnostics

Add **Hide overlay from screen sharing** next to Window Opacity.

- macOS/Windows: selectable; saved through the existing environment writer; applied immediately.
- Linux: control disabled; helper text explains the platform limit.
- Platform diagnostics in Settings include `contentProtectionSupported`, `contentProtectionActive`, screenshot backend, and host-audio backend on every OS, not only Fedora.

`save-settings` must persist `hideFromScreenCapture` from the payload instead of always rewriting the previous env value.

## Documentation

Add `MAC.md` in the same style as `FEDORA.md`:

- `npm ci` and `npm start` on macOS
- First-run Microphone and Screen Recording prompts
- What the official hide does and does not do
- Unsigned build / Gatekeeper (`xattr` / right-click Open) without presenting that as a bypass tutorial for other software
- Host-audio and screenshot limits
- `npm run build:mac`

Update `README.md` so macOS is listed as first-class alongside Fedora. Point Mac packaging at `MAC.md` and `assets/open-cluely.icns`. Do not expand the leftover Chrome-disguise `BUILD_INSTRUCTIONS.md`.

## Testing and verification

Linux-runnable tests (required after each change):

- Darwin capability matrix: `contentProtectionSupported=true`, `screenshotBackend=screenshot-desktop`, `hostAudioBackend=desktop-capturer-loopback`.
- Content-protection helper: applies `true`/`false` on darwin/win32 mocks; never calls the API on linux mocks.
- Settings contract: save payload includes the hide flag; Linux UI state is disabled.
- Packaging contract (`scripts/smoke-macos.js` and a unit test): `open-cluely.icns` exists, entitlements exist outside `build/`, `package.json` mac targets/identity/icon match this spec.
- Existing Fedora E2E suite keeps passing.

`npm run verify` = `npm test && npm run test:e2e && npm run smoke:fedora -- --no-write && npm run smoke:macos -- --no-write`.

Out of Fedora scope: real macOS TCC dialogs, real `setContentProtection` vs Zoom/Meet pixels, and Gatekeeper on a downloaded dmg. Those are a short manual checklist in `MAC.md`.

## Error handling

- Missing `.icns` or entitlements fail `smoke:macos` and `build:mac` with a file-path error, not a generic electron-builder stack.
- Permission-denied mic/host-audio errors map to a stable code and a System Settings hint; they do not crash the renderer.
- If `setContentProtection` throws on an unexpected platform build, log a warning and continue. The window must still open.

## Rollout

Ship in this repo as a normal feature. Users on a Mac run from source or open the unsigned `.app` with Gatekeeper’s explicit Open. Signing/notarization is a later pass if an Apple Developer account is available.
