'use strict';

const { it } = require('node:test');
const assert = require('node:assert/strict');

const { createAiRuntime } = require('../src/main-process/features/assistant/gemini-runtime');
const { registerSettingsIpc } = require('../src/main-process/features/settings/ipc');

function createDeferred() {
  let resolve;
  let reject;
  const promise = new Promise((promiseResolve, promiseReject) => {
    resolve = promiseResolve;
    reject = promiseReject;
  });
  return { promise, resolve, reject };
}

it('exposes the default fallback model and last execution diagnostics in settings', async () => {
  const runtime = createAiRuntime();
  runtime.setActiveAiProvider('portkey');
  runtime.setActivePortkeyApiKey('portkey-test-key');
  runtime.initializePortkeyService(
    'portkey-test-key',
    'gemini-3.8-flash',
    'Python',
    { provider: '@vertex' }
  );
  await runtime.executeWithKeyFailover(async () => 'primary response');

  const handlers = new Map();
  const ipcMain = {
    handle(channel, handler) {
      handlers.set(channel, handler);
    }
  };

  registerSettingsIpc({
    ipcMain,
    app: {},
    getAppEnvironment: () => ({
      hideFromScreenCapture: true,
      startHidden: false
    }),
    setAppEnvironment() {},
    getAppState: () => ({}),
    setAppState() {},
    getAppStatePath: () => '/tmp/app-state.json',
    saveApplicationEnvironment() {},
    saveAppState() {},
    geminiRuntime: runtime,
    windowController: {
      getWindowOpacityLevel: () => 10,
      setWindowOpacityLevel: () => 10
    },
    getAssemblyAiSpeechModel: () => 'universal-streaming-english',
    setAssemblyAiSpeechModel: (model) => model,
    getSttProvider: () => 'assemblyai',
    setSttProvider: (provider) => provider,
    getOpenAiSttModel: () => 'gpt-live-transcribe',
    setOpenAiSttModel: (model) => model,
    getSttSampleRate: () => 16000,
    keyboardShortcuts: [],
    assemblyAiSpeechModels: ['universal-streaming-english'],
    defaultAssemblyAiSpeechModel: 'universal-streaming-english',
    getMemoryStatus: () => ({
      provider: 'portkey',
      model: 'gemini-3.5-flash-lite',
      ready: true,
      lastSuccessAt: '2026-09-10T00:00:00.000Z',
      lastErrorCategory: null,
      lastErrorAt: null
    }),
    getPromptCacheDiagnostics: () => ({
      enabled: true,
      provider: 'portkey',
      supported: true,
      activeCount: 1,
      hasActiveName: true,
      hitCount: 2,
      cacheName: 'projects/SECRET_PROJECT/locations/SECRET/cache-name',
      apiKey: 'PORTKEY_DIAGNOSTIC_SECRET',
      prefix: 'PRIVATE_PREFIX'
    })
  });

  const settings = handlers.get('get-settings')();
  assert.equal(settings.defaultGeminiFallbackModel, 'gemini-3.7-flash');
  assert.equal(settings.autoScreenIntervalSeconds, 10);
  assert.deepEqual(settings.autoScreenIntervalOptions, [5, 10, 15, 30]);
  assert.equal(settings.defaultOutputFormat, 'quick');
  assert.equal(settings.customOutputTemplate, '');
  assert.deepEqual(settings.backgroundMemory, {
    provider: 'portkey',
    model: 'gemini-3.5-flash-lite',
    ready: true,
    lastSuccessAt: '2026-09-10T00:00:00.000Z',
    lastErrorCategory: null,
    lastErrorAt: null
  });
  assert.deepEqual(settings.outputFormats, [
    'quick',
    'adaptive',
    'detailed',
    'custom'
  ]);
  assert.deepEqual(settings.lastAiExecutionDiagnostics, {
    selectedModel: 'gemini-3.8-flash',
    modelUsed: 'gemini-3.8-flash',
    fallbackModel: 'gemini-3.7-flash',
    fallbackAttempted: false,
    fallbackUsed: false,
    failureCategory: null,
    failureTimestamp: null
  });
  assert.deepEqual(settings.promptCache, {
    enabled: true,
    provider: 'portkey',
    supported: true,
    activeCount: 1,
    hasActiveName: true,
    hitCount: 2
  });
  const serialized = JSON.stringify(settings);
  assert.equal(serialized.includes('SECRET_PROJECT'), false);
  assert.equal(serialized.includes('PORTKEY_DIAGNOSTIC_SECRET'), false);
  assert.equal(serialized.includes('PRIVATE_PREFIX'), false);
});

it('waits for cache lifecycle settings work before reporting settings saved', async () => {
  const runtime = createAiRuntime();
  const handlers = new Map();
  const callbackStarted = createDeferred();
  const releaseCallback = createDeferred();
  let appState = {};

  registerSettingsIpc({
    ipcMain: {
      handle(channel, handler) {
        handlers.set(channel, handler);
      }
    },
    app: {},
    getAppEnvironment: () => ({
      hideFromScreenCapture: true,
      startHidden: false,
      maxScreenshots: 5,
      screenshotDelay: 100,
      nodeEnv: 'test',
      nodeOptions: ''
    }),
    setAppEnvironment() {},
    getAppState: () => appState,
    setAppState(nextState) {
      appState = nextState;
    },
    getAppStatePath: () => '/tmp/app-state.json',
    saveApplicationEnvironment(_app, values) {
      return { ...values, envPath: '/tmp/.env' };
    },
    saveAppState(_app, values) {
      return { ...appState, ...values };
    },
    geminiRuntime: runtime,
    windowController: {
      getWindowOpacityLevel: () => 10,
      setWindowOpacityLevel: () => 10
    },
    getAssemblyAiSpeechModel: () => 'universal-streaming-english',
    setAssemblyAiSpeechModel: (model) => model,
    getSttProvider: () => 'assemblyai',
    setSttProvider: (provider) => provider,
    getOpenAiSttModel: () => 'gpt-live-transcribe',
    setOpenAiSttModel: (model) => model,
    getSttSampleRate: () => 16000,
    keyboardShortcuts: [],
    assemblyAiSpeechModels: ['universal-streaming-english'],
    defaultAssemblyAiSpeechModel: 'universal-streaming-english',
    async onSettingsSaved() {
      callbackStarted.resolve();
      await releaseCallback.promise;
    }
  });

  let saveSettled = false;
  const settingsPayload = {
    aiProvider: 'portkey',
    geminiApiKey: '',
    assemblyAiApiKey: '',
    geminiModel: 'gemini-3.8-flash',
    portkeyApiKey: 'settings-test-key',
    portkeyProvider: '@e2e',
    portkeyBaseUrl: 'http://127.0.0.1:41234/v1',
    programmingLanguage: 'Python',
    assemblyAiSpeechModel: 'universal-streaming-english',
    sttProvider: 'assemblyai',
    openAiSttModel: 'gpt-live-transcribe',
    windowOpacityLevel: 10,
    promptCacheEnabled: true,
    autoScreenIntervalSeconds: 30,
    defaultOutputFormat: 'custom',
    customOutputTemplate: 'Verdict, evidence, next step.'
  };
  const savePromise = handlers.get('save-settings')(null, settingsPayload).then((result) => {
    saveSettled = true;
    return result;
  });

  await callbackStarted.promise;
  await Promise.resolve();
  const settledBeforeRelease = saveSettled;
  releaseCallback.resolve();

  assert.deepEqual(await savePromise, {
    success: true,
    isAiReady: true,
    settings: {
      autoScreenIntervalSeconds: 30,
      autoScreenIntervalMs: 30_000,
      defaultOutputFormat: 'custom',
      customOutputTemplate: 'Verdict, evidence, next step.'
    }
  });
  assert.equal(settledBeforeRelease, false);
  assert.equal(appState.autoScreenIntervalSeconds, 30);
  assert.equal(appState.defaultOutputFormat, 'custom');
  assert.equal(appState.customOutputTemplate, 'Verdict, evidence, next step.');

  const fallbackResult = await handlers.get('save-settings')(null, {
    ...settingsPayload,
    autoScreenIntervalSeconds: 12
  });
  assert.equal(fallbackResult.settings.autoScreenIntervalSeconds, 10);
  assert.equal(fallbackResult.settings.autoScreenIntervalMs, 10_000);
  assert.equal(appState.autoScreenIntervalSeconds, 10);
});
