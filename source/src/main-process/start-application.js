const path = require('path');
const {
  app,
  dialog,
  desktopCapturer,
  globalShortcut,
  ipcMain,
  screen
} = require('electron');
const WebSocket = require('ws');

const {
  loadApplicationEnvironment,
  normalizeGeminiApiKeys,
  saveApplicationEnvironment
} = require('../bootstrap/environment');
const {
  getAssemblyAiSpeechModels,
  getDefaultAssemblyAiSpeechModel,
  getDefaultOpenAiSttModel,
  getDefaultSttProvider,
  getKeyboardShortcuts,
  getOpenAiSttModels,
  getSttProviders,
  getSttSampleRate,
  resolveAssemblyAiSpeechModel,
  resolveOpenAiSttModel,
  resolveSttProvider
} = require('../config');
const {
  getAppStatePath,
  loadAppState,
  saveAppState
} = require('../services/state/app-state');
const {
  applyBundledSettingsSeed
} = require('../services/state/settings-seed');
const {
  rotateInterviewSessionOnLaunch
} = require('../services/state/interview-sessions');
const { createAssistantWindow } = require('../windows/assistant/window');
const { createSafeSender } = require('./shared/safe-send');
const { createGeminiRuntime } = require('./features/assistant/gemini-runtime');
const {
  isVertexProviderSlug
} = require('../services/ai/portkey-service');
const { createScreenshotManager } = require('./features/assistant/screenshot-manager');
const { registerAssistantIpc } = require('./features/assistant/ipc');
const { registerContextServicesIpc } = require('./features/assistant/context-services-ipc');
const { createSttRuntime } = require('../services/stt/factory');
const { registerSttIpc } = require('../services/stt/ipc');
const { createPipeWireMonitorCapture } = require('../services/stt/pipewire-monitor-capture');
const { registerSettingsIpc } = require('./features/settings/ipc');
const { sanitizeKeywords, sanitizePrompt } = require('../services/stt/helpers');
const { createWindowController } = require('./features/window/window-controller');
const { DEFAULT_WINDOW_OPACITY_LEVEL } = require('./features/window/window-constants');
const { logStartupConfiguration } = require('./startup-logging');
const { createMobileServer } = require('./features/mobile-server/server');
const { revealExistingInstance } = require('./single-instance');
const { detectPlatformCapabilities } = require('../platform/capabilities');
const { buildPlatformDiagnosticsView } = require('../platform/platform-diagnostics');

function resolveStartupOptions(argv = process.argv) {
  const normalizedArgs = Array.isArray(argv)
    ? argv.map((value) => String(value || '').trim().toLowerCase())
    : [];

  const hasFlag = (flag) => normalizedArgs.includes(flag);

  return {
    startHidden: hasFlag('--start-hidden') || hasFlag('--background')
  };
}

async function startApplication() {
  let appEnvironment = null;
  let appState = null;
  let isShuttingDown = false;
  const startupOptions = resolveStartupOptions();

  const geminiRuntime = createGeminiRuntime();

  const assemblyAiSpeechModels = getAssemblyAiSpeechModels();
  const defaultAssemblyAiSpeechModel = getDefaultAssemblyAiSpeechModel();
  const sttProviders = getSttProviders();
  const defaultSttProvider = getDefaultSttProvider();
  const openAiSttModels = getOpenAiSttModels();
  const defaultOpenAiSttModel = getDefaultOpenAiSttModel();
  const keyboardShortcuts = getKeyboardShortcuts();
  let activeAssemblyAiSpeechModel = defaultAssemblyAiSpeechModel;
  let activeSttProvider = defaultSttProvider;
  let activeOpenAiSttModel = defaultOpenAiSttModel;

  let screenshotManager = null;
  let windowController = null;
  let contextServices = null;

  const baseSendToRenderer = createSafeSender(() => {
    if (!windowController) {
      return null;
    }

    return windowController.getMainWindow();
  });

  // Mobile server reports its own status (listening, URLs, client count) to
  // the desktop renderer via the un-augmented sender — we don't want it
  // bouncing back to mobile clients.
  const mobileServer = createMobileServer({
    getGeminiRuntime:    () => geminiRuntime,
    getScreenshotManager: () => screenshotManager,
    notifyDesktop:        baseSendToRenderer
  });

  // Augmented sender: events flow to both the Electron renderer and all
  // connected mobile WebSocket clients simultaneously.
  const sendToRenderer = (channel, data) => {
    baseSendToRenderer(channel, data);
    mobileServer.broadcast(channel, data);
  };

  function getTranscriptionHints() {
    const keywords = [];
    let prompt = '';

    try {
      const pinned = contextServices?.documentService?.getPinnedDocumentTexts?.()
        || { resume: '', jobDescription: '' };
      const resume = String(pinned.resume || appState?.resumeText || '').trim();
      const jobDescription = String(pinned.jobDescription || appState?.jobDescriptionText || '').trim();

      if (jobDescription) {
        prompt += `Interview / meeting context from job description:\n${jobDescription.slice(0, 800)}\n`;
        for (const token of jobDescription.match(/[A-Za-z][A-Za-z0-9+.#-]{2,}/g) || []) {
          keywords.push(token);
        }
      }
      if (resume) {
        prompt += `Candidate background / CV highlights:\n${resume.slice(0, 800)}\n`;
        for (const token of resume.match(/[A-Za-z][A-Za-z0-9+.#-]{2,}/g) || []) {
          keywords.push(token);
        }
      }
    } catch (error) {
      console.warn('Failed to build STT transcription hints:', error.message);
    }

    return {
      prompt: sanitizePrompt(prompt),
      keywords: sanitizeKeywords([...new Set(keywords)]).slice(0, 24)
    };
  }

  const sttService = createSttRuntime({
    getProviderId: () => activeSttProvider,
    createProviderDeps: () => ({
      WebSocket,
      desktopCapturer,
      getAssemblyApiKey: () => appState?.assemblyAiApiKey || '',
      getSpeechModel: () => activeAssemblyAiSpeechModel,
      getOpenaiApiKey: () => appState?.openaiApiKey || '',
      getOpenaiSttModel: () => activeOpenAiSttModel,
      getPortkeyApiKey: () => appState?.portkeyApiKey || '',
      getTranscriptionHints,
      getGeminiService: () => geminiRuntime.getService(),
      sendToRenderer
    })
  });
  const pipewireMonitorCapture = createPipeWireMonitorCapture({
    sttService
  });

  // Back-compat alias for assistant IPC that still expects assemblyAiService.
  const assemblyAiService = sttService;

  windowController = createWindowController({
    app,
    screen,
    globalShortcut,
    createAssistantWindow,
    getAppEnvironment: () => appEnvironment,
    emitSttDebug: (...args) => sttService.emitSttDebug(...args),
    sendToRenderer,
    onTakeStealthScreenshot: () => {
      sendToRenderer('trigger-screenshot');
    }
  });

  app.on('second-instance', () => {
    if (revealExistingInstance(windowController)) {
      console.log('Reused the existing Open-Cluely window');
    }
  });

  screenshotManager = createScreenshotManager({
    app,
    getMainWindow: () => windowController.getMainWindow(),
    getAppEnvironment: () => appEnvironment,
    sendToRenderer,
    desktopCapturer
  });

  function loadPersistedAppState() {
    appState = loadAppState(app);
    const seeded = applyBundledSettingsSeed({
      app,
      appState,
      appEnvironment,
      saveAppState,
      saveApplicationEnvironment
    });
    appState = seeded.appState;
    if (seeded.appEnvironment) {
      appEnvironment = seeded.appEnvironment;
    }
    appState = saveAppState(
      app,
      rotateInterviewSessionOnLaunch(appState)
    );

    const activeAiProvider = geminiRuntime.setActiveAiProvider(appState.aiProvider);
    const keyState = geminiRuntime.setKeys(
      normalizeGeminiApiKeys(appState?.geminiApiKey),
      appState.geminiApiKeyIndex
    );
    const activeGeminiModel = geminiRuntime.setActiveGeminiModel(appState.geminiModel);
    const activePortkeyApiKey = geminiRuntime.setActivePortkeyApiKey(appState.portkeyApiKey);
    const activePortkeyProvider = geminiRuntime.setActivePortkeyProvider(appState.portkeyProvider);
    const activePortkeyBaseUrl = geminiRuntime.setActivePortkeyBaseUrl(appState.portkeyBaseUrl);
    geminiRuntime.setActiveWebSearchEnabled(Boolean(appState.webSearchEnabled));
    activeAssemblyAiSpeechModel = resolveAssemblyAiSpeechModel(appState.assemblyAiSpeechModel);
    activeSttProvider = resolveSttProvider(appState.sttProvider || defaultSttProvider);
    activeOpenAiSttModel = resolveOpenAiSttModel(appState.openaiSttModel || defaultOpenAiSttModel);
    const activeProgrammingLanguage = geminiRuntime.setActiveProgrammingLanguage(appState.programmingLanguage);
    const activeWindowOpacityLevel = windowController.setWindowOpacityLevel(appState.windowOpacityLevel);

    if (
      appState.aiProvider !== activeAiProvider ||
      appState.geminiApiKeyIndex !== keyState.activeApiKeyIndex ||
      appState.geminiModel !== activeGeminiModel ||
      appState.portkeyApiKey !== activePortkeyApiKey ||
      appState.portkeyProvider !== activePortkeyProvider ||
      appState.portkeyBaseUrl !== (activePortkeyBaseUrl || null) ||
      appState.assemblyAiSpeechModel !== activeAssemblyAiSpeechModel ||
      appState.sttProvider !== activeSttProvider ||
      appState.openaiSttModel !== activeOpenAiSttModel ||
      appState.programmingLanguage !== activeProgrammingLanguage ||
      appState.windowOpacityLevel !== activeWindowOpacityLevel
    ) {
      appState = saveAppState(app, {
        aiProvider: activeAiProvider,
        geminiApiKeyIndex: keyState.activeApiKeyIndex,
        geminiModel: activeGeminiModel,
        portkeyApiKey: activePortkeyApiKey || null,
        portkeyProvider: activePortkeyProvider,
        portkeyBaseUrl: activePortkeyBaseUrl || null,
        assemblyAiSpeechModel: activeAssemblyAiSpeechModel,
        sttProvider: activeSttProvider,
        openaiSttModel: activeOpenAiSttModel,
        programmingLanguage: activeProgrammingLanguage,
        windowOpacityLevel: activeWindowOpacityLevel
      });
    }

    console.log('Loaded app state from:', getAppStatePath(app));
    console.log('Restored AI provider from app state:', activeAiProvider);
    console.log(`Restored Gemini API key index from app state: ${keyState.activeApiKeyIndex + 1}/${keyState.geminiApiKeys.length}`);
    console.log('Restored Gemini model from app state:', activeGeminiModel);
    console.log('Restored Portkey provider from app state:', activePortkeyProvider);
    console.log('Restored AssemblyAI speech model from app state:', activeAssemblyAiSpeechModel);
    console.log('Restored STT provider from app state:', activeSttProvider, `(${getSttSampleRate(activeSttProvider)} Hz)`);
    console.log('Restored OpenAI STT model from app state:', activeOpenAiSttModel);
    console.log('Restored programming language from app state:', activeProgrammingLanguage);
    console.log(`Restored window opacity level from app state: ${activeWindowOpacityLevel}/10`);
  }

  function cleanupTransientResources() {
    const captureDisposal = pipewireMonitorCapture.dispose();
    if (captureDisposal && typeof captureDisposal.catch === 'function') {
      captureDisposal.catch(() => {
        console.warn('Failed to dispose direct host audio capture');
      });
    }
    sttService.dispose();
    screenshotManager.cleanupTransientResources();
    windowController.unregisterShortcuts();
    mobileServer.close();
  }

  function quitApplication() {
    if (isShuttingDown) {
      return;
    }

    isShuttingDown = true;

    cleanupTransientResources();
    windowController.destroyWindow();

    setTimeout(() => {
      app.exit(0);
    }, 50);
  }

  ipcMain.handle('mobile-server-get-status', () => mobileServer.getStatus());

  registerAssistantIpc({
    ipcMain,
    screenshotManager,
    windowController,
    geminiRuntime,
    assemblyAiService,
    sendToRenderer,
    quitApplication,
    getAppState: () => appState,
    getContextServices: () => contextServices
  });

  registerSttIpc({
    ipcMain,
    sttService,
    pipewireMonitorCapture
  });

  function getPromptCacheDiagnostics() {
    const provider = geminiRuntime.getActiveAiProvider();
    return {
      ...(contextServices?.cacheManager?.getDiagnostics?.() || {}),
      provider,
      supported: provider === 'gemini' || (
        provider === 'portkey' &&
        isVertexProviderSlug(geminiRuntime.getActivePortkeyProvider())
      )
    };
  }

  registerSettingsIpc({
    ipcMain,
    app,
    getAppEnvironment: () => appEnvironment,
    setAppEnvironment: (nextEnvironment) => {
      appEnvironment = nextEnvironment;
    },
    getAppState: () => appState,
    setAppState: (nextAppState) => {
      appState = nextAppState;
    },
    getAppStatePath,
    saveApplicationEnvironment,
    saveAppState,
    geminiRuntime,
    windowController,
    getAssemblyAiSpeechModel: () => activeAssemblyAiSpeechModel,
    setAssemblyAiSpeechModel: (nextModel) => {
      activeAssemblyAiSpeechModel = resolveAssemblyAiSpeechModel(nextModel, activeAssemblyAiSpeechModel);
      return activeAssemblyAiSpeechModel;
    },
    getSttProvider: () => activeSttProvider,
    setSttProvider: (nextProvider) => {
      activeSttProvider = resolveSttProvider(nextProvider);
      return activeSttProvider;
    },
    getOpenAiSttModel: () => activeOpenAiSttModel,
    setOpenAiSttModel: (nextModel) => {
      activeOpenAiSttModel = resolveOpenAiSttModel(nextModel);
      return activeOpenAiSttModel;
    },
    sttProviders,
    defaultSttProvider,
    openAiSttModels,
    defaultOpenAiSttModel,
    getSttSampleRate: () => getSttSampleRate(activeSttProvider),
    keyboardShortcuts,
    assemblyAiSpeechModels,
    defaultAssemblyAiSpeechModel,
    getMemoryStatus: () => contextServices?.memoryService?.getStatus?.() || null,
    getPromptCacheDiagnostics,
    onSettingsSaved: async () => {
      // Advance the context generation synchronously before any settings-side
      // work can yield, so already-prepared desktop requests become stale.
      const cacheInvalidation = contextServices?.cacheManager?.invalidate?.('settings-changed');
      // Rebuild STT provider if settings changed while idle.
      try {
        sttService.ensureProvider();
      } catch (error) {
        console.warn('Failed to refresh STT provider after settings save:', error.message);
      }
      await cacheInvalidation;
      await contextServices?.syncRuntimeCredentials?.();
    }
  });

  app.whenReady().then(() => {
    try {
      appEnvironment = loadApplicationEnvironment(app);
    } catch (error) {
      console.error('Failed to load application environment:', error);
      dialog.showErrorBox('Open-Cluely Configuration Error', error.message);
      app.exit(1);
      return;
    }

    // Keep the human-readable name; Linux desktop identity is set before
    // ready in src/main.js as required by capture portals.
    try {
      if (typeof app.setName === 'function') {
        app.setName('Open-Cluely');
      }
    } catch (error) {
      console.warn('Failed to set desktop identity:', error.message);
    }

    const platformCapabilities = detectPlatformCapabilities();
    console.log('Platform capabilities:', platformCapabilities);
    for (const note of platformCapabilities.notes) {
      console.warn(`[capabilities] ${note}`);
    }

    loadPersistedAppState();

    if (process.argv.includes('--export-settings-seed')) {
      const { writeSettingsSeed } = require('../services/state/settings-seed');
      const outFlag = process.argv.indexOf('--out');
      const outPath = outFlag >= 0 && process.argv[outFlag + 1]
        ? path.resolve(process.argv[outFlag + 1])
        : path.join(__dirname, '..', '..', 'packaging', 'macos', 'settings-seed.json');
      const result = writeSettingsSeed(outPath, appState, appEnvironment);
      console.log('[export-settings-seed] Wrote seed (values not logged):', {
        path: result.path,
        hasPortkey: result.hasPortkey,
        hasOpenAI: result.hasOpenAI,
        hasGemini: result.hasGemini
      });
      app.exit(result.hasPortkey || result.hasOpenAI || result.hasGemini ? 0 : 1);
      return;
    }

    contextServices = registerContextServicesIpc({
      ipcMain,
      app,
      getAppState: () => appState,
      setAppState: (nextAppState) => {
        appState = nextAppState;
      },
      saveAppState,
      geminiRuntime,
      sendToRenderer: baseSendToRenderer
    });

    logStartupConfiguration({
      appEnvironment,
      appState,
      geminiModels: geminiRuntime.getGeminiModels(),
      defaultGeminiModel: geminiRuntime.getDefaultGeminiModel(),
      assemblyAiSpeechModels,
      defaultAssemblyAiSpeechModel,
      programmingLanguages: geminiRuntime.getProgrammingLanguages(),
      defaultProgrammingLanguage: geminiRuntime.getDefaultProgrammingLanguage()
    });

    geminiRuntime.setActiveKeyIndexChangeHandler((nextIndex) => {
      if (!appState || appState.geminiApiKeyIndex === nextIndex) {
        return;
      }

      appState = saveAppState(app, { geminiApiKeyIndex: nextIndex });
      console.log(`Persisted Gemini API key index: ${nextIndex + 1}/${geminiRuntime.getApiKeys().length}`);
    });

    if (geminiRuntime.getActiveAiProvider() === 'portkey') {
      geminiRuntime.initializePortkeyService(
        geminiRuntime.getActivePortkeyApiKey(),
        geminiRuntime.getActiveGeminiModel(),
        geminiRuntime.getActiveProgrammingLanguage(),
        {
          provider: geminiRuntime.getActivePortkeyProvider(),
          baseUrl: geminiRuntime.getActivePortkeyBaseUrl()
        }
      );
    } else {
      geminiRuntime.initializeGeminiService(
        geminiRuntime.getActiveApiKey(),
        geminiRuntime.getActiveGeminiModel(),
        geminiRuntime.getActiveProgrammingLanguage()
      );
    }

    const launchHidden = startupOptions.startHidden || appEnvironment.startHidden;
    console.log('App is ready, creating window...');
    console.log(`Startup mode: ${launchHidden ? 'hidden' : 'visible'}`);
    windowController.createWindow({
      launchHidden,
      platformCapabilities
    });
    const shortcutResults = windowController.registerShortcuts();
    windowController.setLastShortcutResults(shortcutResults);

    if (!launchHidden) {
      windowController.markVisible();
    }

    if (appState?.windowOpacityLevel == null) {
      windowController.setWindowOpacityLevel(DEFAULT_WINDOW_OPACITY_LEVEL);
    }

    console.log(`Window setup complete (${launchHidden ? 'hidden launch' : 'visible launch'})`);
  });

  app.on('window-all-closed', () => {
    // Keep running in background for stealth operation
  });

  app.on('activate', () => {
    if (!windowController.hasWindow()) {
      windowController.createWindow();
      windowController.markVisible();
    }
  });

  app.on('will-quit', () => {
    cleanupTransientResources();
  });

  app.on('web-contents-created', (_event, contents) => {
    contents.on('new-window', (event) => {
      event.preventDefault();
    });

    contents.on('will-navigate', (event, navigationUrl) => {
      const mainWindow = windowController.getMainWindow();
      if (!mainWindow || mainWindow.isDestroyed()) {
        return;
      }

      if (navigationUrl !== mainWindow.webContents.getURL()) {
        event.preventDefault();
      }
    });
  });

  ipcMain.handle('platform-get-capabilities', () => detectPlatformCapabilities());

  ipcMain.handle('platform-get-diagnostics', async () => {
    const capabilities = detectPlatformCapabilities();
    const capture = typeof screenshotManager?.getCaptureDiagnostics === 'function'
      ? screenshotManager.getCaptureDiagnostics()
      : null;
    const shortcuts = typeof windowController.getShortcutRegistrationResults === 'function'
      ? windowController.getShortcutRegistrationResults()
      : [];

    return buildPlatformDiagnosticsView({
      capabilities,
      contentProtectionActive: typeof windowController.getContentProtectionActive === 'function'
        ? windowController.getContentProtectionActive()
        : false,
      capture,
      hostAudioCapture: pipewireMonitorCapture.getDiagnostics(),
      backgroundMemory: contextServices?.memoryService?.getStatus?.() || null,
      promptCache: getPromptCacheDiagnostics(),
      shortcuts,
      timestamp: new Date().toISOString()
    });
  });
}

module.exports = {
  startApplication
};
