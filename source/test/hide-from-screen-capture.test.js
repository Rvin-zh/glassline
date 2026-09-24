'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const {
  resolveHideFromScreenCapture
} = require('../src/platform/hide-from-screen-capture');
const { createWindowController } = require('../src/main-process/features/window/window-controller');
const { registerSettingsIpc } = require('../src/main-process/features/settings/ipc');
const { createAiRuntime } = require('../src/main-process/features/assistant/gemini-runtime');

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
      },
      on() {},
      webContents: { isDestroyed: () => true, on() {}, reload() {} }
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
    const geminiRuntime = createAiRuntime();
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
      geminiRuntime,
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

  it('applies content protection at window creation so launch hide state is active', () => {
    const protectionCalls = [];
    let currentHide = true;
    const fakeWindow = {
      isDestroyed: () => false,
      setContentProtection(value) {
        protectionCalls.push(value);
      },
      setOpacity() {},
      getBounds() {
        return { x: 0, y: 0, width: 900, height: 400 };
      },
      on() {},
      webContents: { isDestroyed: () => true, on() {}, reload() {} }
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

    // Finding 5: createWindow must apply content protection immediately so
    // diagnostics reads hide-on at launch.
    assert.deepEqual(protectionCalls, [true]);
    assert.equal(windowController.getContentProtectionActive(), true);
  });

  it('applies hide before onSettingsSaved even if onSettingsSaved throws', async () => {
    const protectionCalls = [];
    const applyOrder = [];
    let currentHide = true;
    const fakeWindow = {
      isDestroyed: () => false,
      setContentProtection(value) {
        protectionCalls.push(value);
      },
      setOpacity() {},
      getBounds() {
        return { x: 0, y: 0, width: 900, height: 400 };
      },
      on() {},
      webContents: { isDestroyed: () => true, on() {}, reload() {} }
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
    const geminiRuntime = createAiRuntime();
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
        applyOrder.push('setAppEnvironment');
      },
      getAppState: () => ({}),
      setAppState() {},
      getAppStatePath: () => '/tmp/app-state.json',
      saveApplicationEnvironment(_app, values) {
        currentHide = values.hideFromScreenCapture;
        return { envPath: '/tmp/.env', ...values };
      },
      saveAppState: (_app, values) => values,
      geminiRuntime,
      windowController: {
        ...windowController,
        applyContentProtection() {
          applyOrder.push('applyContentProtection');
          return windowController.applyContentProtection();
        }
      },
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
      getPromptCacheDiagnostics: () => ({}),
      onSettingsSaved: async () => {
        applyOrder.push('onSettingsSaved');
        throw new Error('saved callback exploded');
      }
    });

    const result = await handlers.get('save-settings')(null, {
      hideFromScreenCapture: false,
      windowOpacityLevel: 10
    });

    // Finding 6: hide must be applied before onSettingsSaved runs, so even
    // when the callback throws the persisted hide state is already applied.
    // The throw propagates to the save-settings catch, so success is false,
    // but the protection call must have happened first.
    assert.equal(result.success, false);
    assert.equal(applyOrder.indexOf('applyContentProtection') < applyOrder.indexOf('onSettingsSaved'), true);
    assert.deepEqual(protectionCalls.at(-1), false);
  });
});
