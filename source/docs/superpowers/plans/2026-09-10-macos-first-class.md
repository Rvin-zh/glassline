# macOS First-Class Support Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make Open-Cluely first-class on macOS in this same Electron repo, with official `setContentProtection` hide, entitlements, Settings toggle, and Linux-runnable packaging checks.

**Architecture:** Keep one Electron app. Extract small platform helpers for content protection, hide-flag persistence, Settings control state, permission errors, and packaging contracts. Wire those helpers into the existing window, Settings IPC, and electron-builder Mac target. Do not add native Swift helpers or a second codebase.

**Tech Stack:** Node 20+ test runner, Electron 44, electron-builder 26, existing Settings/env persistence, no new npm dependencies.

## Global Constraints

- No Linux covert capture bypass, PipeWire spoofing, or compositor tricks.
- No Chrome, Google, or other third-party impersonation. Mac product name, icon, and bundle stay Open-Cluely (`com.opencluely.assistant`).
- No Apple Developer ID signing or notarization. `build.mac.identity` is `null`.
- Do not live-launch the `.app` on Fedora. Verify with unit tests, existing E2E, and `smoke:macos --no-write`.
- `HIDE_FROM_SCREEN_CAPTURE` default stays `true`. `START_HIDDEN` stays `false`.
- Do not put entitlements under `build/` (gitignored). Use `packaging/macos/`.
- Commit only files named in the current task. Do not stage unrelated already-dirty Fedora files.
- After each task, run that task’s tests. After the last task, run `npm run verify`.
- Exact Settings label: `Hide overlay from screen sharing`.
- Exact Linux helper: `Linux cannot exclude a visible overlay from PipeWire or compositor capture.`
- Exact supported helper: `Keeps this overlay visible on your screen and excludes it from Zoom, Meet, and other screen sharing on macOS and Windows.`
- Exact macOS permission hint: `Open System Settings → Privacy & Security and allow Microphone or Screen Recording for Open-Cluely.`
- Exact usage strings:
  - `NSMicrophoneUsageDescription`: `Open-Cluely needs the microphone for live interview transcription.`
  - `NSCameraUsageDescription`: `Open-Cluely does not use the webcam. Chromium’s desktop-capture pipeline requires this string for Screenshot, Auto Screen, and host-audio loopback.`

## File Structure

- Create: `src/platform/content-protection.js` — apply/never-call `setContentProtection`
- Create: `src/platform/hide-from-screen-capture.js` — resolve persisted hide flag
- Create: `src/windows/assistant/renderer/features/settings/hide-overlay-control.js` — Settings control state
- Create: `src/platform/capture-permission-error.js` — stable permission codes and hints
- Create: `src/platform/macos-packaging-contract.js` — file/config contract
- Create: `src/platform/platform-diagnostics.js` — diagnostics view including `contentProtectionActive`
- Create: `packaging/macos/entitlements.mac.plist`
- Create: `packaging/macos/entitlements.mac.inherit.plist`
- Create: `scripts/generate-mac-icon.js`
- Create: `scripts/smoke-macos.js`
- Create: `assets/open-cluely.icns`
- Create: `MAC.md`
- Create: `test/macos-capabilities.test.js`
- Create: `test/content-protection.test.js`
- Create: `test/hide-from-screen-capture.test.js`
- Create: `test/hide-overlay-control.test.js`
- Create: `test/capture-permission-error.test.js`
- Create: `test/macos-packaging.test.js`
- Create: `test/macos-diagnostics.test.js`
- Modify: `src/platform/capabilities.js` — accept overrides; darwin notes
- Modify: `src/windows/assistant/window.js` — use `applyContentProtection`
- Modify: `src/main-process/features/window/window-controller.js` — re-apply on save
- Modify: `src/main-process/features/settings/ipc.js` — persist hide flag from payload
- Modify: `src/windows/assistant/renderer.html` — hide toggle next to opacity
- Modify: `src/windows/assistant/renderer.js` — wire toggle element
- Modify: `src/windows/assistant/renderer/features/settings/settings-panel-manager.js`
- Modify: `src/windows/assistant/renderer/features/transcription/transcription-manager.js`
- Modify: `src/main-process/start-application.js` — diagnostics view
- Modify: `scripts/run-build.js` — fail `--mac` on contract errors
- Modify: `package.json` — mac target, `smoke:macos`, `verify`
- Modify: `assets/README.md`
- Modify: `README.md`

---

### Task 1: Darwin capability matrix

**Files:**
- Modify: `src/platform/capabilities.js`
- Test: `test/macos-capabilities.test.js`

**Interfaces:**
- Consumes: `detectPlatformCapabilities(overrides?: { platform?: string, sessionType?: string, linuxDisplayProfile?: string })`
- Produces: for `{ platform: 'darwin' }`, `{ contentProtectionSupported: true, screenshotBackend: 'screenshot-desktop', hostAudioBackend: 'desktop-capturer-loopback' }` plus a Privacy & Security note

- [ ] **Step 1: Write the failing test**

Create `test/macos-capabilities.test.js`:

```js
'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { detectPlatformCapabilities } = require('../src/platform/capabilities');

describe('macOS capability matrix', () => {
  it('reports official hide, screenshot-desktop, and desktop-capturer loopback on darwin', () => {
    const capabilities = detectPlatformCapabilities({ platform: 'darwin' });
    assert.equal(capabilities.platform, 'darwin');
    assert.equal(capabilities.contentProtectionSupported, true);
    assert.equal(capabilities.screenshotBackend, 'screenshot-desktop');
    assert.equal(capabilities.hostAudioBackend, 'desktop-capturer-loopback');
    assert.equal(capabilities.linuxDisplayProfile, null);
    assert.equal(
      capabilities.notes.includes(
        'Microphone and Screen Recording are granted in System Settings → Privacy & Security.'
      ),
      true
    );
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run:

```bash
node --test --test-reporter=spec test/macos-capabilities.test.js
```

Expected: FAIL because `detectPlatformCapabilities` ignores overrides and uses `process.platform`.

- [ ] **Step 3: Write minimal implementation**

In `src/platform/capabilities.js`, change `detectPlatformCapabilities` to accept `overrides = {}` and resolve `platform` from `overrides.platform || process.platform`. Keep existing Linux/Windows branches. When `platform === 'darwin'`, set `linuxDisplayProfile` to `null` and append this note:

```js
'Microphone and Screen Recording are granted in System Settings → Privacy & Security.'
```

Do not add camera-hardware notes. Do not change Linux default display profile behavior when `overrides` is empty.

- [ ] **Step 4: Run test to verify it passes**

Run:

```bash
node --test --test-reporter=spec test/macos-capabilities.test.js test/fedora-ui-performance.test.js
```

Expected: PASS. Existing Fedora ozone tests still pass, including the darwin launch-args case that returns `[]`.

- [ ] **Step 5: Commit**

```bash
git add test/macos-capabilities.test.js src/platform/capabilities.js
git commit -m "feat: report darwin capture and hide capabilities"
```

---

### Task 2: Official content-protection helper

**Files:**
- Create: `src/platform/content-protection.js`
- Modify: `src/windows/assistant/window.js`
- Test: `test/content-protection.test.js`

**Interfaces:**
- Consumes: `applyContentProtection(browserWindow, { hideFromScreenCapture, contentProtectionSupported })`
- Produces: `{ applied: boolean, active: boolean, reason?: 'unsupported' | 'threw' | 'no-window' }`
- Later tasks call the same function from `window-controller`

- [ ] **Step 1: Write the failing test**

Create `test/content-protection.test.js`:

```js
'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { applyContentProtection } = require('../src/platform/content-protection');

function createFakeWindow({ throwOnCall = false } = {}) {
  const calls = [];
  return {
    calls,
    isDestroyed: () => false,
    setContentProtection(value) {
      if (throwOnCall) {
        throw new Error('unexpected platform');
      }
      calls.push(value);
    }
  };
}

describe('applyContentProtection', () => {
  it('enables and disables hide on supported platforms', () => {
    const window = createFakeWindow();
    assert.deepEqual(
      applyContentProtection(window, {
        hideFromScreenCapture: true,
        contentProtectionSupported: true
      }),
      { applied: true, active: true }
    );
    assert.deepEqual(
      applyContentProtection(window, {
        hideFromScreenCapture: false,
        contentProtectionSupported: true
      }),
      { applied: true, active: false }
    );
    assert.deepEqual(window.calls, [true, false]);
  });

  it('never calls setContentProtection on Linux', () => {
    const window = createFakeWindow();
    assert.deepEqual(
      applyContentProtection(window, {
        hideFromScreenCapture: true,
        contentProtectionSupported: false
      }),
      { applied: false, active: false, reason: 'unsupported' }
    );
    assert.deepEqual(window.calls, []);
  });

  it('logs a warning and continues when setContentProtection throws', () => {
    const window = createFakeWindow({ throwOnCall: true });
    const result = applyContentProtection(window, {
      hideFromScreenCapture: true,
      contentProtectionSupported: true
    });
    assert.deepEqual(result, { applied: false, active: false, reason: 'threw' });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run:

```bash
node --test --test-reporter=spec test/content-protection.test.js
```

Expected: FAIL with `Cannot find module '../src/platform/content-protection'`.

- [ ] **Step 3: Write minimal implementation**

Create `src/platform/content-protection.js`:

```js
'use strict';

function applyContentProtection(browserWindow, {
  hideFromScreenCapture,
  contentProtectionSupported
} = {}) {
  if (!browserWindow || (typeof browserWindow.isDestroyed === 'function' && browserWindow.isDestroyed())) {
    return { applied: false, active: false, reason: 'no-window' };
  }

  if (!contentProtectionSupported) {
    return { applied: false, active: false, reason: 'unsupported' };
  }

  try {
    const active = hideFromScreenCapture === true;
    browserWindow.setContentProtection(active);
    return { applied: true, active };
  } catch (error) {
    console.warn('setContentProtection failed:', error?.message || error);
    return { applied: false, active: false, reason: 'threw' };
  }
}

module.exports = {
  applyContentProtection
};
```

In `src/windows/assistant/window.js`, replace the inline `if (platformCapabilities.contentProtectionSupported)` block with:

```js
const { applyContentProtection } = require('../../platform/content-protection');
applyContentProtection(mainWindow, {
  hideFromScreenCapture,
  contentProtectionSupported: platformCapabilities.contentProtectionSupported
});
```

Keep the existing darwin dock / Mission Control / always-on-top block unchanged.

- [ ] **Step 4: Run test to verify it passes**

Run:

```bash
node --test --test-reporter=spec test/content-protection.test.js
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/platform/content-protection.js src/windows/assistant/window.js test/content-protection.test.js
git commit -m "feat: apply official content protection through a helper"
```

---

### Task 3: Persist hide flag and re-apply on save

**Files:**
- Create: `src/platform/hide-from-screen-capture.js`
- Modify: `src/main-process/features/settings/ipc.js`
- Modify: `src/main-process/features/window/window-controller.js`
- Test: `test/hide-from-screen-capture.test.js`

**Interfaces:**
- Consumes: `resolveHideFromScreenCapture(payloadValue, currentValue)` and `windowController.applyContentProtection()`
- Produces: boolean hide flag written to `saveApplicationEnvironment`; live window updated without recreate

- [ ] **Step 1: Write the failing test**

Create `test/hide-from-screen-capture.test.js`:

```js
'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const {
  resolveHideFromScreenCapture
} = require('../src/platform/hide-from-screen-capture');
const { createWindowController } = require('../src/main-process/features/window/window-controller');
const { registerSettingsIpc } = require('../src/main-process/features/settings/ipc');

describe('hide-from-screen-capture persistence', () => {
  it('keeps the current value when the payload omits the flag', () => {
    assert.equal(resolveHideFromScreenCapture(undefined, true), true);
    assert.equal(resolveHideFromScreenCapture(null, false), false);
  });

  it('accepts boolean and string payload values', () => {
    assert.equal(resolveHideFromScreenCapture(false, true), false);
    assert.equal(resolveHideFromScreenCapture('true', false), true);
  });

  it('re-applies content protection on the live window after settings save', async () => {
    const protectionCalls = [];
    const savedEnv = [];
    let currentHide = true;
    const fakeWindow = {
      isDestroyed: () => false,
      setContentProtection(value) {
        protectionCalls.push(value);
      },
      setOpacity() {},
      getBounds() {
        return { x: 0, y: 0, width: 900, height: 400 };
      }
    };

    const windowController = createWindowController({
      app: { dock: { hide() {} } },
      screen: {
        getPrimaryDisplay: () => ({ workArea: { x: 0, y: 0, width: 1440, height: 900 }, workAreaSize: { width: 1440, height: 900 } }),
        getDisplayMatching: () => ({ workArea: { x: 0, y: 0, width: 1440, height: 900 } })
      },
      globalShortcut: { register() { return true; }, unregisterAll() {} },
      createAssistantWindow: () => fakeWindow,
      getAppEnvironment: () => ({ hideFromScreenCapture: currentHide, nodeEnv: 'production' }),
      emitSttDebug() {},
      sendToRenderer() {},
      onTakeStealthScreenshot() {}
    });
    windowController.createWindow({
      platformCapabilities: { contentProtectionSupported: true }
    });

    const handlers = new Map();
    registerSettingsIpc({
      ipcMain: { handle(channel, handler) { handlers.set(channel, handler); } },
      app: {},
      getAppEnvironment: () => ({
        hideFromScreenCapture: currentHide,
        startHidden: false,
        maxScreenshots: 50,
        screenshotDelay: 300,
        nodeEnv: 'production',
        nodeOptions: '--max-old-space-size=4096'
      }),
      setAppEnvironment(next) {
        currentHide = next.hideFromScreenCapture;
      },
      getAppState: () => ({}),
      setAppState() {},
      getAppStatePath: () => '/tmp/app-state.json',
      saveApplicationEnvironment(_app, values) {
        savedEnv.push(values);
        currentHide = values.hideFromScreenCapture;
        return { envPath: '/tmp/.env', ...values };
      },
      saveAppState: (_app, values) => values,
      geminiRuntime: {
        setActiveAiProvider: (value) => value || 'portkey',
        setActivePortkeyProvider: (value) => value || '@vertex',
        setActivePortkeyBaseUrl: (value) => value || '',
        setActiveGeminiModel: (value) => value || 'gemini-3.8-flash',
        setActiveProgrammingLanguage: (value) => value || 'Python',
        setActiveWebSearchEnabled() {},
        setActivePortkeyApiKey() {},
        setKeys: () => ({ activeApiKeyIndex: 0 }),
        getActiveAiProvider: () => 'portkey',
        getActiveGeminiModel: () => 'gemini-3.8-flash',
        getActiveProgrammingLanguage: () => 'Python',
        getAvailableGeminiModels: () => ['gemini-3.8-flash'],
        getAvailableAiProviders: () => ['gemini', 'portkey'],
        getAvailablePortkeyProviders: () => ['@vertex'],
        getDefaultAiProvider: () => 'portkey',
        getDefaultGeminiModel: () => 'gemini-3.8-flash',
        getDefaultPortkeyProvider: () => '@vertex',
        getDefaultProgrammingLanguage: () => 'Python',
        getAvailableProgrammingLanguages: () => ['Python'],
        initializePortkeyService() {},
        initializeGeminiService() {},
        getLastExecutionDiagnostics: () => null
      },
      windowController,
      getAssemblyAiSpeechModel: () => 'universal-streaming-english',
      setAssemblyAiSpeechModel: (model) => model,
      getSttProvider: () => 'openai',
      setSttProvider: (provider) => provider,
      getOpenAiSttModel: () => 'gpt-live-transcribe',
      setOpenAiSttModel: (model) => model,
      getSttSampleRate: () => 24000,
      keyboardShortcuts: [],
      assemblyAiSpeechModels: ['universal-streaming-english'],
      defaultAssemblyAiSpeechModel: 'universal-streaming-english',
      getMemoryStatus: () => null,
      getPromptCacheDiagnostics: () => ({})
    });

    const result = await handlers.get('save-settings')(null, {
      hideFromScreenCapture: false,
      windowOpacityLevel: 10
    });
    assert.equal(result.success, true);
    assert.equal(savedEnv[0].hideFromScreenCapture, false);
    assert.deepEqual(protectionCalls.at(-1), false);
  });
});
```

If `createAiRuntime` from `test/settings-model-fallback.test.js` is easier to reuse than the inline stub, use that runtime instead of the large `geminiRuntime` object, but the assertions above must stay.

- [ ] **Step 2: Run test to verify it fails**

Run:

```bash
node --test --test-reporter=spec test/hide-from-screen-capture.test.js
```

Expected: FAIL because the helper is missing and `save-settings` rewrites the previous env hide flag.

- [ ] **Step 3: Write minimal implementation**

Create `src/platform/hide-from-screen-capture.js`:

```js
'use strict';

function resolveHideFromScreenCapture(payloadValue, currentValue) {
  if (payloadValue == null || payloadValue === '') {
    return currentValue === true;
  }
  if (payloadValue === true || payloadValue === false) {
    return payloadValue;
  }
  const normalized = String(payloadValue).trim().toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(normalized)) {
    return true;
  }
  if (['0', 'false', 'no', 'off'].includes(normalized)) {
    return false;
  }
  return currentValue === true;
}

module.exports = {
  resolveHideFromScreenCapture
};
```

In `save-settings`, replace `hideFromScreenCapture: appEnvironment.hideFromScreenCapture` with:

```js
const { resolveHideFromScreenCapture } = require('../../../platform/hide-from-screen-capture');
const nextHideFromScreenCapture = resolveHideFromScreenCapture(
  settings.hideFromScreenCapture,
  appEnvironment.hideFromScreenCapture
);
```

Pass `hideFromScreenCapture: nextHideFromScreenCapture` into `saveApplicationEnvironment`. After `setAppEnvironment(updatedEnvironment)`, call `windowController.applyContentProtection?.()`.

In `window-controller.js`:

```js
const { applyContentProtection } = require('../../../platform/content-protection');

function applyContentProtectionToWindow() {
  const appEnvironment = getAppEnvironment();
  const capabilities = lastPlatformCapabilities || {};
  return applyContentProtection(mainWindow, {
    hideFromScreenCapture: appEnvironment.hideFromScreenCapture,
    contentProtectionSupported: capabilities.contentProtectionSupported === true
  });
}
```

Export `applyContentProtection: applyContentProtectionToWindow` from the controller public object.

- [ ] **Step 4: Run test to verify it passes**

Run:

```bash
node --test --test-reporter=spec test/hide-from-screen-capture.test.js test/settings-model-fallback.test.js
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/platform/hide-from-screen-capture.js src/main-process/features/settings/ipc.js src/main-process/features/window/window-controller.js test/hide-from-screen-capture.test.js
git commit -m "feat: persist and re-apply overlay hide from settings"
```

---

### Task 4: Settings hide toggle

**Files:**
- Create: `src/windows/assistant/renderer/features/settings/hide-overlay-control.js`
- Modify: `src/windows/assistant/renderer.html`
- Modify: `src/windows/assistant/renderer.js`
- Modify: `src/windows/assistant/renderer/features/settings/settings-panel-manager.js`
- Modify: `src/main-process/features/settings/ipc.js`
- Test: `test/hide-overlay-control.test.js`

**Interfaces:**
- Consumes: `resolveHideOverlayControlState({ platform, contentProtectionSupported, hideFromScreenCapture })`
- Produces: `{ enabled: boolean, checked: boolean, helperText: string }` and a Settings `<select id="setting-hide-from-screen-capture">`

- [ ] **Step 1: Write the failing test**

Create `test/hide-overlay-control.test.js`:

```js
'use strict';

const fs = require('fs');
const path = require('path');
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const {
  resolveHideOverlayControlState,
  HIDE_OVERLAY_LINUX_HELP,
  HIDE_OVERLAY_SUPPORTED_HELP
} = require('../src/windows/assistant/renderer/features/settings/hide-overlay-control');

const rendererHtml = fs.readFileSync(
  path.join(__dirname, '..', 'src', 'windows', 'assistant', 'renderer.html'),
  'utf8'
);

describe('hide overlay settings control', () => {
  it('enables the control on macOS and Windows', () => {
    assert.deepEqual(
      resolveHideOverlayControlState({
        platform: 'darwin',
        contentProtectionSupported: true,
        hideFromScreenCapture: true
      }),
      { enabled: true, checked: true, helperText: HIDE_OVERLAY_SUPPORTED_HELP }
    );
  });

  it('disables the control on Linux and explains the limit', () => {
    assert.deepEqual(
      resolveHideOverlayControlState({
        platform: 'linux',
        contentProtectionSupported: false,
        hideFromScreenCapture: true
      }),
      { enabled: false, checked: false, helperText: HIDE_OVERLAY_LINUX_HELP }
    );
  });

  it('places the labeled control next to window opacity', () => {
    assert.match(rendererHtml, /id="setting-hide-from-screen-capture"/);
    assert.match(rendererHtml, /Hide overlay from screen sharing/);
    const opacityIndex = rendererHtml.indexOf('setting-window-opacity');
    const hideIndex = rendererHtml.indexOf('setting-hide-from-screen-capture');
    assert.equal(hideIndex > opacityIndex, true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run:

```bash
node --test --test-reporter=spec test/hide-overlay-control.test.js
```

Expected: FAIL because the helper module and HTML control are missing.

- [ ] **Step 3: Write minimal implementation**

Create `src/windows/assistant/renderer/features/settings/hide-overlay-control.js`:

```js
'use strict';

const HIDE_OVERLAY_LINUX_HELP =
  'Linux cannot exclude a visible overlay from PipeWire or compositor capture.';
const HIDE_OVERLAY_SUPPORTED_HELP =
  'Keeps this overlay visible on your screen and excludes it from Zoom, Meet, and other screen sharing on macOS and Windows.';

function resolveHideOverlayControlState({
  platform,
  contentProtectionSupported,
  hideFromScreenCapture
} = {}) {
  const enabled = contentProtectionSupported === true || platform === 'darwin' || platform === 'win32';
  return {
    enabled,
    checked: enabled ? hideFromScreenCapture === true : false,
    helperText: enabled ? HIDE_OVERLAY_SUPPORTED_HELP : HIDE_OVERLAY_LINUX_HELP
  };
}

module.exports = {
  HIDE_OVERLAY_LINUX_HELP,
  HIDE_OVERLAY_SUPPORTED_HELP,
  resolveHideOverlayControlState
};
```

Keep `hide-overlay-control.js` as CJS. `get-settings` returns:

```js
hideOverlayControl: resolveHideOverlayControlState({
  platform: process.platform,
  contentProtectionSupported: detectPlatformCapabilities().contentProtectionSupported,
  hideFromScreenCapture: appEnvironment.hideFromScreenCapture
})
```

The renderer only applies that payload to the `<select>`: `value` `'true'`/`'false'`, `disabled = !enabled`, and helper text. Do not import the CJS helper into the ESM settings panel.

Add this HTML immediately after the Window Opacity `settings-group`:

```html
        <div class="settings-group">
          <label class="settings-label" for="setting-hide-from-screen-capture">Hide overlay from screen sharing</label>
          <select id="setting-hide-from-screen-capture" class="settings-input">
            <option value="true">On</option>
            <option value="false">Off</option>
          </select>
          <div id="setting-hide-from-screen-capture-help" class="settings-helper-text"></div>
        </div>
```

In `renderer.js`, add:

```js
const settingHideFromScreenCapture = document.getElementById('setting-hide-from-screen-capture');
const settingHideFromScreenCaptureHelp = document.getElementById('setting-hide-from-screen-capture-help');
```

Pass both into `createSettingsPanelManager`.

In `openSettings`, apply:

```js
const hideOverlayControl = settings.hideOverlayControl || {
  enabled: settings.contentProtectionSupported === true,
  checked: settings.hideFromScreenCapture === true,
  helperText: ''
};
if (settingHideFromScreenCapture) {
  settingHideFromScreenCapture.value = hideOverlayControl.checked ? 'true' : 'false';
  settingHideFromScreenCapture.disabled = hideOverlayControl.enabled !== true;
}
if (settingHideFromScreenCaptureHelp) {
  settingHideFromScreenCaptureHelp.textContent = hideOverlayControl.helperText || '';
}
```

In `saveSettings`, include:

```js
hideFromScreenCapture: settingHideFromScreenCapture?.value === 'true'
```

On Linux the control is disabled, so the saved value is `false` unless you read `settings.hideFromScreenCapture` when disabled. When `settingHideFromScreenCapture.disabled` is true, send `undefined` so `resolveHideFromScreenCapture` keeps the current env value:

```js
hideFromScreenCapture: settingHideFromScreenCapture && !settingHideFromScreenCapture.disabled
  ? settingHideFromScreenCapture.value === 'true'
  : undefined
```

- [ ] **Step 4: Run test to verify it passes**

Run:

```bash
node --test --test-reporter=spec test/hide-overlay-control.test.js test/hide-from-screen-capture.test.js
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/windows/assistant/renderer/features/settings/hide-overlay-control.js src/windows/assistant/renderer.html src/windows/assistant/renderer.js src/windows/assistant/renderer/features/settings/settings-panel-manager.js src/main-process/features/settings/ipc.js test/hide-overlay-control.test.js
git commit -m "feat: add hide-from-screen-sharing settings control"
```

---

### Task 5: macOS privacy permission errors

**Files:**
- Create: `src/platform/capture-permission-error.js`
- Modify: `src/windows/assistant/renderer/features/transcription/transcription-manager.js`
- Test: `test/capture-permission-error.test.js`

**Interfaces:**
- Consumes: `classifyCapturePermissionError(error, platform)`
- Produces: `{ code: 'MACOS_PRIVACY_DENIED' | 'CAPTURE_PERMISSION_DENIED' | 'CAPTURE_FAILED', hint: string | null }`

- [ ] **Step 1: Write the failing test**

Create `test/capture-permission-error.test.js`:

```js
'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const {
  classifyCapturePermissionError,
  MACOS_PRIVACY_HINT
} = require('../src/platform/capture-permission-error');

describe('capture permission errors', () => {
  it('maps macOS TCC and NotAllowed errors to a System Settings hint', () => {
    assert.deepEqual(
      classifyCapturePermissionError(new Error('NotAllowedError: Permission denied'), 'darwin'),
      { code: 'MACOS_PRIVACY_DENIED', hint: MACOS_PRIVACY_HINT }
    );
    assert.deepEqual(
      classifyCapturePermissionError(new Error('screen recording permission'), 'darwin'),
      { code: 'MACOS_PRIVACY_DENIED', hint: MACOS_PRIVACY_HINT }
    );
  });

  it('does not treat ordinary capture failures as privacy denials', () => {
    assert.deepEqual(
      classifyCapturePermissionError(new Error('desktop capturer returned an empty thumbnail'), 'darwin'),
      { code: 'CAPTURE_FAILED', hint: null }
    );
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run:

```bash
node --test --test-reporter=spec test/capture-permission-error.test.js
```

Expected: FAIL because the module is missing.

- [ ] **Step 3: Write minimal implementation**

Create `src/platform/capture-permission-error.js`:

```js
'use strict';

const MACOS_PRIVACY_HINT =
  'Open System Settings → Privacy & Security and allow Microphone or Screen Recording for Open-Cluely.';

function classifyCapturePermissionError(error, platform) {
  const message = String(error?.name ? `${error.name} ${error.message}` : error?.message || error || '');
  const isPermission = /notallowed|permission|denied|tcc|screen recording/i.test(message);
  if (!isPermission) {
    return { code: 'CAPTURE_FAILED', hint: null };
  }
  if (platform === 'darwin') {
    return { code: 'MACOS_PRIVACY_DENIED', hint: MACOS_PRIVACY_HINT };
  }
  return {
    code: 'CAPTURE_PERMISSION_DENIED',
    hint: 'Grant microphone or screen-capture permission and try again.'
  };
}

function formatCapturePermissionMessage(error, platform) {
  const classified = classifyCapturePermissionError(error, platform);
  const base = error?.message || 'Capture failed';
  return classified.hint ? `${base} ${classified.hint}` : base;
}

module.exports = {
  MACOS_PRIVACY_HINT,
  classifyCapturePermissionError,
  formatCapturePermissionMessage
};
```

Create ESM `src/windows/assistant/renderer/features/transcription/capture-permission-message.js` with the same `MACOS_PRIVACY_HINT`, regex, `classifyCapturePermissionError`, and `formatCapturePermissionMessage` bodies as the CJS module. Import that ESM file from `transcription-manager.js`. Keep Node tests on the CJS module.

In mic and system-audio `catch` blocks:

```js
const platform = window.electronAPI?.platform || '';
const message = formatCapturePermissionMessage(error, platform);
showFeedback(`Mic failed: ${message}`, 'error');
```

Add `platform: process.platform` on `electronAPI` in `src/windows/assistant/preload.js` if that field is missing.

- [ ] **Step 4: Run test to verify it passes**

Run:

```bash
node --test --test-reporter=spec test/capture-permission-error.test.js
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/platform/capture-permission-error.js src/windows/assistant/renderer/features/transcription/transcription-manager.js src/windows/assistant/preload.js test/capture-permission-error.test.js
git commit -m "fix: map macOS capture denials to System Settings"
```

If a renderer-local ESM copy was required, add that file to the same commit.

---

### Task 6: Unsigned Mac packaging contract

**Files:**
- Create: `packaging/macos/entitlements.mac.plist`
- Create: `packaging/macos/entitlements.mac.inherit.plist`
- Create: `scripts/generate-mac-icon.js`
- Create: `src/platform/macos-packaging-contract.js`
- Create: `scripts/smoke-macos.js`
- Create: `assets/open-cluely.icns`
- Modify: `package.json`
- Modify: `scripts/run-build.js`
- Modify: `assets/README.md`
- Test: `test/macos-packaging.test.js`

**Interfaces:**
- Consumes: `loadMacPackagingContract(rootDir)` → file existence + `package.json` mac fields
- Produces: `evaluateMacPackagingContract(contract) => { ok: boolean, errors: string[] }` used by `smoke:macos` and `run-build.js --mac`

- [ ] **Step 1: Write the failing test**

Create `test/macos-packaging.test.js`:

```js
'use strict';

const path = require('path');
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const {
  evaluateMacPackagingContract,
  loadMacPackagingContract
} = require('../src/platform/macos-packaging-contract');

describe('macOS packaging contract', () => {
  it('requires icns, entitlements outside build/, and unsigned dmg+zip targets', () => {
    const contract = loadMacPackagingContract(path.join(__dirname, '..'));
    const result = evaluateMacPackagingContract(contract);
    assert.deepEqual(result.errors, []);
    assert.equal(result.ok, true);
    assert.equal(contract.icon, 'assets/open-cluely.icns');
    assert.equal(contract.identity, null);
    assert.equal(contract.hardenedRuntime, true);
    assert.equal(contract.entitlements.includes('build/'), false);
    assert.deepEqual(contract.targetNames.sort(), ['dmg', 'zip']);
    assert.deepEqual(contract.arches.sort(), ['arm64', 'x64']);
    assert.match(contract.microphoneUsage, /live interview transcription/);
    assert.match(contract.cameraUsage, /does not use the webcam/);
    assert.equal(contract.hasCameraEntitlement, false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run:

```bash
node --test --test-reporter=spec test/macos-packaging.test.js
```

Expected: FAIL because the contract module and packaging files are missing.

- [ ] **Step 3: Write packaging files and contract**

`packaging/macos/entitlements.mac.plist`:

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
  <dict>
    <key>com.apple.security.cs.allow-jit</key>
    <true/>
    <key>com.apple.security.device.audio-input</key>
    <true/>
  </dict>
</plist>
```

`packaging/macos/entitlements.mac.inherit.plist`:

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
  <dict>
    <key>com.apple.security.cs.allow-jit</key>
    <true/>
    <key>com.apple.security.inherit</key>
    <true/>
  </dict>
</plist>
```

Do not add `com.apple.security.device.camera`.

Create `scripts/generate-mac-icon.js` that reads `assets/open-cluely.png` and writes `assets/open-cluely.icns` as an `icns` container with one `ic09` PNG chunk. Throw `Mac icon source missing: <abs path>` if the PNG is absent. Run it:

```bash
node scripts/generate-mac-icon.js
```

Set `package.json` `build.mac` to:

```json
"mac": {
  "category": "public.app-category.productivity",
  "icon": "assets/open-cluely.icns",
  "hardenedRuntime": true,
  "gatekeeperAssess": false,
  "identity": null,
  "entitlements": "packaging/macos/entitlements.mac.plist",
  "entitlementsInherit": "packaging/macos/entitlements.mac.inherit.plist",
  "extendInfo": {
    "NSMicrophoneUsageDescription": "Open-Cluely needs the microphone for live interview transcription.",
    "NSCameraUsageDescription": "Open-Cluely does not use the webcam. Chromium’s desktop-capture pipeline requires this string for Screenshot, Auto Screen, and host-audio loopback."
  },
  "target": [
    { "target": "dmg", "arch": ["arm64", "x64"] },
    { "target": "zip", "arch": ["arm64", "x64"] }
  ]
}
```

Add script `"smoke:macos": "node scripts/smoke-macos.js"`.

Implement `loadMacPackagingContract` / `evaluateMacPackagingContract` so missing icns or entitlements push exact path errors such as `Missing Mac icon: /abs/path/assets/open-cluely.icns`.

`scripts/smoke-macos.js` prints JSON with `ok`, `errors`, and key contract fields. `--no-write` must not create reports. Exit 1 when `ok` is false.

In `scripts/run-build.js`, before spawning electron-builder, if `args.includes('--mac')`, evaluate the contract and `console.error` joined errors then `process.exit(1)` on failure.

Update `assets/README.md` to name `open-cluely.icns` as the Mac packaging icon.

- [ ] **Step 4: Run test to verify it passes**

Run:

```bash
node --test --test-reporter=spec test/macos-packaging.test.js
node scripts/smoke-macos.js --no-write
```

Expected: both PASS / exit 0. Do not require `npm run build:mac` to succeed on Fedora if darwin Electron binaries cannot download; the contract and smoke are the gate.

- [ ] **Step 5: Commit**

```bash
git add packaging/macos/entitlements.mac.plist packaging/macos/entitlements.mac.inherit.plist scripts/generate-mac-icon.js scripts/smoke-macos.js scripts/run-build.js src/platform/macos-packaging-contract.js assets/open-cluely.icns assets/README.md package.json test/macos-packaging.test.js
git commit -m "build: add unsigned macOS dmg and zip packaging"
```

---

### Task 7: Diagnostics, docs, and verify gate

**Files:**
- Create: `src/platform/platform-diagnostics.js`
- Create: `MAC.md`
- Modify: `src/main-process/start-application.js`
- Modify: `src/windows/assistant/renderer/features/settings/settings-panel-manager.js`
- Modify: `src/windows/assistant/renderer.html`
- Modify: `README.md`
- Modify: `package.json`
- Test: `test/macos-diagnostics.test.js`

**Interfaces:**
- Consumes: `buildPlatformDiagnosticsView({ capabilities, contentProtectionActive, capture, hostAudioCapture, backgroundMemory, promptCache, shortcuts, timestamp })`
- Produces: diagnostics object that always includes `contentProtectionSupported` via `capabilities` and top-level `contentProtectionActive`

- [ ] **Step 1: Write the failing test**

Create `test/macos-diagnostics.test.js`:

```js
'use strict';

const fs = require('fs');
const path = require('path');
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { buildPlatformDiagnosticsView } = require('../src/platform/platform-diagnostics');

describe('platform diagnostics view', () => {
  it('includes hide support and active state on every OS', () => {
    const view = buildPlatformDiagnosticsView({
      capabilities: {
        platform: 'darwin',
        contentProtectionSupported: true,
        screenshotBackend: 'screenshot-desktop',
        hostAudioBackend: 'desktop-capturer-loopback'
      },
      contentProtectionActive: true,
      capture: { lastBackend: 'screenshot-desktop' },
      hostAudioCapture: { backend: 'desktop-capturer-loopback' },
      backgroundMemory: null,
      promptCache: null,
      shortcuts: [],
      timestamp: '2026-09-10T00:00:00.000Z'
    });
    assert.equal(view.capabilities.contentProtectionSupported, true);
    assert.equal(view.contentProtectionActive, true);
    assert.equal(view.capabilities.screenshotBackend, 'screenshot-desktop');
    assert.equal(view.capabilities.hostAudioBackend, 'desktop-capturer-loopback');
  });

  it('documents macOS as first-class and keeps verify hooked to macos smoke', () => {
    const readme = fs.readFileSync(path.join(__dirname, '..', 'README.md'), 'utf8');
    const macDoc = fs.readFileSync(path.join(__dirname, '..', 'MAC.md'), 'utf8');
    const packageJson = JSON.parse(
      fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8')
    );
    assert.match(readme, /MAC\.md/);
    assert.match(readme, /macOS/);
    assert.match(macDoc, /npm start/);
    assert.match(macDoc, /setContentProtection/);
    assert.match(macDoc, /Gatekeeper/);
    assert.match(macDoc, /Screen Recording/);
    assert.match(macDoc, /npm run build:mac/);
    assert.match(packageJson.scripts.verify, /smoke:macos -- --no-write/);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run:

```bash
node --test --test-reporter=spec test/macos-diagnostics.test.js
```

Expected: FAIL because the diagnostics helper and `MAC.md` are missing.

- [ ] **Step 3: Write diagnostics, docs, and verify hook**

Create `src/platform/platform-diagnostics.js` that returns the view object from Step 1, coercing `contentProtectionActive` to boolean.

In `platform-get-diagnostics`, return `buildPlatformDiagnosticsView({ capabilities, contentProtectionActive: windowController.applyContentProtection?.().active === true, ...existing fields })`. If calling apply just to read state is too heavy, add `windowController.getContentProtectionActive()` that returns the last apply result’s `active` flag (default `false`). Prefer a getter that does not re-call Electron.

In `refreshPlatformDiagnostics`, include `contentProtectionActive: result?.contentProtectionActive === true` in the JSON shown to the user. Rename the Settings label from `Fedora / Platform Diagnostics` to `Platform Diagnostics`.

Write `MAC.md` in the style of `FEDORA.md` covering: `npm ci` / `npm start`, Microphone and Screen Recording prompts, official hide vs local visibility, unsigned Gatekeeper right-click Open / `xattr` only for this app’s own unsigned build, host-audio loopback limits, screenshots, `npm run build:mac`, and a short manual checklist (Zoom/Meet hide, TCC dialogs) marked out of Fedora CI scope.

In `README.md` features, add a macOS first-class bullet next to the Fedora bullet that links `MAC.md`. Mention `assets/open-cluely.icns`. Do not expand `BUILD_INSTRUCTIONS.md`.

Set

```json
"verify": "npm test && npm run test:e2e && npm run smoke:fedora -- --no-write && npm run smoke:macos -- --no-write"
```

- [ ] **Step 4: Run tests and full verify**

Run:

```bash
node --test --test-reporter=spec test/macos-diagnostics.test.js test/macos-packaging.test.js test/macos-capabilities.test.js test/content-protection.test.js test/hide-from-screen-capture.test.js test/hide-overlay-control.test.js test/capture-permission-error.test.js
npm run verify
```

Expected: all listed tests PASS; `npm run verify` exits 0.

- [ ] **Step 5: Commit**

```bash
git add src/platform/platform-diagnostics.js src/main-process/start-application.js src/windows/assistant/renderer/features/settings/settings-panel-manager.js src/windows/assistant/renderer.html MAC.md README.md package.json test/macos-diagnostics.test.js
git commit -m "docs: add macOS first-class runbook and verify smoke"
```

If `window-controller.js` gained `getContentProtectionActive`, include it in the same commit.

---
