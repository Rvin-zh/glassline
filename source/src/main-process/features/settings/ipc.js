const {
  getAutoScreenIntervalSeconds,
  resolveAutoScreenIntervalMilliseconds,
  resolveAutoScreenIntervalSeconds,
  getOutputFormats,
  getOutputFormatLabels,
  resolveOutputFormat,
  sanitizeCustomOutputTemplate
} = require('../../../config');
const { resolveHideFromScreenCapture } = require('../../../platform/hide-from-screen-capture');
const { resolveHideOverlayControlState } = require('../../../windows/assistant/renderer/features/settings/hide-overlay-control');
const { detectPlatformCapabilities } = require('../../../platform/capabilities');

function registerSettingsIpc({
  ipcMain,
  app,
  getAppEnvironment,
  setAppEnvironment,
  getAppState,
  setAppState,
  getAppStatePath,
  saveApplicationEnvironment,
  saveAppState,
  geminiRuntime,
  windowController,
  getAssemblyAiSpeechModel,
  setAssemblyAiSpeechModel,
  getSttProvider,
  setSttProvider,
  getOpenAiSttModel,
  setOpenAiSttModel,
  sttProviders = ['assemblyai', 'openai', 'portkey-whisper'],
  defaultSttProvider = 'assemblyai',
  openAiSttModels = ['gpt-live-transcribe'],
  defaultOpenAiSttModel = 'gpt-live-transcribe',
  getSttSampleRate,
  keyboardShortcuts,
  assemblyAiSpeechModels,
  defaultAssemblyAiSpeechModel,
  getMemoryStatus,
  getPromptCacheDiagnostics,
  onSettingsSaved
}) {
  ipcMain.handle('get-settings', () => {
    const appEnvironment = getAppEnvironment();
    const appState = getAppState();
    const geminiApiKey = typeof appState?.geminiApiKey === 'string' ? appState.geminiApiKey : '';
    const assemblyAiApiKey = typeof appState?.assemblyAiApiKey === 'string' ? appState.assemblyAiApiKey : '';
    const portkeyApiKey = typeof appState?.portkeyApiKey === 'string' ? appState.portkeyApiKey : '';
    const tavilyApiKey = typeof appState?.tavilyApiKey === 'string' ? appState.tavilyApiKey : '';
    const openaiApiKey = typeof appState?.openaiApiKey === 'string' ? appState.openaiApiKey : '';
    const documents = appState?.documents || null;
    const sttProvider = typeof getSttProvider === 'function'
      ? getSttProvider()
      : (appState?.sttProvider || defaultSttProvider);
    const openaiSttModel = typeof getOpenAiSttModel === 'function'
      ? getOpenAiSttModel()
      : (appState?.openaiSttModel || defaultOpenAiSttModel);
    const sttSampleRate = typeof getSttSampleRate === 'function'
      ? getSttSampleRate()
      : (sttProvider === 'openai' ? 24000 : 16000);
    const memoryStatus = typeof getMemoryStatus === 'function'
      ? getMemoryStatus()
      : null;
    const rawPromptCache = typeof getPromptCacheDiagnostics === 'function'
      ? getPromptCacheDiagnostics() || {}
      : {};
    const promptCache = {
      enabled: rawPromptCache.enabled !== false &&
        appState?.promptCacheEnabled !== false,
      provider: rawPromptCache.provider === 'portkey'
        ? 'portkey'
        : 'gemini',
      supported: rawPromptCache.supported === true,
      activeCount: Math.max(
        0,
        Number.isSafeInteger(rawPromptCache.activeCount)
          ? rawPromptCache.activeCount
          : 0
      ),
      hasActiveName: rawPromptCache.hasActiveName === true,
      hitCount: Math.max(
        0,
        Number.isSafeInteger(rawPromptCache.hitCount)
          ? rawPromptCache.hitCount
          : 0
      )
    };

    return {
      aiProvider: geminiRuntime.getActiveAiProvider(),
      aiProviders: geminiRuntime.getAiProviders(),
      geminiApiKey,
      assemblyAiApiKey,
      portkeyApiKey,
      portkeyProvider: geminiRuntime.getActivePortkeyProvider(),
      portkeyBaseUrl: geminiRuntime.getActivePortkeyBaseUrl(),
      hasGeminiApiKeys: geminiApiKey.split(',').map((value) => value.trim()).filter(Boolean).length > 0,
      hasPortkeyApiKey: portkeyApiKey.length > 0,
      hasAssemblyAiApiKey: assemblyAiApiKey.length > 0,
      hasOpenaiApiKey: openaiApiKey.length > 0,
      isAiReady: geminiRuntime.isAiReady(),
      geminiModel: geminiRuntime.getActiveGeminiModel(),
      geminiModels: geminiRuntime.getGeminiModels(),
      defaultGeminiModel: geminiRuntime.getDefaultGeminiModel(),
      defaultGeminiFallbackModel: geminiRuntime.getDefaultGeminiFallbackModel?.() || null,
      geminiMemoryModel: geminiRuntime.getGeminiMemoryModel(),
      backgroundMemory: memoryStatus
        ? {
          provider: memoryStatus.provider || null,
          model: memoryStatus.model || null,
          ready: memoryStatus.ready === true,
          lastSuccessAt: memoryStatus.lastSuccessAt || null,
          lastErrorCategory: memoryStatus.lastErrorCategory || null,
          lastErrorAt: memoryStatus.lastErrorAt || null
        }
        : null,
      lastAiExecutionDiagnostics: geminiRuntime.getLastExecutionDiagnostics?.() || null,
      defaultPortkeyProvider: geminiRuntime.getDefaultPortkeyProvider(),
      defaultPortkeyBaseUrl: geminiRuntime.getDefaultPortkeyBaseUrl(),
      programmingLanguage: geminiRuntime.getActiveProgrammingLanguage(),
      programmingLanguages: geminiRuntime.getProgrammingLanguages(),
      defaultProgrammingLanguage: geminiRuntime.getDefaultProgrammingLanguage(),
      defaultOutputFormat: resolveOutputFormat(
        appState?.defaultOutputFormat,
        appState?.customOutputTemplate
      ),
      customOutputTemplate: sanitizeCustomOutputTemplate(
        appState?.customOutputTemplate
      ),
      outputFormats: getOutputFormats(),
      outputFormatLabels: getOutputFormatLabels(),
      assemblyAiSpeechModels,
      defaultAssemblyAiSpeechModel,
      assemblyAiSpeechModel: getAssemblyAiSpeechModel(),
      sttProviders,
      defaultSttProvider,
      sttProvider,
      openAiSttModels,
      defaultOpenAiSttModel,
      openaiApiKey,
      openaiSttModel,
      sttSampleRate,
      // Portkey Whisper is bounded chunk transcription, not live streaming.
      sttRealtime: sttProvider !== 'portkey-whisper',
      resumeText: typeof appState?.resumeText === 'string' ? appState.resumeText : '',
      jobDescriptionText: typeof appState?.jobDescriptionText === 'string' ? appState.jobDescriptionText : '',
      keyboardShortcuts,
      hideFromScreenCapture: appEnvironment.hideFromScreenCapture,
      hideOverlayControl: resolveHideOverlayControlState({
        platform: process.platform,
        contentProtectionSupported: detectPlatformCapabilities().contentProtectionSupported,
        hideFromScreenCapture: appEnvironment.hideFromScreenCapture
      }),
      startHidden: appEnvironment.startHidden,
      windowOpacityLevel: windowController.getWindowOpacityLevel(),
      themePreference: appState?.themePreference === 'dark' || appState?.themePreference === 'light'
        ? appState.themePreference
        : null,
      webSearchEnabled: appState?.webSearchEnabled === true,
      requestWebSearchEnabled: appState?.requestWebSearchEnabled === true,
      webSearchProvider: appState?.webSearchProvider === 'tavily' ? 'tavily' : 'gemini-grounding',
      tavilyApiKey,
      hasTavilyApiKey: tavilyApiKey.length > 0,
      promptCacheEnabled: appState?.promptCacheEnabled !== false,
      promptCache,
      autoScreenIntervalSeconds: resolveAutoScreenIntervalSeconds(
        appState?.autoScreenIntervalSeconds
      ),
      autoScreenIntervalOptions: getAutoScreenIntervalSeconds(),
      autoScreenIntervalMs: resolveAutoScreenIntervalMilliseconds(
        appState?.autoScreenIntervalSeconds
      ),
      documents: documents
        ? {
          resume: {
            enabled: documents.resume?.enabled !== false,
            hasText: Boolean(documents.resume?.text),
            charCount: typeof documents.resume?.text === 'string' ? documents.resume.text.length : 0,
            source: documents.resume?.source || null,
            hash: documents.resume?.hash || null,
            updatedAt: documents.resume?.updatedAt || null
          },
          jobDescription: {
            enabled: documents.jobDescription?.enabled !== false,
            hasText: Boolean(documents.jobDescription?.text),
            charCount: typeof documents.jobDescription?.text === 'string'
              ? documents.jobDescription.text.length
              : 0,
            source: documents.jobDescription?.source || null,
            hash: documents.jobDescription?.hash || null,
            updatedAt: documents.jobDescription?.updatedAt || null
          }
        }
        : null,
      durableNotesCount: Array.isArray(appState?.durableNotes) ? appState.durableNotes.length : 0
    };
  });

  ipcMain.handle('set-theme-preference', (_event, payload = {}) => {
    try {
      const requestedTheme = typeof payload === 'string'
        ? payload
        : payload?.theme;
      const normalizedTheme = String(requestedTheme || '').trim().toLowerCase();
      const themePreference = normalizedTheme === 'dark' ? 'dark' : 'light';

      const updatedAppState = saveAppState(app, { themePreference });
      setAppState(updatedAppState);

      return { success: true, themePreference };
    } catch (error) {
      console.error('Error saving theme preference:', error);
      return { success: false, error: error.message };
    }
  });

  ipcMain.handle('save-settings', async (_event, settings = {}) => {
    console.log('IPC: save-settings called');

    try {
      const appEnvironment = getAppEnvironment();
      const currentAppState = getAppState() || {};
      const nextAiProvider = geminiRuntime.setActiveAiProvider(settings.aiProvider);
      const nextGeminiApiKey = String(settings.geminiApiKey || '').trim();
      const nextAssemblyAiApiKey = String(settings.assemblyAiApiKey || '').trim();
      const nextPortkeyApiKey = String(
        settings.portkeyApiKey ?? currentAppState.portkeyApiKey ?? ''
      ).trim();
      const nextPortkeyProvider = geminiRuntime.setActivePortkeyProvider(
        settings.portkeyProvider ?? currentAppState.portkeyProvider
      );
      const nextPortkeyBaseUrl = geminiRuntime.setActivePortkeyBaseUrl(
        settings.portkeyBaseUrl ?? currentAppState.portkeyBaseUrl
      );
      const nextGeminiModel = geminiRuntime.setActiveGeminiModel(settings.geminiModel);
      const nextAssemblyModel = setAssemblyAiSpeechModel(settings.assemblyAiSpeechModel);
      const nextSttProvider = typeof setSttProvider === 'function'
        ? setSttProvider(settings.sttProvider ?? currentAppState.sttProvider ?? defaultSttProvider)
        : (settings.sttProvider ?? currentAppState.sttProvider ?? defaultSttProvider);
      const nextOpenAiSttModel = typeof setOpenAiSttModel === 'function'
        ? setOpenAiSttModel(settings.openaiSttModel ?? currentAppState.openaiSttModel ?? defaultOpenAiSttModel)
        : (settings.openaiSttModel ?? currentAppState.openaiSttModel ?? defaultOpenAiSttModel);
      const nextProgrammingLanguage = geminiRuntime.setActiveProgrammingLanguage(settings.programmingLanguage);
      const nextCustomOutputTemplate = sanitizeCustomOutputTemplate(
        settings.customOutputTemplate ?? currentAppState.customOutputTemplate
      );
      const nextDefaultOutputFormat = resolveOutputFormat(
        settings.defaultOutputFormat ?? currentAppState.defaultOutputFormat,
        nextCustomOutputTemplate
      );
      const nextWindowOpacityLevel = windowController.setWindowOpacityLevel(settings.windowOpacityLevel);
      const nextWebSearchEnabled = settings.webSearchEnabled === true;
      const nextRequestWebSearchEnabled = settings.requestWebSearchEnabled === true;
      const nextWebSearchProvider = settings.webSearchProvider === 'tavily' ? 'tavily' : 'gemini-grounding';
      const nextTavilyApiKey = String(settings.tavilyApiKey || '').trim();
      const nextPromptCacheEnabled = settings.promptCacheEnabled !== false;
      const nextAutoScreenIntervalSeconds = resolveAutoScreenIntervalSeconds(
        settings.autoScreenIntervalSeconds
      );
      geminiRuntime.setActiveWebSearchEnabled(nextWebSearchEnabled);
      geminiRuntime.setActivePortkeyApiKey(nextPortkeyApiKey);

      const nextHideFromScreenCapture = resolveHideFromScreenCapture(
        settings.hideFromScreenCapture,
        appEnvironment.hideFromScreenCapture
      );

      const updatedEnvironment = saveApplicationEnvironment(app, {
        hideFromScreenCapture: nextHideFromScreenCapture,
        startHidden: appEnvironment.startHidden,
        maxScreenshots: appEnvironment.maxScreenshots,
        screenshotDelay: appEnvironment.screenshotDelay,
        nodeEnv: appEnvironment.nodeEnv,
        nodeOptions: appEnvironment.nodeOptions
      });

      const keyState = geminiRuntime.setKeys(nextGeminiApiKey, 0);
      const updatedAppState = saveAppState(app, {
        aiProvider: nextAiProvider,
        geminiApiKey: nextGeminiApiKey,
        assemblyAiApiKey: nextAssemblyAiApiKey,
        geminiApiKeyIndex: keyState.activeApiKeyIndex,
        geminiModel: nextGeminiModel,
        portkeyApiKey: nextPortkeyApiKey || null,
        portkeyProvider: nextPortkeyProvider,
        portkeyBaseUrl: nextPortkeyBaseUrl || null,
        assemblyAiSpeechModel: nextAssemblyModel,
        programmingLanguage: nextProgrammingLanguage,
        defaultOutputFormat: nextDefaultOutputFormat,
        customOutputTemplate: nextCustomOutputTemplate,
        windowOpacityLevel: nextWindowOpacityLevel,
        webSearchEnabled: nextWebSearchEnabled,
        requestWebSearchEnabled: nextRequestWebSearchEnabled,
        webSearchProvider: nextWebSearchProvider,
        tavilyApiKey: nextTavilyApiKey || null,
        promptCacheEnabled: nextPromptCacheEnabled,
        autoScreenIntervalSeconds: nextAutoScreenIntervalSeconds,
        sttProvider: nextSttProvider,
        openaiApiKey: typeof settings.openaiApiKey === 'string'
          ? settings.openaiApiKey.trim() || null
          : currentAppState.openaiApiKey ?? null,
        openaiSttModel: nextOpenAiSttModel,
        resumeText: typeof settings.resumeText === 'string'
          ? settings.resumeText
          : currentAppState.resumeText ?? null,
        jobDescriptionText: typeof settings.jobDescriptionText === 'string'
          ? settings.jobDescriptionText
          : currentAppState.jobDescriptionText ?? null
      });

      setAppEnvironment(updatedEnvironment);
      setAppState(updatedAppState);

      // Re-apply content protection BEFORE the fragile onSettingsSaved
      // callback runs. If onSettingsSaved throws, hide must already be
      // applied from the freshly persisted environment.
      if (typeof windowController.applyContentProtection === 'function') {
        windowController.applyContentProtection();
      }

      await onSettingsSaved?.(updatedAppState);

      console.log('Saved app state to:', getAppStatePath(app));
      console.log('Settings saved to:', updatedEnvironment.envPath);
      console.log('Applied AI provider:', nextAiProvider);
      console.log('Applied programming language:', nextProgrammingLanguage);
      console.log(`Applied window opacity level: ${nextWindowOpacityLevel}/10`);
      console.log('Applied web search enabled:', nextWebSearchEnabled);
      console.log('Applied STT provider:', nextSttProvider);

      if (nextAiProvider === 'portkey') {
        console.log(`Applied Portkey provider: ${nextPortkeyProvider}, model: ${nextGeminiModel}`);
        geminiRuntime.initializePortkeyService(
          nextPortkeyApiKey,
          nextGeminiModel,
          nextProgrammingLanguage,
          {
            provider: nextPortkeyProvider,
            baseUrl: nextPortkeyBaseUrl
          }
        );
      } else {
        console.log(`Applied Gemini API key index: ${keyState.activeApiKeyIndex + 1}/${keyState.geminiApiKeys.length}`);
        geminiRuntime.initializeGeminiService(
          keyState.activeApiKey,
          nextGeminiModel,
          nextProgrammingLanguage
        );
      }

      return {
        success: true,
        isAiReady: geminiRuntime.isAiReady(),
        settings: {
          autoScreenIntervalSeconds: nextAutoScreenIntervalSeconds,
          autoScreenIntervalMs: resolveAutoScreenIntervalMilliseconds(
            nextAutoScreenIntervalSeconds
          ),
          defaultOutputFormat: nextDefaultOutputFormat,
          customOutputTemplate: nextCustomOutputTemplate
        }
      };
    } catch (error) {
      console.error('Error saving settings:', error);
      return { success: false, error: error.message };
    }
  });
}

module.exports = {
  registerSettingsIpc
};
