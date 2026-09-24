const { BrowserWindow, dialog } = require('electron');
const { createDocumentService } = require('../../../services/documents/document-service');
const { createCacheManager } = require('../../../services/ai/cache-manager');
const {
  createPortkeyVertexCacheClient
} = require('../../../services/ai/portkey-vertex-cache-client');
const {
  isVertexProviderSlug
} = require('../../../services/ai/portkey-service');
const { GoogleGenAI } = require('@google/genai');
const {
  createBackgroundMemoryGenerator
} = require('../../../services/ai/background-memory-generator');
const { createMemoryService } = require('../../../services/ai/memory-service');
const { assembleContext } = require('../../../services/ai/context-assembler');
const { createSearchService } = require('../../../services/search');
const { createGeminiGroundingAdapter } = require('../../../services/search/gemini-grounding');
const { createTavilyAdapter } = require('../../../services/search/tavily');
const {
  clearInterviewSessions,
  deleteInterviewSession,
  getSelectedInterviewSessions,
  listInterviewSessions,
  selectInterviewSessions
} = require('../../../services/state/interview-sessions');

const DOCUMENT_FILE_FILTERS = [
  { name: 'Documents', extensions: ['pdf', 'docx', 'txt', 'md', 'text'] },
  { name: 'PDF', extensions: ['pdf'] },
  { name: 'Word', extensions: ['docx'] },
  { name: 'Text', extensions: ['txt', 'md', 'text'] }
];

function registerContextServicesIpc({
  ipcMain,
  app,
  getAppState,
  setAppState,
  saveAppState,
  geminiRuntime,
  sendToRenderer
}) {
  const configuredE2eDebounceMs = Number(
    process.env.OPEN_CLUELY_E2E_MEMORY_DEBOUNCE_MS
  );
  const memoryDebounceMs = (
    process.env.OPEN_CLUELY_E2E === '1'
    && Number.isFinite(configuredE2eDebounceMs)
    && configuredE2eDebounceMs >= 0
  )
    ? configuredE2eDebounceMs
    : undefined;
  const initialGeminiApiKey = geminiRuntime?.getActiveApiKey?.() ||
    String(getAppState()?.geminiApiKey || '')
      .split(',')
      .map((value) => value.trim())
      .filter(Boolean)[0] ||
    '';
  const cacheManager = createCacheManager({
    apiKey: initialGeminiApiKey,
    enabled: getAppState()?.promptCacheEnabled !== false,
    createClient(apiKey, context = {}) {
      if (context.provider === 'gemini') {
        return new GoogleGenAI({ apiKey });
      }
      if (isVertexProviderSlug(context.provider)) {
        return createPortkeyVertexCacheClient({
          apiKey,
          provider: context.provider,
          baseUrl: context.baseUrl
        });
      }
      return null;
    }
  });

  const documentService = createDocumentService({
    getDocuments: () => getAppState()?.documents,
    saveDocuments: async (documents) => {
      const updated = saveAppState(app, {
        documents,
        resumeText: documents?.resume?.text || null,
        jobDescriptionText: documents?.jobDescription?.text || null
      });
      setAppState(updated);
      return updated.documents;
    },
    onBeforeDocumentsChange: (reason) => cacheManager.invalidate(reason)
  });

  const geminiGroundingAdapter = createGeminiGroundingAdapter({
    apiKey: getAppState()?.geminiApiKey || ''
  });
  const tavilyAdapter = createTavilyAdapter({
    apiKey: getAppState()?.tavilyApiKey || ''
  });

  const searchService = createSearchService({
    globalEnabled: getAppState()?.webSearchEnabled === true,
    provider: getAppState()?.webSearchProvider || 'gemini-grounding',
    geminiGroundingAdapter,
    tavilyAdapter
  });

  function getBackgroundMemoryConfiguration() {
    const state = getAppState() || {};
    const stateGeminiKey = typeof state.geminiApiKey === 'string'
      ? state.geminiApiKey
      : '';
    const primaryGeminiKey = stateGeminiKey
      .split(',')
      .map((value) => value.trim())
      .filter(Boolean)[0] || '';

    return {
      provider: geminiRuntime?.getActiveAiProvider?.() || state.aiProvider || 'gemini',
      geminiApiKey: geminiRuntime?.getActiveApiKey?.() || primaryGeminiKey,
      portkeyApiKey: geminiRuntime?.getActivePortkeyApiKey?.() || state.portkeyApiKey || '',
      portkeyProvider: geminiRuntime?.getActivePortkeyProvider?.() || state.portkeyProvider || '',
      portkeyBaseUrl: geminiRuntime?.getActivePortkeyBaseUrl?.() || state.portkeyBaseUrl || ''
    };
  }

  const backgroundMemoryGenerator = createBackgroundMemoryGenerator(
    getBackgroundMemoryConfiguration()
  );

  const memoryService = createMemoryService({
    debounceMs: memoryDebounceMs,
    generateText: (prompt) => backgroundMemoryGenerator.generateText(prompt),
    getGenerationStatus: () => backgroundMemoryGenerator.getStatus(),
    initialSummary: getAppState()?.sessionMemory || null,
    loadDurableNotes: () => getAppState()?.durableNotes || [],
    onBeforeSummaryChange: (reason) => cacheManager.invalidate(reason),
    onBeforeDurableNotesChange: (reason) => cacheManager.invalidate(reason),
    persistDurableNotes: async (notes) => {
      const updated = saveAppState(app, { durableNotes: notes });
      setAppState(updated);
      return updated.durableNotes;
    },
    onSummaryUpdated: (summary) => {
      try {
        const updated = saveAppState(app, {
          sessionMemory: {
            ...summary,
            proposedDurableNotes: undefined,
            updatedAt: Date.now()
          }
        });
        setAppState(updated);
      } catch (error) {
        console.warn('[memory] Failed to persist session memory:', error.message);
      }
      sendToRenderer?.('memory-summary-updated', { summary });
    },
    onReviewQueueChanged: (queue) => {
      sendToRenderer?.('memory-review-queue-updated', { queue });
    }
  });

  function syncRuntimeCredentials() {
    const state = getAppState() || {};
    const geminiKey = typeof state.geminiApiKey === 'string' ? state.geminiApiKey : '';
    const primaryGeminiKey = geminiKey.split(',').map((value) => value.trim()).filter(Boolean)[0] || '';
    const activeGeminiKey = geminiRuntime?.getActiveApiKey?.() || primaryGeminiKey;

    const cacheKeySync = cacheManager.setApiKey(activeGeminiKey);
    const cacheEnabledSync = cacheManager.setEnabled(state.promptCacheEnabled !== false);
    backgroundMemoryGenerator.updateConfiguration({
      provider: geminiRuntime?.getActiveAiProvider?.() || state.aiProvider || 'gemini',
      geminiApiKey: activeGeminiKey,
      portkeyApiKey: geminiRuntime?.getActivePortkeyApiKey?.() || state.portkeyApiKey || '',
      portkeyProvider: geminiRuntime?.getActivePortkeyProvider?.() || state.portkeyProvider || '',
      portkeyBaseUrl: geminiRuntime?.getActivePortkeyBaseUrl?.() || state.portkeyBaseUrl || ''
    });
    geminiGroundingAdapter.setApiKey(activeGeminiKey);
    tavilyAdapter.setApiKey(state.tavilyApiKey || '');
    searchService.setGlobalEnabled(state.webSearchEnabled === true);
    searchService.setProvider(state.webSearchProvider || 'gemini-grounding');
    return Promise.all([cacheKeySync, cacheEnabledSync]);
  }

  syncRuntimeCredentials();

  function getDesktopPinnedContext() {
    const pinnedDocs = documentService.getPinnedDocumentTexts();
    return {
      resume: pinnedDocs.resume,
      jobDescription: pinnedDocs.jobDescription,
      memorySummary: memoryService.getSummary(),
      durableNotes: memoryService.getDurableNotes(),
      selectedInterviewSessions: getSelectedInterviewSessions(getAppState())
    };
  }

  async function maybeSearchForQuery(query, requestOptions = {}) {
    syncRuntimeCredentials();
    return searchService.search(query, requestOptions);
  }

  async function buildAssembledContext(payload = {}, audience = 'desktop') {
    await syncRuntimeCredentials();

    // Capture the generation and every prompt-visible pinned value in one
    // synchronous turn after credential synchronization completes.
    const contextMetadata = Object.freeze({
      generation: cacheManager.getGeneration()
    });
    const pinned = audience === 'desktop'
      ? getDesktopPinnedContext()
      : {
          resume: '',
          jobDescription: '',
          memorySummary: null,
          durableNotes: [],
          selectedInterviewSessions: []
        };

    const enableSearch = payload.enableSearch === true;
    const selectedProvider = payload.searchProvider === 'tavily' || payload.searchProvider === 'gemini-grounding' || payload.searchProvider === 'gemini'
      ? (payload.searchProvider === 'gemini' ? 'gemini-grounding' : payload.searchProvider)
      : (searchService.getProvider() === 'tavily' ? 'tavily' : 'gemini-grounding');

    let searchResults = [];
    let citations = [];
    let useNativeGeminiGrounding = false;

    if (enableSearch && searchService.isGlobalEnabled()) {
      if (selectedProvider === 'gemini-grounding') {
        // Grounding is applied on the live Ask/Screen AI call; no separate network hop here.
        useNativeGeminiGrounding = true;
      } else {
        const search = await maybeSearchForQuery(
          payload.searchQuery || payload.transcriptContext || payload.contextString || '',
          { enableSearch: true, provider: selectedProvider }
        );
        searchResults = search.results || [];
        citations = search.citations || [];
      }
    }

    const assembled = assembleContext({
      audience,
      resume: pinned.resume,
      jobDescription: pinned.jobDescription,
      durableNotes: pinned.durableNotes,
      memorySummary: pinned.memorySummary,
      selectedInterviewSessions: pinned.selectedInterviewSessions,
      transcript: payload.transcriptContext || '',
      contextString: payload.contextString || '',
      searchResults,
      includeSearch: searchResults.length > 0,
      enabledScreenshotIds: payload.enabledScreenshotIds || [],
      charBudget: payload.charBudget
    });

    return {
      assembled,
      citations,
      searchResults,
      useNativeGeminiGrounding,
      searchEnabled: enableSearch && searchService.isGlobalEnabled(),
      contextMetadata
    };
  }

  // ── Documents ────────────────────────────────────────────────────────────
  ipcMain.handle('documents-get', () => ({
    success: true,
    documents: documentService.getDocuments()
  }));

  ipcMain.handle('documents-pick-file', async (event) => {
    try {
      const parentWindow = BrowserWindow.fromWebContents(event.sender);
      const result = await dialog.showOpenDialog(parentWindow || undefined, {
        title: 'Select document',
        properties: ['openFile'],
        filters: DOCUMENT_FILE_FILTERS
      });

      if (result.canceled || !Array.isArray(result.filePaths) || result.filePaths.length === 0) {
        return { success: true, canceled: true };
      }

      return {
        success: true,
        canceled: false,
        filePath: result.filePaths[0]
      };
    } catch (error) {
      return { success: false, error: error.message };
    }
  });

  ipcMain.handle('documents-ingest-file', async (_event, payload = {}) => {
    try {
      const result = await documentService.ingestFile(payload.kind, payload.filePath, {
        enabled: payload.enabled !== false
      });
      return { success: true, ...result };
    } catch (error) {
      return { success: false, error: error.message };
    }
  });

  ipcMain.handle('documents-ingest-paste', async (_event, payload = {}) => {
    try {
      const result = await documentService.ingestPaste(payload.kind, payload.text, {
        enabled: payload.enabled !== false,
        name: payload.name
      });
      return { success: true, ...result };
    } catch (error) {
      return { success: false, error: error.message };
    }
  });

  ipcMain.handle('documents-set-enabled', async (_event, payload = {}) => {
    try {
      const result = await documentService.setEnabled(payload.kind, payload.enabled !== false);
      return { success: true, ...result };
    } catch (error) {
      return { success: false, error: error.message };
    }
  });

  ipcMain.handle('documents-clear', async (_event, payload = {}) => {
    try {
      const result = await documentService.clear(payload?.kind || null);
      return { success: true, ...result };
    } catch (error) {
      return { success: false, error: error.message };
    }
  });

  // ── Memory ───────────────────────────────────────────────────────────────
  ipcMain.handle('memory-get-summary', () => ({
    success: true,
    summary: memoryService.getSummary(),
    status: memoryService.getStatus()
  }));

  ipcMain.handle('memory-get-review-queue', () => ({
    success: true,
    queue: memoryService.getReviewQueue(),
    durableNotes: memoryService.getDurableNotes()
  }));

  ipcMain.handle('memory-trigger-update', async (_event, payload = {}) => {
    syncRuntimeCredentials();
    const result = memoryService.triggerUpdate(payload);
    return { success: true, ...result };
  });

  ipcMain.handle('memory-flush', async () => {
    await syncRuntimeCredentials();
    const summary = await memoryService.flush();
    return {
      success: true,
      summary,
      status: memoryService.getStatus(),
      queue: memoryService.getReviewQueue()
    };
  });

  ipcMain.handle('memory-review-note', async (_event, payload = {}) => {
    try {
      const result = await memoryService.reviewNote(payload.action, payload);
      return { success: true, ...result };
    } catch (error) {
      return { success: false, error: error.message };
    }
  });

  ipcMain.handle('memory-clear-session', async () => {
    const summary = await memoryService.clearSessionMemory();
    const updated = saveAppState(app, { sessionMemory: null });
    setAppState(updated);
    return { success: true, summary };
  });

  ipcMain.handle('memory-clear-durable', async () => {
    const notes = await memoryService.clearDurableNotes();
    memoryService.clearReviewQueue();
    return { success: true, durableNotes: notes };
  });

  // ── Previous interview archives ───────────────────────────────────────────
  function interviewSessionsResponse(state = getAppState()) {
    return {
      success: true,
      sessions: listInterviewSessions(state),
      selectedIds: Array.isArray(state?.selectedInterviewSessionIds)
        ? state.selectedInterviewSessionIds.slice()
        : []
    };
  }

  async function persistInterviewSessionMutation(reason, mutate) {
    const invalidation = cacheManager.invalidate(reason);
    const next = mutate(getAppState() || {});
    const updated = saveAppState(app, {
      interviewSessions: next.interviewSessions,
      selectedInterviewSessionIds: next.selectedInterviewSessionIds
    });
    setAppState(updated);
    await invalidation;
    return interviewSessionsResponse(updated);
  }

  ipcMain.handle('interview-sessions-list', () => (
    interviewSessionsResponse()
  ));

  ipcMain.handle('interview-sessions-set-selected', async (_event, payload = {}) => {
    try {
      const ids = Array.isArray(payload)
        ? payload
        : Array.isArray(payload?.ids)
          ? payload.ids
          : [];
      return await persistInterviewSessionMutation(
        'interview-session-selection-changed',
        (state) => selectInterviewSessions(state, ids)
      );
    } catch (error) {
      return { success: false, error: error.message };
    }
  });

  ipcMain.handle('interview-sessions-delete', async (_event, payload = {}) => {
    try {
      const id = typeof payload === 'string' ? payload : payload?.id;
      return await persistInterviewSessionMutation(
        'interview-session-deleted',
        (state) => deleteInterviewSession(state, id)
      );
    } catch (error) {
      return { success: false, error: error.message };
    }
  });

  ipcMain.handle('interview-sessions-clear', async () => {
    try {
      return await persistInterviewSessionMutation(
        'interview-sessions-cleared',
        (state) => clearInterviewSessions(state)
      );
    } catch (error) {
      return { success: false, error: error.message };
    }
  });

  // ── Search / cache settings helpers ──────────────────────────────────────
  ipcMain.handle('search-get-status', () => {
    syncRuntimeCredentials();
    return {
      success: true,
      enabled: searchService.isGlobalEnabled(),
      provider: searchService.getProvider()
    };
  });

  ipcMain.handle('context-assemble-preview', async (_event, payload = {}) => {
    try {
      const { assembled, citations, contextMetadata } = await buildAssembledContext(
        payload,
        payload.audience || 'desktop'
      );
      return { success: true, assembled, citations, contextMetadata };
    } catch (error) {
      return { success: false, error: error.message };
    }
  });

  ipcMain.handle('clear-scoped-data', async (_event, payload = {}) => {
    const scope = String(payload?.scope || '').trim().toLowerCase();
    try {
      if (scope === 'chat') {
        const geminiService = geminiRuntime?.getService?.();
        geminiService?.clearHistory?.();
        return { success: true, scope };
      }
      if (scope === 'session-memory') {
        await memoryService.clearSessionMemory();
        const updated = saveAppState(app, { sessionMemory: null });
        setAppState(updated);
        return { success: true, scope };
      }
      if (scope === 'documents') {
        await documentService.clear();
        return { success: true, scope };
      }
      if (scope === 'durable-notes') {
        await memoryService.clearDurableNotes();
        memoryService.clearReviewQueue();
        return { success: true, scope };
      }
      return { success: false, error: `Unknown clear scope: ${scope}` };
    } catch (error) {
      return { success: false, error: error.message };
    }
  });

  return {
    documentService,
    cacheManager,
    memoryService,
    backgroundMemoryGenerator,
    searchService,
    syncRuntimeCredentials,
    getDesktopPinnedContext,
    buildAssembledContext,
    maybeSearchForQuery
  };
}

module.exports = {
  registerContextServicesIpc
};
