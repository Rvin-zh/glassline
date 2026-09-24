# macOS Notes

Open-Cluely targets macOS as a first-class desktop platform alongside Windows and Fedora.

## Quick start (macOS 13+)

```bash
# Node 20+ recommended (Node 22 verified). Apple Silicon and Intel both work.
npm ci
cp .env.example .env
npm start
```

Useful variants:

```bash
npm run dev            # Electron logging
npm run start:hidden   # background launch
```

## Permissions (one time)

On first launch macOS will prompt for:

- **Microphone** — required for live interview transcription.
- **Screen Recording** — required for **Screenshot**, **Auto Screen**, and the
  host-audio loopback (desktop-capturer). Grant these in
  **System Settings → Privacy & Security → Microphone / Screen Recording**.
  Restart the app after toggling Screen Recording; macOS only re-checks TCC
  consent on launch.

If a prompt is dismissed, re-open it from System Settings. A `NotAllowedError`
  during capture maps to the same System Settings hint inside the app.

## Official hide vs local visibility

The only official screen-capture exclusion on macOS is Electron's
`setContentProtection(true)`. Open-Cluely uses it exclusively — there is no
Linux-style capture bypass, and no third-party hook.

`setContentProtection` is **best-effort**, not a guarantee. It blanks the
overlay from most classic capture paths (`screencapture`, many screen-share
pickers), but some modern macOS capture surfaces — notably ScreenCaptureKit
and certain QuickTime / continuity paths — can still include the window
even when protection is on. Do not assume the overlay is invisible to every
share tool; verify with the manual checklist below before relying on it in a
live call. Zoom, Meet, and QuickTime may still capture the window depending
on the host macOS version and the share source the app selects.

- `HIDE_FROM_SCREEN_CAPTURE=true` (default) calls `setContentProtection(true)`
  so the overlay is blanked from most screen shares and `screencapture`.
- `HIDE_FROM_SCREEN_CAPTURE=false` calls `setContentProtection(false)` and
  the overlay becomes visible in screen shares again.
- Local window visibility (opacity / stealth toggle / emergency hide) is
  separate: it changes what *you* see on your display, not what a screen
  share captures. Use the official hide toggle for share exclusion.

## Unsigned build & Gatekeeper

`npm run build:mac` produces an **unsigned** `.app` inside `dist/` (identity
is `null` in `package.json` so the build never asks for a developer cert).
macOS Gatekeeper will warn that the app "cannot be opened because the
developer cannot be verified." Two ways past it, scoped to **this app's own
unsigned build only**:

1. **Right-click → Open** in Finder, then confirm in the dialog. This is the
   supported path and leaves the rest of your Gatekeeper policy intact.
2. For automation only, strip the quarantine attribute from this app's own
   unsigned build:

   ```bash
   xattr -dr com.apple.quarantine "dist/mac/Open-Cluely.app"
   ```

Do **not** disable Gatekeeper globally (`spctl --master-disable`) or blanket-
allow arbitrary unsigned apps; the `xattr` snippet above is meant only for the
artifact you just built from this source.

## Host-audio loopback limits

Host (system) audio capture on macOS uses the `desktop-capturer` loopback
pipeline: a screen source is captured and its audio track is fed to STT.

- This requires **Screen Recording** consent, not just Microphone consent.
- The loopback is tied to a screen source; if you change displays mid-session
  you may need to restart transcription so a fresh source is selected.
- Browser-based screen shares (Chrome tab share) cannot block microphone
  transcription here — host audio is captured directly from the system
  loopback, not from a tab.

## Screenshots

- **Screenshot** performs one `screenshot-desktop` capture and immediately
  streams Screen AI.
- **Auto Screen** repeats capture + streamed analysis at the configured
  5/10/15/30-second interval (10-second default); only the newest automatic
  capture is retained.
- macOS does not need the XDG portal dance Fedora uses on Wayland; captures
  are direct once Screen Recording is granted.

## Packaging

```bash
npm run build:mac
```

Artifacts land in `dist/`:

- `Open-Cluely-*.dmg` (arm64 + x64)
- `Open-Cluely-*.zip` (arm64 + x64)

The build is configured in `package.json` under `build.mac`:

- `icon`: `assets/open-cluely.icns`
- `hardenedRuntime: true`, `identity: null`, `gatekeeperAssess: false`
- `entitlements` / `entitlementsInherit` live in `packaging/macos/` (outside
  `build/`).
- `NSMicrophoneUsageDescription` and `NSCameraUsageDescription` are declared;
  the camera entitlement is **not** requested (the webcam is never used).

`scripts/smoke-macos.js` validates this contract without invoking
`electron-builder`, so Fedora CI can gate the unsigned Mac packaging without
downloading darwin binaries.

## Transfer a configured build

Linux `cache/app-state.json` keys are encrypted with this machine's keyring
and will not unlock on a Mac. Export a seed on the configured machine, then
build:

```bash
npm run export:settings-seed
npm run build:mac
```

The unsigned zip/dmg includes `.env` plus `settings-seed.json`. On first Mac
launch the app imports Portkey/OpenAI settings and re-encrypts them with
macOS Keychain. Existing usable keys on that Mac are never overwritten.

Send **one** of these (Apple Silicon first):

- `dist/Open-Cluely-<version>-arm64-mac.zip` — Apple Silicon
- `dist/Open-Cluely-<version>-mac.zip` or `*-x64-mac.zip` — Intel

The archive contains your API keys. Treat it like a password: AirDrop or
USB, not email or chat. Do not commit `packaging/macos/settings-seed.json`.

## Manual checklist (out of Fedora CI scope)

These are things a human should eyeball on a real Mac before relying on the
app in a live call. They are not enforced by Fedora CI:

- [ ] Zoom "Share Screen" preview does **not** show the Open-Cluely overlay
      while `HIDE_FROM_SCREEN_CAPTURE=true`.
- [ ] Google Meet "Share your screen" picker behaves the same.
- [ ] `screencapture -x /tmp/shot.png` produces a screenshot where the
      overlay region is blank.
- [ ] Microphone TCC dialog appears on first launch and is granted.
- [ ] Screen Recording TCC dialog appears on first capture and is granted;
      the app is restarted after toggling.
- [ ] After `npm run build:mac`, right-click → Open launches the unsigned
      `.app` without a hard Gatekeeper block.
- [ ] `npm run smoke:macos -- --no-write` passes locally before tagging a
      release.
