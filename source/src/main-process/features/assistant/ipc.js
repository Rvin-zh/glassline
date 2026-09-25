const path = require('path');
const { spawn } = require('child_process');
const {
  isConfiguredOutputFormat,
  resolveOutputFormat,
  sanitizeCustomOutputTemplate
} = require('../../../config');
const {
  chooseLayer,
  folioScriptPath
} = require('../../../platform/external-layers');
const {
  isVertexProviderSlug
} = require('../../../services/ai/portkey-service');

const AI_CONTEXT_CHANGED_ERROR_CODE = 'AI_CONTEXT_CHANGED';
const AI_CONTEXT_CHANGED_MESSAGE =
  'Context changed while this request was queued. Please retry.';

function registerAssistantIpc({
  ipcMain,
  screenshotManager,
  windowController,
  geminiRuntime,
  assemblyAiService,
  sendToRenderer,
  quitApplication,
  getContextServices,
  getAppState
}) {
  let chatContext = [];

  function getContextServicesOrNull() {
    return typeof getContextServices === 'function' ? getContextServices() : null;
  }

  function getTrustedOutputPromptOptions(payload = {}) {
    const appState = typeof getAppState === 'function' ? getAppState() || {} : {};
    const customOutputTemplate = sanitizeCustomOutputTemplate(
      appState.customOutputTemplate
    );
    const hasRendererSelection = Object.prototype.hasOwnProperty.call(
      payload,
      'outputFormat'
    );
    if (
      hasRendererSelection &&
      !isConfiguredOutputFormat(payload.outputFormat)
    ) {
      const error = new Error('Invalid output format.');
      error.code = 'INVALID_OUTPUT_FORMAT';
      throw error;
    }

    const requestedFormat = hasRendererSelection
      ? payload.outputFormat
      : appState.defaultOutputFormat;
    const outputFormat = resolveOutputFormat(
      requestedFormat,
      customOutputTemplate
    );

    return {
      outputFormat,
      customOutputTemplate: outputFormat === 'custom'
        ? customOutputTemplate
        : ''
    };
  }

  function mapPinnedPromptOptions(assembled = {}) {
    return {
      resume: assembled.resume || '',
      jobDescription: assembled.jobDescription || '',
      memorySummary: assembled.promptMemorySummary ?? assembled.memorySummary ?? '',
      durableNotes: assembled.promptDurableNotes ?? assembled.durableNotes ?? [],
      searchResults: assembled.searchResults || []
    };
  }

  function emptyCacheBinding() {
    return {
      cachedContentName: '',
      release: null
    };
  }

  function createContextChangedError() {
    const error = new Error(AI_CONTEXT_CHANGED_MESSAGE);
    error.code = AI_CONTEXT_CHANGED_ERROR_CODE;
    error.retryable = true;
    error.cancelled = true;
    return error;
  }

  function isContextChangedError(error) {
    return error?.code === AI_CONTEXT_CHANGED_ERROR_CODE;
  }

  function contextChangedResponseMetadata(error) {
    return isContextChangedError(error)
      ? {
          code: AI_CONTEXT_CHANGED_ERROR_CODE,
          retryable: true,
          cancelled: true
        }
      : {};
  }

  function getPreparedContextGeneration(prepared = {}) {
    return prepared?.contextMetadata?.generation;
  }

  function assertPreparedContextCurrent(prepared = {}) {
    const expectedGeneration = getPreparedContextGeneration(prepared);
    if (expectedGeneration === undefined) {
      return;
    }

    const cacheManager = getContextServicesOrNull()?.cacheManager;
    const current = typeof cacheManager?.isGenerationCurrent === 'function'
      ? cacheManager.isGenerationCurrent(expectedGeneration)
      : typeof cacheManager?.getGeneration === 'function'
        ? cacheManager.getGeneration() === expectedGeneration
        : false;
    if (!current) {
      throw createContextChangedError();
    }
  }

  function getExecutionCacheConfiguration(execution = {}) {
    if (execution.provider === 'gemini') {
      return Object.freeze({
        apiKey: execution.activeApiKey || '',
        provider: 'gemini',
        cacheNamespace: 'gemini',
        baseUrl: ''
      });
    }
    if (execution.provider !== 'portkey') {
      return null;
    }

    let configuration;
    try {
      configuration = execution.getCacheConfiguration?.();
    } catch {
      return null;
    }
    if (
      !configuration ||
      !configuration.apiKey ||
      !isVertexProviderSlug(configuration.provider)
    ) {
      return null;
    }
    return configuration;
  }

  async function resolveExecutionCache(
    assembled,
    execution = {},
    expectedGeneration
  ) {
    const cacheConfiguration = getExecutionCacheConfiguration(execution);
    if (
      !cacheConfiguration ||
      execution.isModelFallback === true ||
      execution.cacheSuppressed === true
    ) {
      return emptyCacheBinding();
    }

    const services = getContextServicesOrNull();
    const cacheManager = services?.cacheManager;
    const acquireCache = typeof cacheManager?.acquireCache === 'function'
      ? cacheManager.acquireCache
      : cacheManager?.ensureCache;
    if (
      typeof acquireCache !== 'function' ||
      typeof cacheManager?.buildFingerprint !== 'function'
    ) {
      return emptyCacheBinding();
    }

    const params = {
      model: execution.modelName,
      programmingLanguage: execution.programmingLanguage ||
        geminiRuntime.getActiveProgrammingLanguage(),
      resume: assembled.resume || '',
      jobDescription: assembled.jobDescription || '',
      apiKey: cacheConfiguration.apiKey,
      provider: cacheConfiguration.provider,
      cacheNamespace: cacheConfiguration.cacheNamespace,
      baseUrl: cacheConfiguration.baseUrl
    };
    if (expectedGeneration !== undefined) {
      params.expectedGeneration = expectedGeneration;
    }
    let cacheResult = null;
    try {
      const expected = cacheManager.buildFingerprint(params);
      if (!expected?.fingerprint) {
        return emptyCacheBinding();
      }

      cacheResult = await acquireCache.call(cacheManager, params);
      if (cacheResult?.reason === 'stale-generation') {
        throw createContextChangedError();
      }
      const metadataMatches =
        cacheResult?.used === true &&
        cacheResult.model === execution.modelName &&
        cacheResult.fingerprint === expected.fingerprint &&
        typeof cacheResult.cacheName === 'string' &&
        cacheResult.cacheName.trim().length > 0;

      if (!metadataMatches) {
        await cacheResult?.release?.();
        return emptyCacheBinding();
      }

      return {
        cachedContentName: cacheResult.cacheName.trim(),
        release: typeof cacheResult.release === 'function'
          ? () => cacheResult.release()
          : null
      };
    } catch (error) {
      await cacheResult?.release?.();
      if (isContextChangedError(error)) {
        throw error;
      }
      console.warn('[assistant-ipc] Cache acquisition failed; continuing without cache.', {
        provider: execution.provider,
        model: execution.modelName
      });
      return emptyCacheBinding();
    }
  }

  async function runWithBoundExecutionCache(service, execution, prepared, operation) {
    assertPreparedContextCurrent(prepared);
    const cacheBinding = await resolveExecutionCache(
      prepared.assembled,
      execution,
      getPreparedContextGeneration(prepared)
    );
    try {
      execution.rebindServiceForRequest?.();
      assertPreparedContextCurrent(prepared);
      const serviceProvider = service?.capabilities?.provider || '';
      const serviceModel = service?.modelName || service?.model || '';
      const serviceAdapter = service?.adapter;
      const serviceApiKey = serviceAdapter?.apiKey;
      const cacheConfiguration = getExecutionCacheConfiguration(execution);
      const serviceMatchesExecution =
        serviceProvider === execution.provider &&
        serviceModel === execution.modelName &&
        (
          execution.provider === 'gemini'
            ? (
                serviceApiKey === undefined ||
                serviceApiKey === execution.activeApiKey
              )
            : execution.provider === 'portkey' &&
              service?.capabilities?.supportsExplicitCache === true &&
              serviceApiKey === cacheConfiguration?.apiKey &&
              serviceAdapter?.provider === cacheConfiguration?.provider &&
              serviceAdapter?.baseUrl === cacheConfiguration?.baseUrl
        );
      const request = operation(
        serviceMatchesExecution ? cacheBinding.cachedContentName : ''
      );
      return await request;
    } finally {
      await cacheBinding.release?.();
    }
  }

  async function prepareDesktopAiContext(payload = {}) {
    const services = getContextServicesOrNull();
    if (!services?.buildAssembledContext) {
      return {
        assembled: {
          contextString: payload.contextString || '',
          transcriptContext: payload.transcriptContext || '',
          resume: '',
          jobDescription: '',
          memorySummary: '',
          durableNotes: [],
          searchResults: [],
          enabledScreenshotIds: payload.enabledScreenshotIds || []
        },
        citations: []
      };
    }

    const {
      assembled,
      citations,
      useNativeGeminiGrounding,
      searchEnabled,
      contextMetadata
    } = await services.buildAssembledContext(
      {
        ...payload,
        enableSearch: payload.enableSearch === true
      },
      'desktop'
    );

    return {
      assembled,
      citations,
      useNativeGeminiGrounding: Boolean(useNativeGeminiGrounding),
      searchEnabled: Boolean(searchEnabled),
      contextMetadata
    };
  }

  function triggerMemoryUpdate(payload = {}) {
    const services = getContextServicesOrNull();
    services?.memoryService?.triggerUpdate?.({
      transcript: payload.transcriptContext || payload.contextString || '',
      recentAnswers: payload.recentAnswers || ''
    });
  }

  function getAllKeysUnavailableMessage() {
    return 'All configured Gemini API keys are currently unavailable (quota exhausted or invalid). Please wait and try again later.';
  }

  function mapGeminiErrorMessage(error, fallbackPrefix = 'Request failed') {
    const message = String(error?.message || '');
    const normalizedMessage = message.toLowerCase();

    if (isContextChangedError(error)) {
      return AI_CONTEXT_CHANGED_MESSAGE;
    }

    if (geminiRuntime.isAllKeysUnavailableError?.(error)) {
      return getAllKeysUnavailableMessage();
    }

    if (normalizedMessage.includes('no api key configured') || normalizedMessage.includes('no gemini api key') || normalizedMessage.includes('ai provider is not ready') || normalizedMessage.includes('no portkey api key')) {
      return 'AI provider is not ready. Configure it in Settings.';
    }

    if (
      normalizedMessage.includes('api key not valid') ||
      normalizedMessage.includes('invalid api key') ||
      normalizedMessage.includes('api_key_invalid') ||
      normalizedMessage.includes('permission denied') ||
      normalizedMessage.includes('permission_denied') ||
      normalizedMessage.includes('unauthorized') ||
      normalizedMessage.includes('forbidden') ||
      normalizedMessage.includes('401') ||
      normalizedMessage.includes('403')
    ) {
      return 'Invalid Gemini API key. Please check the key values in Settings.';
    }

    if (
      normalizedMessage.includes('quota') ||
      normalizedMessage.includes('daily request limit') ||
      normalizedMessage.includes('exceeded your current quota')
    ) {
      return 'API quota exceeded. Please try again later.';
    }

    if (normalizedMessage.includes('network') || normalizedMessage.includes('fetch')) {
      return 'Network error. Please check your internet connection.';
    }

    if (normalizedMessage.includes('model')) {
      return 'AI model error. Please try a different model.';
    }

    return message ? `${fallbackPrefix}: ${message}` : fallbackPrefix;
  }

  async function analyzeForMeetingWithContext(contextInput = '') {
    const payload = typeof contextInput === 'object' && contextInput !== null
      ? contextInput
      : { contextString: String(contextInput || '') };
    let outputPromptOptions;
    try {
      outputPromptOptions = getTrustedOutputPromptOptions(payload);
    } catch (error) {
      const result = {
        success: false,
        error: mapGeminiErrorMessage(error, 'Analysis failed')
      };
      sendToRenderer('analysis-result', result);
      return result;
    }

    const contextString = typeof payload.contextString === 'string' ? payload.contextString : '';
    const enabledScreenshotIds = Array.isArray(payload.enabledScreenshotIds) ? payload.enabledScreenshotIds : null;

    console.log('Starting context-aware analysis...');
    console.log('Context length:', contextString.length);
    console.log('API Keys configured:', geminiRuntime.getApiKeys().length);
    console.log('AI ready:', geminiRuntime.isAiReady());
    console.log('Programming language preference:', geminiRuntime.getActiveProgrammingLanguage());
    console.log('Screenshots count:', screenshotManager.getScreenshotsCount());

    if (!geminiRuntime.isAiReady()) {
      const result = {
        success: false,
        error: 'AI provider is not ready. Configure it in Settings.'
      };
      sendToRenderer('analysis-result', result);
      return result;
    }

    if (!screenshotManager.hasScreenshots()) {
      const result = {
        success: false,
        error: 'No screenshots to analyze. Take a screenshot first.'
      };
      sendToRenderer('analysis-result', result);
      return result;
    }

    try {
      sendToRenderer('analysis-start');

      const { imageParts } = await screenshotManager.buildImagePartsFromScreenshots({
        strict: true,
        includeIds: enabledScreenshotIds
      });

      if (imageParts.length === 0) {
        const result = {
          success: false,
          error: 'No enabled screenshots selected for analysis.'
        };
        sendToRenderer('analysis-result', result);
        return result;
      }

      const prepared = await prepareDesktopAiContext({
        contextString,
        transcriptContext: typeof payload.transcriptContext === 'string' ? payload.transcriptContext : '',
        enabledScreenshotIds,
        enableSearch: payload.enableSearch === true,
        searchQuery: payload.searchQuery || contextString
      });

      const onChunk = ({ text, index }) => {
        sendToRenderer('ai-stream-chunk', { actionId: 'screenAi', text, index });
      };
      sendToRenderer('ai-stream-start', { actionId: 'screenAi' });

      const text = await geminiRuntime.executeWithKeyFailover(async (geminiService, execution) => {
        if (!geminiService || !geminiService.isReady()) {
          throw new Error('AI provider is not ready. Please check your settings.');
        }

        return runWithBoundExecutionCache(
          geminiService,
          execution,
          prepared,
          (cachedContentName) => geminiService.analyzeScreenshots(
            imageParts,
            '',
            {
              contextStringOverride: prepared.assembled.contextString || contextString,
              onChunk,
              cachedContentName,
              webSearchEnabled: prepared.useNativeGeminiGrounding === true,
              ...mapPinnedPromptOptions(prepared.assembled),
              ...outputPromptOptions
            }
          )
        );
      });

      chatContext.push({
        type: 'analysis',
        content: text,
        timestamp: new Date().toISOString(),
        screenshotCount: imageParts.length
      });

      triggerMemoryUpdate({
        transcriptContext: prepared.assembled.transcriptContext || contextString,
        recentAnswers: text
      });

      sendToRenderer('ai-stream-end', { actionId: 'screenAi' });
      const result = {
        success: true,
        text,
        citations: prepared.citations || []
      };
      sendToRenderer('analysis-result', result);
      return result;
    } catch (error) {
      console.error('Analysis error details:', error);

      sendToRenderer('ai-stream-end', { actionId: 'screenAi' });
      const result = {
        success: false,
        error: mapGeminiErrorMessage(error, 'Analysis failed'),
        ...contextChangedResponseMetadata(error)
      };
      sendToRenderer('analysis-result', result);
      return result;
    }
  }

  async function analyzeForMeeting() {
    return analyzeForMeetingWithContext();
  }

  ipcMain.handle('get-screenshots-count', () => {
    return screenshotManager.getScreenshotsCount();
  });

  ipcMain.handle('choose-external-layer', async (_event, payload = {}) => {
    const choice = chooseLayer(payload.layerId);
    if (!choice.ok || !choice.external) {
      return choice;
    }
    const script = folioScriptPath({
      resourcesPath: process.resourcesPath,
      repoRoot: path.resolve(__dirname, '../../../../../')
    });
    const child = spawn(process.execPath, [script], {
      detached: true,
      stdio: 'ignore',
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }
    });
    child.unref();
    return { ...choice, script, pid: child.pid };
  });

  ipcMain.handle('get-window-bounds', () => {
    return windowController.getWindowBounds();
  });

  ipcMain.handle('set-window-bounds', (_event, nextBounds) => {
    return windowController.setWindowBounds(nextBounds);
  });

  ipcMain.handle('set-window-size-preset', (_event, payload = {}) => {
    const preset = typeof payload === 'number' ? payload : payload?.preset;
    return windowController.setWindowSizePreset(preset);
  });

  ipcMain.handle('toggle-stealth', () => {
    return windowController.toggleStealthMode();
  });

  ipcMain.handle('emergency-hide', () => {
    return windowController.emergencyHide();
  });

  ipcMain.handle('take-stealth-screenshot', async (_event, payload = {}) => {
    const origin = payload?.origin === 'auto' ? 'auto' : 'manual';
    return screenshotManager.takeStealthScreenshot(origin);
  });

  ipcMain.handle('analyze-stealth', async () => {
    return analyzeForMeeting();
  });

  ipcMain.handle('analyze-stealth-with-context', async (_event, context) => {
    return analyzeForMeetingWithContext(context);
  });

  ipcMain.handle('ask-ai-with-session-context', async (_event, payload = {}) => {
    const mode = payload?.mode === 'best-next-answer' ? 'best-next-answer' : 'best-next-answer';

    try {
      const outputPromptOptions = getTrustedOutputPromptOptions(payload);
      assemblyAiService.flushAllSttHistoryBuffers('pre-ask-ai');

      if (!geminiRuntime.isAiReady()) {
        throw new Error('AI provider is not ready. Configure it in Settings.');
      }

      const transcriptContext = typeof payload?.transcriptContext === 'string'
        ? payload.transcriptContext.trim()
        : '';
      const sessionSummary = typeof payload?.sessionSummary === 'string'
        ? payload.sessionSummary.trim()
        : '';
      const contextString = typeof payload?.contextString === 'string'
        ? payload.contextString.trim()
        : '';
      const enabledScreenshotIds = Array.isArray(payload?.enabledScreenshotIds)
        ? payload.enabledScreenshotIds.filter((id) => typeof id === 'string' && id.trim().length > 0)
        : null;

      if (!transcriptContext && !contextString && !screenshotManager.hasScreenshots()) {
        return {
          success: false,
          error: 'No transcript or screenshots available yet. Start transcription or capture a screenshot first.',
          mode,
          usedScreenshots: false
        };
      }

      const prepared = await prepareDesktopAiContext({
        contextString,
        transcriptContext,
        sessionSummary,
        enabledScreenshotIds,
        enableSearch: payload?.enableSearch === true,
        searchQuery: payload?.searchQuery || transcriptContext || contextString
      });
      const pinnedOptions = mapPinnedPromptOptions(prepared.assembled);

      const onChunk = ({ text, index }) => {
        sendToRenderer('ai-stream-chunk', { actionId: 'askAi', text, index });
      };
      sendToRenderer('ai-stream-start', { actionId: 'askAi' });

      let usedScreenshots = false;
      let usedScreenshotCount = 0;
      let text = '';

      if (screenshotManager.hasScreenshots()) {
        const { imageParts } = await screenshotManager.buildImagePartsFromScreenshots({
          strict: false,
          includeIds: enabledScreenshotIds
        });

        if (imageParts.length > 0) {
          usedScreenshots = true;
          usedScreenshotCount = imageParts.length;
          text = await geminiRuntime.executeWithKeyFailover(async (geminiService, execution) => {
            if (!geminiService || !geminiService.isReady()) {
              throw new Error('AI provider is not ready. Please check your settings.');
            }

            return runWithBoundExecutionCache(
              geminiService,
              execution,
              prepared,
              (cachedContentName) => geminiService.askAiWithSessionContextAndScreenshots(
                imageParts,
                {
                  contextString: prepared.assembled.contextString || contextString,
                  transcriptContext: prepared.assembled.transcriptContext || transcriptContext,
                  sessionSummary,
                  screenshotCount: imageParts.length,
                  mode,
                  onChunk,
                  cachedContentName,
                  webSearchEnabled: prepared.useNativeGeminiGrounding === true,
                  ...pinnedOptions,
                  ...outputPromptOptions
                }
              )
            );
          });
        }
      }

      if (!text) {
        text = await geminiRuntime.executeWithKeyFailover(async (geminiService, execution) => {
          if (!geminiService || !geminiService.isReady()) {
            throw new Error('AI provider is not ready. Please check your settings.');
          }

          return runWithBoundExecutionCache(
            geminiService,
            execution,
            prepared,
            (cachedContentName) => geminiService.askAiWithSessionContext({
              contextString: prepared.assembled.contextString || contextString,
              transcriptContext: prepared.assembled.transcriptContext || transcriptContext,
              sessionSummary,
              screenshotCount: usedScreenshots ? usedScreenshotCount : 0,
              mode,
              onChunk,
              cachedContentName,
              webSearchEnabled: prepared.useNativeGeminiGrounding === true,
              ...pinnedOptions,
              ...outputPromptOptions
            })
          );
        });
      }

      chatContext.push({
        type: 'ask-ai',
        content: text,
        timestamp: new Date().toISOString(),
        screenshotCount: usedScreenshots ? usedScreenshotCount : 0
      });

      triggerMemoryUpdate({
        transcriptContext: prepared.assembled.transcriptContext || transcriptContext,
        recentAnswers: text
      });

      sendToRenderer('ai-stream-end', { actionId: 'askAi' });
      return {
        success: true,
        text,
        mode,
        usedScreenshots,
        citations: prepared.citations || []
      };
    } catch (error) {
      if (error?.code !== 'INVALID_OUTPUT_FORMAT') {
        console.error('Error in ask-ai-with-session-context:', error);
      }
      sendToRenderer('ai-stream-end', { actionId: 'askAi' });
      return {
        success: false,
        error: mapGeminiErrorMessage(error, 'Ask AI failed'),
        mode,
        usedScreenshots: false,
        ...contextChangedResponseMetadata(error)
      };
    }
  });

  ipcMain.handle('clear-stealth', () => {
    chatContext = [];
    return screenshotManager.clearStealth();
  });

  ipcMain.handle('close-app', () => {
    setTimeout(() => {
      quitApplication();
    }, 0);

    return { success: true };
  });

  ipcMain.handle('add-voice-transcript', async (_event, transcript) => {
    const geminiService = geminiRuntime.getService();
    if (geminiService) {
      geminiService.addToHistory('user', transcript);
    }

    return { success: true };
  });

  ipcMain.handle('suggest-response', async (_event, context) => {
    try {
      const payload = typeof context === 'object' && context !== null
        ? context
        : { context };
      const outputPromptOptions = getTrustedOutputPromptOptions(payload);
      assemblyAiService.flushAllSttHistoryBuffers('pre-suggest');
      if (!geminiRuntime.isAiReady()) {
        throw new Error('AI provider is not ready. Configure it in Settings.');
      }

      const contextPrompt = typeof payload.context === 'string'
        ? payload.context
        : 'Current meeting conversation';
      const contextStringOverride = typeof payload.contextString === 'string'
        ? payload.contextString
        : '';

      const onChunk = ({ text, index }) => {
        sendToRenderer('ai-stream-chunk', { actionId: 'suggest', text, index });
      };
      sendToRenderer('ai-stream-start', { actionId: 'suggest' });

      const suggestions = await geminiRuntime.executeWithKeyFailover((geminiService) => {
        if (!geminiService || !geminiService.isReady()) {
          throw new Error('AI provider is not ready');
        }

        return geminiService.suggestResponse(contextPrompt, {
          contextString: contextStringOverride,
          onChunk,
          ...outputPromptOptions
        });
      });

      sendToRenderer('ai-stream-end', { actionId: 'suggest' });
      return { success: true, suggestions };
    } catch (error) {
      if (error?.code !== 'INVALID_OUTPUT_FORMAT') {
        console.error('Error generating suggestions:', error);
      }
      sendToRenderer('ai-stream-end', { actionId: 'suggest' });
      return { success: false, error: mapGeminiErrorMessage(error, 'Failed to generate suggestions') };
    }
  });

  ipcMain.handle('generate-meeting-notes', async (_event, payload = {}) => {
    try {
      assemblyAiService.flushAllSttHistoryBuffers('pre-notes');
      if (!geminiRuntime.isAiReady()) {
        throw new Error('AI provider is not ready. Configure it in Settings.');
      }

      const contextStringOverride = typeof payload?.contextString === 'string'
        ? payload.contextString
        : '';

      const onChunk = ({ text, index }) => {
        sendToRenderer('ai-stream-chunk', { actionId: 'notes', text, index });
      };
      sendToRenderer('ai-stream-start', { actionId: 'notes' });

      const notes = await geminiRuntime.executeWithKeyFailover((geminiService) => {
        if (!geminiService || !geminiService.isReady()) {
          throw new Error('AI provider is not ready');
        }

        return geminiService.generateMeetingNotes({
          contextString: contextStringOverride,
          onChunk
        });
      });

      sendToRenderer('ai-stream-end', { actionId: 'notes' });
      return { success: true, notes };
    } catch (error) {
      console.error('Error generating meeting notes:', error);
      sendToRenderer('ai-stream-end', { actionId: 'notes' });
      return { success: false, error: mapGeminiErrorMessage(error, 'Failed to generate meeting notes') };
    }
  });

  ipcMain.handle('generate-follow-up-email', async () => {
    try {
      assemblyAiService.flushAllSttHistoryBuffers('pre-followup');
      if (!geminiRuntime.isAiReady()) {
        throw new Error('AI provider is not ready. Configure it in Settings.');
      }

      const email = await geminiRuntime.executeWithKeyFailover((geminiService) => {
        if (!geminiService || !geminiService.isReady()) {
          throw new Error('AI provider is not ready');
        }

        return geminiService.generateFollowUpEmail();
      });

      return { success: true, email };
    } catch (error) {
      console.error('Error generating email:', error);
      return { success: false, error: mapGeminiErrorMessage(error, 'Failed to generate follow-up email') };
    }
  });

  ipcMain.handle('answer-question', async (_event, questionInput) => {
    try {
      const payload = questionInput && typeof questionInput === 'object'
        ? questionInput
        : { question: questionInput };
      const question = typeof payload.question === 'string'
        ? payload.question
        : String(payload.question || '');
      const outputPromptOptions = getTrustedOutputPromptOptions(payload);
      assemblyAiService.flushAllSttHistoryBuffers('pre-answer');
      if (!geminiRuntime.isAiReady()) {
        throw new Error('AI provider is not ready. Configure it in Settings.');
      }

      const answer = await geminiRuntime.executeWithKeyFailover((geminiService) => {
        if (!geminiService || !geminiService.isReady()) {
          throw new Error('AI provider is not ready');
        }

        return geminiService.answerQuestion(question, outputPromptOptions);
      });

      return { success: true, answer };
    } catch (error) {
      if (error?.code !== 'INVALID_OUTPUT_FORMAT') {
        console.error('Error answering question:', error);
      }
      return { success: false, error: mapGeminiErrorMessage(error, 'Failed to answer question') };
    }
  });

  ipcMain.handle('get-conversation-insights', async (_event, payload = {}) => {
    try {
      assemblyAiService.flushAllSttHistoryBuffers('pre-insights');
      if (!geminiRuntime.isAiReady()) {
        throw new Error('AI provider is not ready. Configure it in Settings.');
      }

      const contextStringOverride = typeof payload?.contextString === 'string'
        ? payload.contextString
        : '';

      const onChunk = ({ text, index }) => {
        sendToRenderer('ai-stream-chunk', { actionId: 'insights', text, index });
      };
      sendToRenderer('ai-stream-start', { actionId: 'insights' });

      const insights = await geminiRuntime.executeWithKeyFailover((geminiService) => {
        if (!geminiService || !geminiService.isReady()) {
          throw new Error('AI provider is not ready');
        }

        return geminiService.getConversationInsights({
          contextString: contextStringOverride,
          onChunk
        });
      });

      sendToRenderer('ai-stream-end', { actionId: 'insights' });
      return { success: true, insights };
    } catch (error) {
      console.error('Error getting insights:', error);
      sendToRenderer('ai-stream-end', { actionId: 'insights' });
      return { success: false, error: mapGeminiErrorMessage(error, 'Failed to get conversation insights') };
    }
  });

  ipcMain.handle('clear-conversation-history', async () => {
    const geminiService = geminiRuntime.getService();
    const services = getContextServicesOrNull();

    try {
      assemblyAiService.resetSttHistoryBuffers();
      if (geminiService) {
        geminiService.clearHistory();
      }

      chatContext = [];
      return { success: true };
    } catch (error) {
      console.error('Error clearing history:', error);
      return { success: false, error: error.message };
    } finally {
      void services;
    }
  });

  ipcMain.handle('clear-session-memory', async () => {
    const services = getContextServicesOrNull();
    if (!services?.memoryService) {
      return { success: false, error: 'Memory service unavailable' };
    }
    await services.memoryService.clearSessionMemory();
    return { success: true };
  });

  ipcMain.handle('clear-documents', async () => {
    const services = getContextServicesOrNull();
    if (!services?.documentService) {
      return { success: false, error: 'Document service unavailable' };
    }
    await services.documentService.clear();
    return { success: true };
  });

  ipcMain.handle('clear-durable-notes', async () => {
    const services = getContextServicesOrNull();
    if (!services?.memoryService) {
      return { success: false, error: 'Memory service unavailable' };
    }
    await services.memoryService.clearDurableNotes();
    services.memoryService.clearReviewQueue();
    return { success: true };
  });

  ipcMain.handle('get-conversation-history', async () => {
    const geminiService = geminiRuntime.getService();

    try {
      if (!geminiService) {
        return { success: true, history: [] };
      }

      return { success: true, history: geminiService.conversationHistory };
    } catch (error) {
      console.error('Error getting history:', error);
      return { success: false, error: error.message };
    }
  });
}

module.exports = {
  registerAssistantIpc
};
