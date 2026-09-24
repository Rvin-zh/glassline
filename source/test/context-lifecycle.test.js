'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const { registerAssistantIpc } = require('../src/main-process/features/assistant/ipc');
const {
  registerContextServicesIpc
} = require('../src/main-process/features/assistant/context-services-ipc');
const { createAiRuntime } = require('../src/main-process/features/assistant/gemini-runtime');
const { createCacheManager } = require('../src/services/ai/cache-manager');
const { createMemoryService } = require('../src/services/ai/memory-service');
const {
  getDefaultDocumentsState
} = require('../src/services/documents/document-service');
const {
  createInterviewSessionArchive
} = require('../src/services/state/interview-sessions');

const PRIMARY_MODEL = 'gemini-3.8-flash';
const KEY_A = 'context-lifecycle-key-a';
const KEY_B = 'context-lifecycle-key-b';

function createDeferred() {
  let resolve;
  let reject;
  const promise = new Promise((promiseResolve, promiseReject) => {
    resolve = promiseResolve;
    reject = promiseReject;
  });
  return { promise, resolve, reject };
}

function createSummary(currentTopic, proposedDurableNotes = []) {
  return {
    currentTopic,
    questions: [],
    facts: [],
    candidateExamples: [],
    strengthsGaps: [],
    commitments: [],
    proposedDurableNotes
  };
}

function createArchive(topicMarker, noteMarker, archivedAt) {
  return createInterviewSessionArchive({
    summary: createSummary(topicMarker),
    notes: [{
      id: `note-${topicMarker}`,
      text: noteMarker,
      status: 'approved'
    }],
    archivedAt
  });
}

function createRuntime(keys = [KEY_A]) {
  const runtime = createAiRuntime();
  runtime.setActiveAiProvider('gemini');
  runtime.setActiveGeminiModel(PRIMARY_MODEL);
  runtime.setKeys(keys, 0);
  runtime.initializeGeminiService(keys[0], PRIMARY_MODEL, 'Python');
  runtime.getService().adapter.maxRetries = 0;
  runtime.getService().adapter.waitForRateLimit = async () => {};
  return runtime;
}

function installGeminiClient(runtime, requests, { failKey = '' } = {}) {
  const adapter = runtime.getService().adapter;
  adapter._initializeClient = function initializeLifecycleClient() {
    const boundKey = this.apiKey;
    this.client = {
      models: {
        async *generateContentStream(request) {
          requests.push({ key: boundKey, request });
          if (boundKey === failKey) {
            throw Object.assign(new Error('quota exhausted'), { status: 429 });
          }
          yield { text: `response from ${boundKey}` };
        }
      }
    };
  };
  adapter._initializeClient();
}

function createIpcHarness({
  keys = [KEY_A],
  promptCacheEnabled = false,
  documents = getDefaultDocumentsState(),
  sessionMemory = createSummary('SESSION_MEMORY_MARKER'),
  durableNotes = [{
    id: 'durable-existing',
    text: 'DURABLE_NOTE_MARKER',
    status: 'approved'
  }],
  interviewSessions = [],
  selectedInterviewSessionIds = []
} = {}) {
  const runtime = createRuntime(keys);
  const contextHandlers = new Map();
  const assistantHandlers = new Map();
  let appState = {
    geminiApiKey: keys.join(','),
    promptCacheEnabled,
    webSearchEnabled: false,
    webSearchProvider: 'gemini-grounding',
    tavilyApiKey: '',
    documents,
    sessionMemory,
    durableNotes,
    interviewSessions,
    selectedInterviewSessionIds
  };

  const contextServices = registerContextServicesIpc({
    ipcMain: {
      handle(channel, handler) {
        contextHandlers.set(channel, handler);
      }
    },
    app: {},
    getAppState: () => appState,
    setAppState(nextState) {
      appState = nextState;
    },
    saveAppState(_app, patch) {
      appState = { ...appState, ...patch };
      return appState;
    },
    geminiRuntime: runtime,
    sendToRenderer() {}
  });

  // Foreground request tests must not schedule the background memory provider.
  contextServices.memoryService.triggerUpdate = () => ({ queued: true });

  registerAssistantIpc({
    ipcMain: {
      handle(channel, handler) {
        assistantHandlers.set(channel, handler);
      }
    },
    screenshotManager: {
      getScreenshotsCount: () => 0,
      hasScreenshots: () => false,
      async buildImagePartsFromScreenshots() {
        return { imageParts: [] };
      },
      clearStealth() {}
    },
    windowController: {
      getWindowBounds: () => ({}),
      setWindowBounds() {},
      setWindowSizePreset() {},
      toggleStealthMode() {},
      emergencyHide() {}
    },
    geminiRuntime: runtime,
    assemblyAiService: {
      flushAllSttHistoryBuffers() {},
      resetSttHistoryBuffers() {}
    },
    sendToRenderer() {},
    quitApplication() {},
    getContextServices: () => contextServices
  });

  return {
    runtime,
    contextServices,
    contextHandlers,
    assistantHandlers,
    getAppState: () => appState,
    setAppState(nextState) {
      appState = nextState;
    }
  };
}

function getRequestPrompt(request) {
  if (typeof request?.contents === 'string') {
    return request.contents;
  }
  if (!Array.isArray(request?.contents)) {
    return '';
  }
  return request.contents
    .map((part) => (typeof part?.text === 'string' ? part.text : ''))
    .join('\n');
}

async function queueAskBehindBlocker(harness) {
  const blockerStarted = createDeferred();
  const releaseBlocker = createDeferred();
  const contextCaptured = createDeferred();
  let preparedContext = null;
  const originalBuild = harness.contextServices.buildAssembledContext;

  harness.contextServices.buildAssembledContext = async (...args) => {
    preparedContext = await originalBuild(...args);
    contextCaptured.resolve();
    return preparedContext;
  };

  const blocker = harness.runtime.executeWithKeyFailover(async () => {
    blockerStarted.resolve();
    await releaseBlocker.promise;
    return 'blocker complete';
  });
  await blockerStarted.promise;

  const request = harness.assistantHandlers.get('ask-ai-with-session-context')(
    null,
    {
      contextString: 'LIVE_CONTEXT',
      transcriptContext: 'TRANSCRIPT_CONTEXT'
    }
  );
  await contextCaptured.promise;

  return {
    preparedContext,
    async release() {
      releaseBlocker.resolve();
      await blocker;
      return request;
    }
  };
}

describe('memory and durable-note context generation', () => {
  for (const mutation of [
    {
      name: 'dedicated session-memory clear',
      contextField: 'memorySummary',
      marker: 'SESSION_MEMORY_MARKER',
      invoke(harness) {
        return harness.contextHandlers.get('memory-clear-session')();
      }
    },
    {
      name: 'legacy dedicated session-memory clear',
      contextField: 'memorySummary',
      marker: 'SESSION_MEMORY_MARKER',
      invoke(harness) {
        return harness.assistantHandlers.get('clear-session-memory')();
      }
    },
    {
      name: 'scoped session-memory clear',
      contextField: 'memorySummary',
      marker: 'SESSION_MEMORY_MARKER',
      invoke(harness) {
        return harness.contextHandlers.get('clear-scoped-data')(
          null,
          { scope: 'session-memory' }
        );
      }
    },
    {
      name: 'dedicated durable-note clear',
      contextField: 'durableNotes',
      marker: 'DURABLE_NOTE_MARKER',
      invoke(harness) {
        return harness.contextHandlers.get('memory-clear-durable')();
      }
    },
    {
      name: 'legacy dedicated durable-note clear',
      contextField: 'durableNotes',
      marker: 'DURABLE_NOTE_MARKER',
      invoke(harness) {
        return harness.assistantHandlers.get('clear-durable-notes')();
      }
    },
    {
      name: 'scoped durable-note clear',
      contextField: 'durableNotes',
      marker: 'DURABLE_NOTE_MARKER',
      invoke(harness) {
        return harness.contextHandlers.get('clear-scoped-data')(
          null,
          { scope: 'durable-notes' }
        );
      }
    }
  ]) {
    it(`cancels a queued request after ${mutation.name}`, async () => {
      const harness = createIpcHarness();
      const providerRequests = [];
      installGeminiClient(harness.runtime, providerRequests);
      const queued = await queueAskBehindBlocker(harness);
      const capturedValue = queued.preparedContext.assembled[mutation.contextField];

      assert.equal(JSON.stringify(capturedValue).includes(mutation.marker), true);
      const mutationResult = await mutation.invoke(harness);
      assert.equal(mutationResult.success, true);

      const result = await queued.release();
      assert.equal(result.success, false);
      assert.equal(result.code, 'AI_CONTEXT_CHANGED');
      assert.equal(result.retryable, true);
      assert.equal(result.cancelled, true);
      assert.deepEqual(providerRequests, []);
    });
  }

  it('invalidates a captured generation before publishing a background summary update', async () => {
    const responseStarted = createDeferred();
    const response = createDeferred();
    const cacheManager = createCacheManager({ enabled: false });
    const capturedGeneration = cacheManager.getGeneration();
    let generationAtPublish = null;
    let publishedSummary = null;

    const memoryService = createMemoryService({
      initialSummary: createSummary('old topic'),
      debounceMs: 60_000,
      async generateText() {
        responseStarted.resolve();
        return response.promise;
      },
      onBeforeSummaryChange(reason) {
        return cacheManager.invalidate(reason);
      },
      onSummaryUpdated(summary) {
        generationAtPublish = cacheManager.getGeneration();
        publishedSummary = summary;
      }
    });

    memoryService.triggerUpdate({ transcript: 'new transcript' });
    const flush = memoryService.flush();
    await responseStarted.promise;
    response.resolve(JSON.stringify(createSummary('new topic')));
    await flush;

    assert.equal(cacheManager.isGenerationCurrent(capturedGeneration), false);
    assert.ok(generationAtPublish > capturedGeneration);
    assert.equal(publishedSummary.currentTopic, 'new topic');
  });

  for (const review of [
    {
      action: 'approve',
      payload: {},
      expectedText: 'suggested durable note',
      expectedReason: 'durable-notes-approved'
    },
    {
      action: 'edit',
      payload: { text: 'edited durable note' },
      expectedText: 'edited durable note',
      expectedReason: 'durable-notes-edited'
    }
  ]) {
    it(`invalidates durable-note context before ${review.action} persistence`, async () => {
      const events = [];
      let memoryService;
      memoryService = createMemoryService({
        initialSummary: createSummary('topic'),
        initialDurableNotes: [],
        loadDurableNotes: () => [{
          id: 'durable-existing',
          text: 'old durable note',
          status: 'approved'
        }],
        debounceMs: 60_000,
        generateText: async () => JSON.stringify(
          createSummary('topic', [{
            id: 'durable-existing',
            text: 'suggested durable note'
          }])
        ),
        onBeforeDurableNotesChange(reason) {
          events.push({
            type: 'invalidate',
            reason,
            durableNotes: memoryService.getDurableNotes()
          });
        },
        async persistDurableNotes(notes) {
          events.push({
            type: 'persist',
            notes,
            durableNotes: memoryService.getDurableNotes()
          });
        }
      });

      memoryService.triggerUpdate({ transcript: 'proposal source' });
      await memoryService.flush();
      const pending = memoryService.getReviewQueue()[0];
      await memoryService.reviewNote(review.action, {
        id: pending.id,
        ...review.payload
      });

      assert.equal(events[0].type, 'invalidate');
      assert.equal(events[0].reason, review.expectedReason);
      assert.equal(events[0].durableNotes[0].text, 'old durable note');
      assert.equal(events[1].type, 'persist');
      assert.equal(events[1].notes[0].text, review.expectedText);
      assert.equal(events[1].durableNotes[0].text, review.expectedText);
    });
  }

  it('invalidates durable-note context before clear persistence', async () => {
    const events = [];
    let memoryService;
    memoryService = createMemoryService({
      loadDurableNotes: () => [{
        id: 'durable-existing',
        text: 'old durable note',
        status: 'approved'
      }],
      onBeforeDurableNotesChange(reason) {
        events.push({
          type: 'invalidate',
          reason,
          durableNotes: memoryService.getDurableNotes()
        });
      },
      async persistDurableNotes(notes) {
        events.push({
          type: 'persist',
          notes,
          durableNotes: memoryService.getDurableNotes()
        });
      }
    });

    await memoryService.clearDurableNotes();

    assert.equal(events[0].type, 'invalidate');
    assert.equal(events[0].reason, 'durable-notes-cleared');
    assert.equal(events[0].durableNotes[0].text, 'old durable note');
    assert.equal(events[1].type, 'persist');
    assert.deepEqual(events[1].notes, []);
    assert.deepEqual(events[1].durableNotes, []);
  });
});

describe('selected interview archive context generation', () => {
  it('lists archive metadata and applies multi-selection through IPC', async () => {
    const first = createArchive(
      'FIRST_LISTED_TOPIC',
      'FIRST_LISTED_NOTE',
      '2026-09-09T20:00:00.000Z'
    );
    const second = createArchive(
      'SECOND_LISTED_TOPIC',
      'SECOND_LISTED_NOTE',
      '2026-09-08T20:00:00.000Z'
    );
    const harness = createIpcHarness({
      interviewSessions: [first, second],
      selectedInterviewSessionIds: []
    });

    const initial = harness.contextHandlers.get('interview-sessions-list')();
    assert.deepEqual(initial.selectedIds, []);
    assert.deepEqual(
      initial.sessions.map(({ id, noteCount, selected }) => ({
        id,
        noteCount,
        selected
      })),
      [
        { id: first.id, noteCount: 1, selected: false },
        { id: second.id, noteCount: 1, selected: false }
      ]
    );

    const updated = await harness.contextHandlers.get(
      'interview-sessions-set-selected'
    )(null, {
      ids: [second.id, first.id, second.id, 'unknown']
    });
    assert.equal(updated.success, true);
    assert.deepEqual(updated.selectedIds, [second.id, first.id]);
    assert.deepEqual(
      updated.sessions.map(({ id, selected }) => ({ id, selected })),
      [
        { id: first.id, selected: true },
        { id: second.id, selected: true }
      ]
    );
    assert.deepEqual(
      harness.getAppState().selectedInterviewSessionIds,
      [second.id, first.id]
    );
  });

  it('sends only selected archives to desktop prompts and none to mobile context', async () => {
    const selected = createArchive(
      'SELECTED_INTERVIEW_TOPIC',
      'SELECTED_INTERVIEW_NOTE',
      '2026-09-09T20:00:00.000Z'
    );
    const unselected = createArchive(
      'UNSELECTED_INTERVIEW_TOPIC',
      'UNSELECTED_INTERVIEW_NOTE',
      '2026-09-08T20:00:00.000Z'
    );
    const harness = createIpcHarness({
      interviewSessions: [selected, unselected],
      selectedInterviewSessionIds: [selected.id]
    });
    const providerRequests = [];
    installGeminiClient(harness.runtime, providerRequests);

    const desktop = await harness.contextServices.buildAssembledContext({
      transcriptContext: 'Current desktop transcript'
    }, 'desktop');
    assert.match(desktop.assembled.memorySummary, /SESSION_MEMORY_MARKER/);
    assert.doesNotMatch(desktop.assembled.memorySummary, /SELECTED_INTERVIEW/);
    assert.match(desktop.assembled.previousInterviewContext, /SELECTED_INTERVIEW_TOPIC/);
    assert.match(desktop.assembled.previousInterviewContext, /SELECTED_INTERVIEW_NOTE/);
    assert.doesNotMatch(desktop.assembled.previousInterviewContext, /UNSELECTED_INTERVIEW/);

    const response = await harness.assistantHandlers.get('ask-ai-with-session-context')(
      null,
      { transcriptContext: 'Current desktop transcript' }
    );
    assert.equal(response.success, true);
    assert.equal(providerRequests.length, 1);
    const prompt = getRequestPrompt(providerRequests[0].request);
    assert.match(prompt, /SELECTED_INTERVIEW_TOPIC/);
    assert.match(prompt, /SELECTED_INTERVIEW_NOTE/);
    assert.doesNotMatch(prompt, /UNSELECTED_INTERVIEW_TOPIC/);
    assert.doesNotMatch(prompt, /UNSELECTED_INTERVIEW_NOTE/);

    const mobile = await harness.contextServices.buildAssembledContext({
      transcriptContext: 'Safe mobile transcript'
    }, 'mobile');
    const serializedMobile = JSON.stringify(mobile);
    assert.equal(serializedMobile.includes('SELECTED_INTERVIEW'), false);
    assert.equal(serializedMobile.includes('UNSELECTED_INTERVIEW'), false);
    assert.deepEqual(mobile.assembled.promptDurableNotes, []);
    assert.equal(mobile.assembled.previousInterviewContext, '');
  });

  for (const mutation of [
    {
      name: 'selection change',
      invoke(harness) {
        return harness.contextHandlers.get('interview-sessions-set-selected')(
          null,
          { ids: [] }
        );
      }
    },
    {
      name: 'archive delete',
      invoke(harness, archive) {
        return harness.contextHandlers.get('interview-sessions-delete')(
          null,
          { id: archive.id }
        );
      }
    },
    {
      name: 'archive clear',
      invoke(harness) {
        return harness.contextHandlers.get('interview-sessions-clear')();
      }
    }
  ]) {
    it(`cancels a queued request after ${mutation.name}`, async () => {
      const archive = createArchive(
        'QUEUED_ARCHIVE_TOPIC',
        'QUEUED_ARCHIVE_NOTE',
        '2026-09-09T20:00:00.000Z'
      );
      const harness = createIpcHarness({
        interviewSessions: [archive],
        selectedInterviewSessionIds: [archive.id]
      });
      const providerRequests = [];
      installGeminiClient(harness.runtime, providerRequests);
      const queued = await queueAskBehindBlocker(harness);

      assert.match(
        queued.preparedContext.assembled.previousInterviewContext,
        /QUEUED_ARCHIVE_TOPIC/
      );
      const mutationResult = await mutation.invoke(harness, archive);
      assert.equal(mutationResult.success, true);

      const result = await queued.release();
      assert.equal(result.success, false);
      assert.equal(result.code, 'AI_CONTEXT_CHANGED');
      assert.equal(result.retryable, true);
      assert.equal(result.cancelled, true);
      assert.deepEqual(providerRequests, []);
    });
  }
});

describe('credential synchronization context boundary', () => {
  it('uses a fresh generation and exact key cache on the request after automatic key rotation', async () => {
    const documents = getDefaultDocumentsState();
    documents.resume = {
      text: `ROTATION_RESUME_${'R'.repeat(9000)}`,
      enabled: true,
      source: null,
      hash: null,
      updatedAt: null
    };
    const harness = createIpcHarness({
      keys: [KEY_A, KEY_B],
      promptCacheEnabled: true,
      documents
    });
    const providerRequests = [];
    const cacheAcquisitions = [];
    const keySyncs = [];
    const cacheManager = harness.contextServices.cacheManager;
    const originalSetApiKey = cacheManager.setApiKey;

    cacheManager.setApiKey = (apiKey) => {
      const beforeGeneration = cacheManager.getGeneration();
      const sync = originalSetApiKey(apiKey);
      keySyncs.push({
        apiKey,
        beforeGeneration,
        afterGeneration: cacheManager.getGeneration()
      });
      return sync;
    };
    cacheManager.acquireCache = async (params) => {
      const metadata = cacheManager.buildFingerprint(params);
      cacheAcquisitions.push({
        apiKey: params.apiKey,
        expectedGeneration: params.expectedGeneration
      });
      return {
        used: true,
        cacheName: `cachedContents/${params.apiKey}`,
        model: params.model,
        fingerprint: metadata.fingerprint,
        prefix: metadata.prefix,
        async release() {}
      };
    };

    installGeminiClient(harness.runtime, providerRequests, { failKey: KEY_A });

    const first = await harness.assistantHandlers.get('ask-ai-with-session-context')(
      null,
      { transcriptContext: 'rotate to the next key' }
    );
    assert.equal(first.success, true);
    assert.equal(harness.runtime.getActiveApiKey(), KEY_B);

    const second = await harness.assistantHandlers.get('ask-ai-with-session-context')(
      null,
      { transcriptContext: 'use the rotated key cache' }
    );

    assert.equal(second.success, true);
    assert.deepEqual(
      providerRequests.map(({ key, request }) => ({
        key,
        cache: request.config.cachedContent
      })),
      [
        { key: KEY_A, cache: `cachedContents/${KEY_A}` },
        { key: KEY_B, cache: `cachedContents/${KEY_B}` },
        { key: KEY_B, cache: `cachedContents/${KEY_B}` }
      ]
    );
    assert.deepEqual(
      cacheAcquisitions.map(({ apiKey }) => apiKey),
      [KEY_A, KEY_B, KEY_B]
    );
    assert.equal(cacheAcquisitions[0].expectedGeneration, cacheAcquisitions[1].expectedGeneration);
    assert.ok(
      cacheAcquisitions[2].expectedGeneration >
      cacheAcquisitions[1].expectedGeneration
    );
    const rotatedSync = keySyncs.find((entry) => (
      entry.apiKey === KEY_B &&
      entry.afterGeneration > entry.beforeGeneration
    ));
    assert.ok(rotatedSync);
    assert.equal(
      harness.contextServices.cacheManager.isGenerationCurrent(
        cacheAcquisitions[2].expectedGeneration
      ),
      true
    );
  });

  it('awaits credential sync before atomically capturing generation and pinned context', async () => {
    const documents = getDefaultDocumentsState();
    documents.resume = {
      text: 'OLD_RESUME',
      enabled: true,
      source: null,
      hash: null,
      updatedAt: null
    };
    const harness = createIpcHarness({
      keys: [KEY_A, KEY_B],
      promptCacheEnabled: true,
      documents
    });
    const cacheManager = harness.contextServices.cacheManager;
    const originalSetApiKey = cacheManager.setApiKey;
    const syncStarted = createDeferred();
    const releaseSync = createDeferred();
    let delayedFirstRotatedSync = false;

    cacheManager.setApiKey = (apiKey) => {
      const sync = originalSetApiKey(apiKey);
      if (apiKey === KEY_B && !delayedFirstRotatedSync) {
        delayedFirstRotatedSync = true;
        syncStarted.resolve();
        return Promise.all([sync, releaseSync.promise]);
      }
      return sync;
    };

    harness.runtime.switchToNextKey();
    let buildSettled = false;
    const buildPromise = harness.contextServices
      .buildAssembledContext({ transcriptContext: 'question' }, 'desktop')
      .then((value) => {
        buildSettled = true;
        return value;
      });

    await syncStarted.promise;
    const concurrentSync = harness.contextServices.syncRuntimeCredentials();
    harness.setAppState({
      ...harness.getAppState(),
      documents: {
        ...harness.getAppState().documents,
        resume: {
          ...harness.getAppState().documents.resume,
          text: 'NEW_RESUME'
        }
      }
    });
    await Promise.resolve();
    await Promise.resolve();

    assert.equal(buildSettled, false);
    releaseSync.resolve();
    await concurrentSync;
    const prepared = await buildPromise;

    assert.equal(prepared.assembled.resume, 'NEW_RESUME');
    assert.equal(
      cacheManager.isGenerationCurrent(prepared.contextMetadata.generation),
      true
    );
  });
});
