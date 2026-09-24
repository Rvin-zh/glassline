'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const { registerAssistantIpc } = require('../src/main-process/features/assistant/ipc');
const { createAiRuntime } = require('../src/main-process/features/assistant/gemini-runtime');
const { createCacheManager } = require('../src/services/ai/cache-manager');
const {
  createDocumentService,
  getDefaultDocumentsState
} = require('../src/services/documents/document-service');

const PRIMARY_MODEL = 'gemini-3.8-flash';
const FALLBACK_MODEL = 'gemini-3.7-flash';
const LONG_RESUME = `CACHE_BINDING_RESUME_MARKER_${'R'.repeat(9000)}`;
const LONG_JOB_DESCRIPTION = `CACHE_BINDING_JOB_MARKER_${'J'.repeat(9000)}`;

function createDeferred() {
  let resolve;
  let reject;
  const promise = new Promise((promiseResolve, promiseReject) => {
    resolve = promiseResolve;
    reject = promiseReject;
  });
  return { promise, resolve, reject };
}

function createGeminiRuntime(model = PRIMARY_MODEL) {
  const runtime = createAiRuntime();
  runtime.setActiveAiProvider('gemini');
  runtime.setActiveGeminiModel(model);
  runtime.setKeys(['test-gemini-key'], 0);
  runtime.initializeGeminiService('test-gemini-key', model, 'Python');
  return runtime;
}

function createAssembledContext() {
  return {
    contextString: 'LIVE_CONTEXT_MARKER',
    transcriptContext: 'TRANSCRIPT_CONTEXT_MARKER',
    resume: LONG_RESUME,
    jobDescription: LONG_JOB_DESCRIPTION,
    memorySummary: '',
    durableNotes: [],
    searchResults: [],
    enabledScreenshotIds: []
  };
}

function registerHarness({
  runtime,
  cacheManager,
  assembled = createAssembledContext(),
  imageParts = [],
  syncRuntimeCredentials = () => {},
  buildAssembledContext
}) {
  const handlers = new Map();
  const events = [];
  const contextServices = {
    cacheManager,
    syncRuntimeCredentials,
    async buildAssembledContext(payload, audience) {
      if (typeof buildAssembledContext === 'function') {
        return buildAssembledContext(payload, audience);
      }
      const generation = cacheManager?.getGeneration?.();
      return {
        assembled,
        citations: [],
        useNativeGeminiGrounding: false,
        searchEnabled: false,
        contextMetadata: Number.isSafeInteger(generation)
          ? { generation }
          : undefined
      };
    },
    memoryService: {
      triggerUpdate() {}
    },
    documentService: {
      async clear() {
        await cacheManager?.invalidate?.('documents-cleared');
      }
    }
  };

  registerAssistantIpc({
    ipcMain: {
      handle(channel, handler) {
        handlers.set(channel, handler);
      }
    },
    screenshotManager: {
      getScreenshotsCount: () => imageParts.length,
      hasScreenshots: () => imageParts.length > 0,
      async buildImagePartsFromScreenshots() {
        return { imageParts };
      },
      clearStealth() {}
    },
    windowController: {
      getWindowBounds() {
        return {};
      },
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
    sendToRenderer(channel, payload) {
      events.push({ channel, payload });
    },
    quitApplication() {},
    getContextServices: () => contextServices
  });

  return { handlers, events };
}

function installGeminiClient(runtime, requests) {
  const adapter = runtime.getService().adapter;
  adapter.maxRetries = 0;
  adapter.waitForRateLimit = async () => {};
  adapter.client = {
    models: {
      async *generateContentStream(request) {
        requests.push(request);
        yield { text: 'streamed response' };
      }
    }
  };
}

function getGeminiPrompt(request) {
  if (typeof request.contents === 'string') {
    return request.contents;
  }
  if (Array.isArray(request.contents)) {
    return request.contents
      .map((part) => (typeof part?.text === 'string' ? part.text : ''))
      .join('\n');
  }
  return '';
}

function createMetadataCacheManager(onEnsure, generation = 8675309) {
  const fingerprintHelper = createCacheManager({ minCacheTokens: 0 });
  async function acquire(params) {
    if (typeof onEnsure === 'function') {
      await onEnsure(params);
    }
    const metadata = fingerprintHelper.buildFingerprint(params);
    return {
      used: true,
      cacheName: `cachedContents/${params.model}`,
      model: params.model,
      fingerprint: metadata.fingerprint,
      prefix: metadata.prefix,
      async release() {}
    };
  }

  return {
    buildFingerprint: fingerprintHelper.buildFingerprint,
    acquireCache: acquire,
    ensureCache: acquire,
    getGeneration: () => generation,
    isGenerationCurrent: (expectedGeneration) => expectedGeneration === generation
  };
}

describe('document generation boundary', () => {
  for (const mutation of [
    {
      name: 'clear',
      expectedReason: 'documents-cleared',
      run(service) {
        return service.clear();
      }
    },
    {
      name: 'change',
      expectedReason: 'documents-changed',
      run(service) {
        return service.ingestPaste('resume', 'replacement resume');
      }
    }
  ]) {
    it(`advances generation synchronously before a document ${mutation.name} becomes visible`, async () => {
      const manager = createCacheManager();
      const originalGeneration = manager.getGeneration();
      const saveFinished = createDeferred();
      const invalidationReasons = [];
      let generationWasStaleAtSave = false;
      let documents = {
        ...getDefaultDocumentsState(),
        resume: {
          text: 'old resume',
          enabled: true,
          source: null,
          hash: null,
          updatedAt: null
        }
      };
      const service = createDocumentService({
        getDocuments: () => documents,
        onBeforeDocumentsChange(reason) {
          invalidationReasons.push(reason);
          return manager.invalidate(reason);
        },
        saveDocuments(nextDocuments) {
          generationWasStaleAtSave =
            !manager.isGenerationCurrent(originalGeneration);
          documents = nextDocuments;
          return saveFinished.promise.then(() => nextDocuments);
        }
      });

      const mutationPromise = mutation.run(service);
      saveFinished.resolve();
      await mutationPromise;

      assert.equal(generationWasStaleAtSave, true);
      assert.deepEqual(invalidationReasons, [mutation.expectedReason]);
      assert.equal(manager.isGenerationCurrent(originalGeneration), false);
    });
  }
});

describe('assistant cache binding', () => {
  for (const flow of [
    {
      name: 'text',
      imageParts: [],
      async invoke(handlers) {
        const result = await handlers.get('ask-ai-with-session-context')(null, {
          contextString: 'LIVE_CONTEXT_MARKER',
          transcriptContext: 'TRANSCRIPT_CONTEXT_MARKER'
        });
        assert.equal(result.success, true);
      }
    },
    {
      name: 'screen multimodal',
      imageParts: [
        {
          inlineData: {
            mimeType: 'image/png',
            data: 'aW1hZ2U='
          }
        }
      ],
      async invoke(handlers) {
        await handlers.get('analyze-stealth-with-context')(null, {
          contextString: 'LIVE_CONTEXT_MARKER',
          transcriptContext: 'TRANSCRIPT_CONTEXT_MARKER'
        });
      }
    }
  ]) {
    it(`acquires and uses matching direct Gemini cache inside serialized ${flow.name} execution`, async () => {
      const runtime = createGeminiRuntime();
      const requests = [];
      const ensureCalls = [];
      let operationStarted = false;
      const executeWithKeyFailover = runtime.executeWithKeyFailover.bind(runtime);

      runtime.executeWithKeyFailover = (operation) => executeWithKeyFailover((service, context) => {
        operationStarted = true;
        return operation(service, context);
      });

      const cacheManager = createMetadataCacheManager((params) => {
        ensureCalls.push({
          insideSerializedOperation: operationStarted,
          model: params.model,
          expectedGeneration: params.expectedGeneration
        });
      });

      installGeminiClient(runtime, requests);
      const { handlers } = registerHarness({
        runtime,
        cacheManager,
        imageParts: flow.imageParts
      });

      await flow.invoke(handlers);

      assert.deepEqual(ensureCalls, [
        {
          insideSerializedOperation: true,
          model: PRIMARY_MODEL,
          expectedGeneration: 8675309
        }
      ]);
      assert.equal(requests.length, 1);
      assert.equal(requests[0].model, PRIMARY_MODEL);
      assert.equal(requests[0].config.cachedContent, `cachedContents/${PRIMARY_MODEL}`);
      const prompt = getGeminiPrompt(requests[0]);
      assert.equal(prompt.includes('You are Invisibrain'), false);
      assert.equal(prompt.includes('CACHE_BINDING_RESUME_MARKER'), false);
      assert.equal(prompt.includes('CACHE_BINDING_JOB_MARKER'), false);
      assert.equal(prompt.includes('8675309'), false);
      assert.equal(
        JSON.stringify(runtime.getLastExecutionDiagnostics()).includes('8675309'),
        false
      );
    });
  }

  it('cancels a queued context after documents are cleared without creating a cache or sending it', async () => {
    const runtime = createGeminiRuntime();
    const providerRequests = [];
    const cacheCreates = [];
    const blockerStarted = createDeferred();
    const releaseBlocker = createDeferred();
    const contextCaptured = createDeferred();
    const cacheManager = createCacheManager({
      minCacheTokens: 0,
      apiKey: 'test-gemini-key',
      client: {
        caches: {
          async create() {
            cacheCreates.push('created');
            return {
              name: 'cachedContents/queued-old-context',
              expireTime: new Date(Date.now() + 60_000).toISOString()
            };
          },
          async delete() {}
        }
      }
    });

    installGeminiClient(runtime, providerRequests);
    const blocker = runtime.executeWithKeyFailover(async () => {
      blockerStarted.resolve();
      await releaseBlocker.promise;
      return 'blocker complete';
    });
    await blockerStarted.promise;

    const capturedGeneration = cacheManager.getGeneration();
    const { handlers } = registerHarness({
      runtime,
      cacheManager,
      buildAssembledContext: async () => {
        contextCaptured.resolve();
        return {
          assembled: createAssembledContext(),
          citations: [],
          useNativeGeminiGrounding: false,
          searchEnabled: false,
          contextMetadata: { generation: capturedGeneration }
        };
      }
    });

    const requestPromise = handlers.get('ask-ai-with-session-context')(null, {
      contextString: 'LIVE_CONTEXT_MARKER',
      transcriptContext: 'TRANSCRIPT_CONTEXT_MARKER'
    });
    await contextCaptured.promise;
    assert.deepEqual(await handlers.get('clear-documents')(), { success: true });
    releaseBlocker.resolve();
    await blocker;

    const result = await requestPromise;
    assert.equal(result.success, false);
    assert.equal(result.code, 'AI_CONTEXT_CHANGED');
    assert.equal(result.retryable, true);
    assert.equal(result.cancelled, true);
    assert.match(result.error, /context changed/i);
    assert.match(result.error, /retry/i);
    assert.deepEqual(cacheCreates, []);
    assert.deepEqual(providerRequests, []);
    assert.equal(cacheManager.getActiveCache(), null);
    assert.equal(JSON.stringify(result).includes(String(capturedGeneration)), false);
  });

  it('cancels context invalidated while asynchronous search assembly is pending', async () => {
    const runtime = createGeminiRuntime();
    const providerRequests = [];
    const cacheCreates = [];
    const searchStarted = createDeferred();
    const releaseSearch = createDeferred();
    const cacheManager = createCacheManager({
      minCacheTokens: 0,
      apiKey: 'test-gemini-key',
      client: {
        caches: {
          async create() {
            cacheCreates.push('created');
            return {
              name: 'cachedContents/search-race',
              expireTime: new Date(Date.now() + 60_000).toISOString()
            };
          },
          async delete() {}
        }
      }
    });
    installGeminiClient(runtime, providerRequests);

    const { handlers } = registerHarness({
      runtime,
      cacheManager,
      buildAssembledContext: async () => {
        const generation = cacheManager.getGeneration();
        const pinnedSnapshot = createAssembledContext();
        searchStarted.resolve();
        await releaseSearch.promise;
        return {
          assembled: {
            ...pinnedSnapshot,
            searchResults: [{
              title: 'Delayed search result',
              url: 'https://example.invalid',
              snippet: 'result'
            }]
          },
          citations: [],
          useNativeGeminiGrounding: false,
          searchEnabled: true,
          contextMetadata: { generation }
        };
      }
    });

    const requestPromise = handlers.get('ask-ai-with-session-context')(null, {
      contextString: 'LIVE_CONTEXT_MARKER',
      transcriptContext: 'TRANSCRIPT_CONTEXT_MARKER',
      enableSearch: true
    });
    await searchStarted.promise;
    await cacheManager.invalidate('documents-cleared');
    releaseSearch.resolve();

    const result = await requestPromise;
    assert.equal(result.success, false);
    assert.equal(result.code, 'AI_CONTEXT_CHANGED');
    assert.equal(result.retryable, true);
    assert.equal(result.cancelled, true);
    assert.deepEqual(cacheCreates, []);
    assert.deepEqual(providerRequests, []);
    assert.equal(cacheManager.getActiveCache(), null);
  });

  it('rebinds the original Gemini model and key after delayed cache acquisition, then restores newer settings', async () => {
    const runtime = createGeminiRuntime();
    const requests = [];
    const cacheStarted = createDeferred();
    const releaseCache = createDeferred();
    const ensureCalls = [];
    const oldKey = 'gemini-execution-key-a';
    const newKey = 'gemini-settings-key-b';
    runtime.setKeys([oldKey], 0);
    runtime.initializeGeminiService(oldKey, PRIMARY_MODEL, 'Python');

    const adapter = runtime.getService().adapter;
    adapter.maxRetries = 0;
    adapter.waitForRateLimit = async () => {};
    adapter._initializeClient = function initializeTestClient() {
      const boundKey = this.apiKey;
      this.client = {
        models: {
          async *generateContentStream(request) {
            requests.push({ key: boundKey, request });
            yield { text: 'streamed response' };
          }
        }
      };
    };
    adapter._initializeClient();

    const cacheManager = createMetadataCacheManager(async (params) => {
      ensureCalls.push(params);
      cacheStarted.resolve();
      await releaseCache.promise;
    });

    const { handlers } = registerHarness({ runtime, cacheManager });

    const resultPromise = handlers.get('ask-ai-with-session-context')(null, {
      contextString: 'LIVE_CONTEXT_MARKER',
      transcriptContext: 'TRANSCRIPT_CONTEXT_MARKER'
    });
    await cacheStarted.promise;

    runtime.setKeys([newKey], 0);
    runtime.setActiveGeminiModel(FALLBACK_MODEL);
    runtime.initializeGeminiService(newKey, FALLBACK_MODEL, 'JavaScript');
    releaseCache.resolve();

    const result = await resultPromise;
    assert.equal(result.success, true);
    assert.equal(ensureCalls.length, 1);
    assert.equal(ensureCalls[0].model, PRIMARY_MODEL);
    assert.equal(ensureCalls[0].apiKey, oldKey);
    assert.equal(requests.length, 1);
    assert.equal(requests[0].key, oldKey);
    assert.equal(requests[0].request.model, PRIMARY_MODEL);
    assert.equal(
      requests[0].request.config.cachedContent,
      `cachedContents/${PRIMARY_MODEL}`
    );
    const prompt = getGeminiPrompt(requests[0].request);
    assert.equal(prompt.includes('You are Invisibrain'), false);
    assert.equal(prompt.includes('CACHE_BINDING_RESUME_MARKER'), false);
    assert.equal(prompt.includes('CACHE_BINDING_JOB_MARKER'), false);
    assert.equal(runtime.getActiveApiKey(), newKey);
    assert.equal(runtime.getActiveGeminiModel(), FALLBACK_MODEL);
    assert.equal(runtime.getService().adapter.apiKey, newKey);
    assert.equal(runtime.getService().modelName, FALLBACK_MODEL);
    assert.equal(runtime.getActiveProgrammingLanguage(), 'JavaScript');
  });

  it('uses the original cache attempt when provider, model, and key settings change during creation', async () => {
    const oldKey = 'gemini-original-provider-key';
    const newKey = 'gemini-new-provider-key';
    const runtime = createGeminiRuntime();
    runtime.setKeys([oldKey], 0);
    runtime.initializeGeminiService(oldKey, PRIMARY_MODEL, 'Python');
    const requests = [];
    installGeminiClient(runtime, requests);
    const cacheStarted = createDeferred();
    const releaseCache = createDeferred();
    const cacheManager = createMetadataCacheManager(async () => {
      cacheStarted.resolve();
      await releaseCache.promise;
    });
    const { handlers } = registerHarness({ runtime, cacheManager });

    const resultPromise = handlers.get('ask-ai-with-session-context')(null, {
      contextString: 'LIVE_CONTEXT_MARKER',
      transcriptContext: 'TRANSCRIPT_CONTEXT_MARKER'
    });
    await cacheStarted.promise;

    runtime.setKeys([newKey], 0);
    runtime.setActiveGeminiModel(FALLBACK_MODEL);
    runtime.setActivePortkeyApiKey('portkey-new-provider-key');
    runtime.setActiveAiProvider('portkey');
    runtime.initializePortkeyService(
      'portkey-new-provider-key',
      FALLBACK_MODEL,
      'JavaScript',
      {
        provider: '@e2e',
        baseUrl: 'http://127.0.0.1:41234/v1'
      }
    );
    releaseCache.resolve();

    const result = await resultPromise;
    assert.equal(result.success, true);
    assert.equal(requests.length, 1);
    assert.equal(requests[0].model, PRIMARY_MODEL);
    assert.equal(
      requests[0].config.cachedContent,
      `cachedContents/${PRIMARY_MODEL}`
    );
    assert.equal(runtime.getActiveAiProvider(), 'portkey');
    assert.equal(runtime.getActiveGeminiModel(), FALLBACK_MODEL);
    assert.equal(runtime.getActiveApiKey(), newKey);
    assert.equal(runtime.getService().capabilities.provider, 'portkey');
    assert.equal(runtime.getService().modelName, FALLBACK_MODEL);
  });

  it('omits cache use when returned metadata does not match the execution fingerprint', async () => {
    const runtime = createGeminiRuntime();
    const requests = [];
    const fingerprintHelper = createCacheManager({ minCacheTokens: 0 });
    const cacheManager = {
      buildFingerprint: fingerprintHelper.buildFingerprint,
      async ensureCache(params) {
        return {
          used: true,
          cacheName: 'cachedContents/stale-fingerprint',
          model: params.model,
          fingerprint: 'stale-fingerprint'
        };
      }
    };

    installGeminiClient(runtime, requests);
    const { handlers } = registerHarness({ runtime, cacheManager });
    const result = await handlers.get('ask-ai-with-session-context')(null, {
      contextString: 'LIVE_CONTEXT_MARKER',
      transcriptContext: 'TRANSCRIPT_CONTEXT_MARKER'
    });

    assert.equal(result.success, true);
    assert.equal(requests.length, 1);
    assert.equal(Object.hasOwn(requests[0].config, 'cachedContent'), false);
    const prompt = getGeminiPrompt(requests[0]);
    assert.equal(prompt.includes('You are Invisibrain'), true);
    assert.equal(prompt.includes('CACHE_BINDING_RESUME_MARKER'), true);
    assert.equal(prompt.includes('CACHE_BINDING_JOB_MARKER'), true);
  });

  it('keeps unsupported Portkey providers on the full uncached prompt', async () => {
    const runtime = createAiRuntime();
    runtime.setKeys(['also-configured-gemini-key'], 0);
    runtime.setActiveAiProvider('portkey');
    runtime.setActiveGeminiModel(PRIMARY_MODEL);
    runtime.setActivePortkeyApiKey('pk-test-key');
    runtime.initializePortkeyService('pk-test-key', PRIMARY_MODEL, 'Python', {
      provider: '@openai',
      baseUrl: 'https://portkey.example.invalid'
    });

    const adapter = runtime.getService().adapter;
    const requests = [];
    const snapshots = [];
    const ensureCalls = [];
    const originalCreateRequestSnapshot = adapter._createRequestSnapshot.bind(adapter);
    adapter.maxRetries = 0;
    adapter.waitForRateLimit = async () => {};
    adapter._createRequestSnapshot = (options) => {
      const snapshot = originalCreateRequestSnapshot(options);
      snapshots.push(snapshot);
      return snapshot;
    };
    adapter.client = {
      chat: {
        completions: {
          async create(request) {
            requests.push(request);
            return {
              async *[Symbol.asyncIterator]() {
                yield {
                  choices: [
                    {
                      delta: {
                        content: 'portkey response'
                      }
                    }
                  ]
                };
              }
            };
          }
        }
      }
    };

    const cacheManager = createMetadataCacheManager((params) => {
      ensureCalls.push(params.model);
    });
    const { handlers } = registerHarness({ runtime, cacheManager });
    const result = await handlers.get('ask-ai-with-session-context')(null, {
      contextString: 'LIVE_CONTEXT_MARKER',
      transcriptContext: 'TRANSCRIPT_CONTEXT_MARKER'
    });

    assert.equal(result.success, true);
    assert.deepEqual(ensureCalls, []);
    assert.equal(requests.length, 1);
    assert.equal(snapshots[0].cachedContentName, '');
    const userContent = requests[0].messages.find((message) => message.role === 'user').content;
    const prompt = typeof userContent === 'string'
      ? userContent
      : userContent.map((part) => part.text || '').join('\n');
    assert.equal(prompt.includes('You are Invisibrain'), true);
    assert.equal(prompt.includes('CACHE_BINDING_RESUME_MARKER'), true);
    assert.equal(prompt.includes('CACHE_BINDING_JOB_MARKER'), true);
  });

  it('creates, reuses, and invalidates a Portkey Vertex cache with stripped prefixes', async () => {
    const runtime = createAiRuntime();
    const apiKey = 'portkey-exact-cache-key';
    const provider = '@vertex';
    const baseUrl = 'https://portkey-cache.example.invalid/v1';
    runtime.setActiveAiProvider('portkey');
    runtime.setActiveGeminiModel(PRIMARY_MODEL);
    runtime.setActivePortkeyApiKey(apiKey);
    runtime.initializePortkeyService(apiKey, PRIMARY_MODEL, 'Python', {
      provider,
      baseUrl
    });

    const requests = [];
    const adapter = runtime.getService().adapter;
    adapter.maxRetries = 0;
    adapter.waitForRateLimit = async () => {};
    adapter.client = {
      chat: {
        completions: {
          async create(request) {
            requests.push(request);
            return {
              async *[Symbol.asyncIterator]() {
                yield {
                  choices: [{
                    delta: { content: 'portkey cached response' }
                  }]
                };
              }
            };
          }
        }
      }
    };

    const creates = [];
    const deletes = [];
    const clientContexts = [];
    const cacheName =
      'projects/cache-project/locations/us-central1/cachedContents/cache-1';
    const cacheManager = createCacheManager({
      minCacheTokens: 0,
      createClient(exactApiKey, context) {
        clientContexts.push({
          apiKey: exactApiKey,
          context: { ...context },
          frozen: Object.isFrozen(context)
        });
        return {
          caches: {
            async create({ model, config }) {
              creates.push({ model, config });
              return {
                name: cacheName,
                expireTime: new Date(Date.now() + 60_000).toISOString()
              };
            },
            async delete({ name }) {
              deletes.push(name);
            }
          }
        };
      }
    });
    const { handlers } = registerHarness({ runtime, cacheManager });

    const first = await handlers.get('ask-ai-with-session-context')(null, {
      contextString: 'LIVE_CONTEXT_MARKER',
      transcriptContext: 'TRANSCRIPT_CONTEXT_MARKER'
    });
    const second = await handlers.get('ask-ai-with-session-context')(null, {
      contextString: 'LIVE_CONTEXT_MARKER',
      transcriptContext: 'TRANSCRIPT_CONTEXT_MARKER'
    });

    assert.equal(first.success, true);
    assert.equal(second.success, true);
    assert.equal(creates.length, 1);
    assert.equal(clientContexts.length, 1);
    assert.deepEqual(clientContexts[0], {
      apiKey,
      context: {
        provider,
        cacheNamespace:
          `portkey-vertex-v1|${provider}|${baseUrl}`,
        baseUrl
      },
      frozen: true
    });
    assert.equal(requests.length, 2);
    assert.deepEqual(
      requests.map((request) => request.cached_content),
      [cacheName, cacheName]
    );
    for (const request of requests) {
      const userContent = request.messages.find(
        (message) => message.role === 'user'
      ).content;
      const prompt = typeof userContent === 'string'
        ? userContent
        : userContent.map((part) => part.text || '').join('\n');
      assert.equal(prompt.includes('You are Invisibrain'), false);
      assert.equal(prompt.includes('CACHE_BINDING_RESUME_MARKER'), false);
      assert.equal(prompt.includes('CACHE_BINDING_JOB_MARKER'), false);
      assert.equal(prompt.includes('LIVE_CONTEXT_MARKER'), true);
    }

    await cacheManager.invalidate('documents-changed');
    assert.deepEqual(deletes, [cacheName]);
  });

  it('keeps a short Portkey Vertex prefix uncached and complete', async () => {
    const runtime = createAiRuntime();
    runtime.setActiveAiProvider('portkey');
    runtime.setActiveGeminiModel(PRIMARY_MODEL);
    runtime.setActivePortkeyApiKey('pk-short-prefix');
    runtime.initializePortkeyService(
      'pk-short-prefix',
      PRIMARY_MODEL,
      'Python',
      {
        provider: '@vertex',
        baseUrl: 'https://portkey-short.example.invalid/v1'
      }
    );

    const requests = [];
    const adapter = runtime.getService().adapter;
    adapter.maxRetries = 0;
    adapter.waitForRateLimit = async () => {};
    adapter.client = {
      chat: {
        completions: {
          async create(request) {
            requests.push(request);
            return {
              async *[Symbol.asyncIterator]() {
                yield { choices: [{ delta: { content: 'uncached' } }] };
              }
            };
          }
        }
      }
    };
    let clientCreates = 0;
    const cacheManager = createCacheManager({
      createClient() {
        clientCreates += 1;
        throw new Error('short prefixes must not initialize cache clients');
      }
    });
    const { handlers } = registerHarness({
      runtime,
      cacheManager,
      assembled: {
        ...createAssembledContext(),
        resume: 'short resume',
        jobDescription: 'short job'
      }
    });

    const result = await handlers.get('ask-ai-with-session-context')(null, {
      contextString: 'LIVE_CONTEXT_MARKER',
      transcriptContext: 'TRANSCRIPT_CONTEXT_MARKER'
    });
    assert.equal(result.success, true);
    assert.equal(clientCreates, 0);
    assert.equal(requests.length, 1);
    assert.equal(Object.hasOwn(requests[0], 'cached_content'), false);
    const prompt = requests[0].messages.find(
      (message) => message.role === 'user'
    ).content;
    assert.equal(prompt.includes('You are Invisibrain'), true);
    assert.equal(prompt.includes('short resume'), true);
    assert.equal(prompt.includes('short job'), true);
  });

  it('binds Portkey cache and chat to exact attempt settings during concurrent changes', async () => {
    const runtime = createAiRuntime();
    const oldSettings = {
      apiKey: 'portkey-attempt-key-old',
      provider: '@vertex',
      baseUrl: 'https://old-portkey.example.invalid/v1',
      model: PRIMARY_MODEL
    };
    const newSettings = {
      apiKey: 'portkey-settings-key-new',
      provider: '@openai',
      baseUrl: 'https://new-portkey.example.invalid/v1',
      model: FALLBACK_MODEL
    };
    runtime.setActiveAiProvider('portkey');
    runtime.setActivePortkeyApiKey(oldSettings.apiKey);
    runtime.setActivePortkeyProvider(oldSettings.provider);
    runtime.setActivePortkeyBaseUrl(oldSettings.baseUrl);
    runtime.setActiveGeminiModel(oldSettings.model);
    runtime.initializePortkeyService(
      oldSettings.apiKey,
      oldSettings.model,
      'Python',
      {
        provider: oldSettings.provider,
        baseUrl: oldSettings.baseUrl
      }
    );

    const chatRequests = [];
    const adapter = runtime.getService().adapter;
    adapter.maxRetries = 0;
    adapter.waitForRateLimit = async () => {};
    adapter._initializeClient = function initializeSnapshotClient() {
      const snapshot = {
        apiKey: this.apiKey,
        provider: this.provider,
        baseUrl: this.baseUrl
      };
      this.client = {
        chat: {
          completions: {
            async create(request) {
              chatRequests.push({ snapshot, request });
              return {
                async *[Symbol.asyncIterator]() {
                  yield { choices: [{ delta: { content: 'bound response' } }] };
                }
              };
            }
          }
        }
      };
    };
    adapter._initializeClient();

    const cacheStarted = createDeferred();
    const releaseCache = createDeferred();
    const cacheClients = [];
    const cacheManager = createCacheManager({
      minCacheTokens: 0,
      createClient(apiKey, context) {
        cacheClients.push({
          apiKey,
          context: { ...context }
        });
        return {
          caches: {
            async create() {
              cacheStarted.resolve();
              await releaseCache.promise;
              return {
                name:
                  'projects/safe-project/locations/us-central1/cachedContents/exact-attempt',
                expireTime: new Date(Date.now() + 60_000).toISOString()
              };
            },
            async delete() {}
          }
        };
      }
    });
    const { handlers } = registerHarness({ runtime, cacheManager });

    const resultPromise = handlers.get('ask-ai-with-session-context')(null, {
      contextString: 'LIVE_CONTEXT_MARKER',
      transcriptContext: 'TRANSCRIPT_CONTEXT_MARKER'
    });
    await cacheStarted.promise;

    runtime.setActivePortkeyApiKey(newSettings.apiKey);
    runtime.setActivePortkeyProvider(newSettings.provider);
    runtime.setActivePortkeyBaseUrl(newSettings.baseUrl);
    runtime.setActiveGeminiModel(newSettings.model);
    runtime.initializePortkeyService(
      newSettings.apiKey,
      newSettings.model,
      'JavaScript',
      {
        provider: newSettings.provider,
        baseUrl: newSettings.baseUrl
      }
    );
    releaseCache.resolve();

    const result = await resultPromise;
    assert.equal(result.success, true);
    assert.deepEqual(cacheClients, [{
      apiKey: oldSettings.apiKey,
      context: {
        provider: oldSettings.provider,
        cacheNamespace:
          `portkey-vertex-v1|${oldSettings.provider}|${oldSettings.baseUrl}`,
        baseUrl: oldSettings.baseUrl
      }
    }]);
    assert.equal(chatRequests.length, 1);
    assert.deepEqual(chatRequests[0].snapshot, {
      apiKey: oldSettings.apiKey,
      provider: oldSettings.provider,
      baseUrl: oldSettings.baseUrl
    });
    assert.equal(chatRequests[0].request.model, oldSettings.model);
    assert.match(
      chatRequests[0].request.cached_content,
      /cachedContents\/exact-attempt$/
    );
    assert.equal(runtime.getActivePortkeyApiKey(), newSettings.apiKey);
    assert.equal(runtime.getActivePortkeyProvider(), newSettings.provider);
    assert.equal(runtime.getActivePortkeyBaseUrl(), newSettings.baseUrl);
    assert.equal(runtime.getActiveGeminiModel(), newSettings.model);
    assert.equal(runtime.getService().adapter.apiKey, newSettings.apiKey);
    assert.equal(runtime.getService().adapter.provider, newSettings.provider);
    assert.equal(runtime.getService().adapter.baseUrl, newSettings.baseUrl);
  });

  it('never carries a Portkey 3.8 cache into automatic 3.7 fallback', async () => {
    const runtime = createAiRuntime();
    runtime.setActiveAiProvider('portkey');
    runtime.setActiveGeminiModel(PRIMARY_MODEL);
    runtime.setActivePortkeyApiKey('portkey-fallback-key');
    runtime.initializePortkeyService(
      'portkey-fallback-key',
      PRIMARY_MODEL,
      'Python',
      {
        provider: '@vertex',
        baseUrl: 'https://portkey-fallback.example.invalid/v1'
      }
    );
    const adapter = runtime.getService().adapter;
    const requests = [];
    adapter.maxRetries = 0;
    adapter.waitForRateLimit = async () => {};
    adapter.client = {
      chat: {
        completions: {
          async create(request) {
            requests.push(request);
            if (request.model === PRIMARY_MODEL) {
              throw Object.assign(new Error('primary model unavailable'), {
                status: 503
              });
            }
            return {
              async *[Symbol.asyncIterator]() {
                yield { choices: [{ delta: { content: 'fallback' } }] };
              }
            };
          }
        }
      }
    };
    const cacheManager = createMetadataCacheManager();
    const { handlers } = registerHarness({ runtime, cacheManager });

    const result = await handlers.get('ask-ai-with-session-context')(null, {
      contextString: 'LIVE_CONTEXT_MARKER',
      transcriptContext: 'TRANSCRIPT_CONTEXT_MARKER'
    });

    assert.equal(result.success, true);
    assert.deepEqual(requests.map((request) => ({
      model: request.model,
      cachedContent: request.cached_content || null
    })), [
      {
        model: PRIMARY_MODEL,
        cachedContent: `cachedContents/${PRIMARY_MODEL}`
      },
      {
        model: FALLBACK_MODEL,
        cachedContent: null
      }
    ]);
    const fallbackPrompt = requests[1].messages.find(
      (message) => message.role === 'user'
    ).content;
    assert.equal(fallbackPrompt.includes('You are Invisibrain'), true);
    assert.equal(fallbackPrompt.includes('CACHE_BINDING_RESUME_MARKER'), true);
    assert.equal(fallbackPrompt.includes('CACHE_BINDING_JOB_MARKER'), true);
  });

  it('uses no primary cache on the automatic 3.7 Gemini fallback', async () => {
    const runtime = createGeminiRuntime();
    const adapter = runtime.getService().adapter;
    const requests = [];
    const ensureCalls = [];
    adapter.maxRetries = 0;
    adapter.waitForRateLimit = async () => {};
    adapter.client = {
      models: {
        async *generateContentStream(request) {
          requests.push(request);
          if (request.model === PRIMARY_MODEL) {
            throw Object.assign(new Error('primary model temporarily unavailable'), {
              status: 503
            });
          }
          yield { text: 'fallback response' };
        }
      }
    };

    const cacheManager = createMetadataCacheManager((params) => {
      ensureCalls.push(params.model);
    });
    const { handlers } = registerHarness({ runtime, cacheManager });
    const result = await handlers.get('ask-ai-with-session-context')(null, {
      contextString: 'LIVE_CONTEXT_MARKER',
      transcriptContext: 'TRANSCRIPT_CONTEXT_MARKER'
    });

    assert.equal(result.success, true);
    assert.deepEqual(ensureCalls, [PRIMARY_MODEL]);
    assert.deepEqual(requests.map((request) => request.model), [
      PRIMARY_MODEL,
      FALLBACK_MODEL
    ]);
    assert.equal(
      requests[0].config.cachedContent,
      `cachedContents/${PRIMARY_MODEL}`
    );
    assert.equal(Object.hasOwn(requests[1].config, 'cachedContent'), false);
    const fallbackPrompt = getGeminiPrompt(requests[1]);
    assert.equal(fallbackPrompt.includes('You are Invisibrain'), true);
    assert.equal(fallbackPrompt.includes('CACHE_BINDING_RESUME_MARKER'), true);
    assert.equal(fallbackPrompt.includes('CACHE_BINDING_JOB_MARKER'), true);
  });

  it('creates and sends each key-rotation cache with the exact execution key', async () => {
    const keyA = 'gemini-rotation-key-a';
    const keyB = 'gemini-rotation-key-b';
    const runtime = createAiRuntime();
    runtime.setActiveAiProvider('gemini');
    runtime.setActiveGeminiModel(PRIMARY_MODEL);
    runtime.setKeys([keyA, keyB], 0);
    runtime.initializeGeminiService(keyA, PRIMARY_MODEL, 'Python');

    const networkRequests = [];
    const adapter = runtime.getService().adapter;
    adapter.maxRetries = 0;
    adapter.waitForRateLimit = async () => {};
    adapter._initializeClient = function initializeRotationClient() {
      const boundKey = this.apiKey;
      this.client = {
        models: {
          async *generateContentStream(request) {
            networkRequests.push({ key: boundKey, request });
            if (boundKey === keyA) {
              throw Object.assign(new Error('quota exhausted'), { status: 429 });
            }
            yield { text: 'key B response' };
          }
        }
      };
    };
    adapter._initializeClient();

    const cacheCreates = [];
    const cacheDeletes = [];
    const cacheManager = createCacheManager({
      minCacheTokens: 0,
      apiKey: keyA,
      createClient(apiKey) {
        return {
          caches: {
            async create({ model }) {
              cacheCreates.push({ apiKey, model });
              return {
                name: apiKey === keyA
                  ? 'cachedContents/key-a'
                  : 'cachedContents/key-b',
                expireTime: new Date(Date.now() + 60_000).toISOString()
              };
            },
            async delete({ name }) {
              cacheDeletes.push({ apiKey, name });
            }
          }
        };
      }
    });
    const { handlers } = registerHarness({
      runtime,
      cacheManager
    });

    const result = await handlers.get('ask-ai-with-session-context')(null, {
      contextString: 'LIVE_CONTEXT_MARKER',
      transcriptContext: 'TRANSCRIPT_CONTEXT_MARKER'
    });

    assert.equal(result.success, true);
    assert.deepEqual(cacheCreates, [
      { apiKey: keyA, model: PRIMARY_MODEL },
      { apiKey: keyB, model: PRIMARY_MODEL }
    ]);
    assert.deepEqual(
      networkRequests.map(({ key, request }) => ({
        key,
        model: request.model,
        cache: request.config.cachedContent
      })),
      [
        { key: keyA, model: PRIMARY_MODEL, cache: 'cachedContents/key-a' },
        { key: keyB, model: PRIMARY_MODEL, cache: 'cachedContents/key-b' }
      ]
    );
    assert.deepEqual(cacheDeletes, [
      { apiKey: keyA, name: 'cachedContents/key-a' }
    ]);
  });

  it('waits for idle remote cache deletion when clearing CV and job documents', async () => {
    const runtime = createGeminiRuntime();
    const invalidationStarted = createDeferred();
    const releaseInvalidation = createDeferred();
    const invalidationReasons = [];
    const cacheManager = {
      async invalidate(reason) {
        invalidationReasons.push(reason);
        invalidationStarted.resolve();
        await releaseInvalidation.promise;
      }
    };
    const { handlers } = registerHarness({ runtime, cacheManager });

    let clearSettled = false;
    const clearPromise = handlers.get('clear-documents')()
      .then((result) => {
        clearSettled = true;
        return result;
      });
    await invalidationStarted.promise;
    await Promise.resolve();
    const settledBeforeRelease = clearSettled;
    releaseInvalidation.resolve();

    assert.deepEqual(await clearPromise, { success: true });
    assert.equal(settledBeforeRelease, false);
    assert.deepEqual(invalidationReasons, ['documents-cleared']);
  });
});

describe('cache manager credential binding and leases', () => {
  it('exposes a monotonic generation and accepts a current expected generation', async () => {
    const manager = createCacheManager({
      minCacheTokens: 0,
      apiKey: 'generation-test-key',
      client: {
        caches: {
          async create() {
            return {
              name: 'cachedContents/current-generation',
              expireTime: new Date(Date.now() + 60_000).toISOString()
            };
          },
          async delete() {}
        }
      }
    });
    const initialGeneration = manager.getGeneration();
    assert.equal(Number.isSafeInteger(initialGeneration), true);
    assert.equal(manager.isGenerationCurrent(initialGeneration), true);

    const lease = await manager.acquireCache({
      model: PRIMARY_MODEL,
      programmingLanguage: 'Python',
      resume: LONG_RESUME,
      jobDescription: LONG_JOB_DESCRIPTION,
      apiKey: 'generation-test-key',
      expectedGeneration: initialGeneration
    });
    assert.equal(lease.used, true);
    await lease.release();

    await manager.invalidate('documents-changed');
    const nextGeneration = manager.getGeneration();
    assert.ok(nextGeneration > initialGeneration);
    assert.equal(manager.isGenerationCurrent(initialGeneration), false);
    assert.equal(manager.isGenerationCurrent(nextGeneration), true);
  });

  it('includes credential identity in fingerprints and never returns key or client metadata', async () => {
    const creates = [];
    const manager = createCacheManager({
      minCacheTokens: 0,
      createClient(apiKey) {
        return {
          caches: {
            async create({ model }) {
              creates.push({ apiKey, model });
              return {
                name: `cachedContents/${creates.length}`,
                expireTime: new Date(Date.now() + 60_000).toISOString()
              };
            },
            async delete() {}
          }
        };
      }
    });
    const params = {
      model: PRIMARY_MODEL,
      programmingLanguage: 'Python',
      resume: LONG_RESUME,
      jobDescription: LONG_JOB_DESCRIPTION
    };

    const keyA = 'CACHE_METADATA_SECRET_A';
    const keyB = 'CACHE_METADATA_SECRET_B';
    const expectedA = manager.buildFingerprint({ ...params, apiKey: keyA });
    const expectedB = manager.buildFingerprint({ ...params, apiKey: keyB });
    const leaseA = await manager.acquireCache({ ...params, apiKey: keyA });
    const leaseB = await manager.acquireCache({ ...params, apiKey: keyB });

    assert.notEqual(expectedA.fingerprint, expectedB.fingerprint);
    assert.equal(leaseA.fingerprint, expectedA.fingerprint);
    assert.equal(leaseB.fingerprint, expectedB.fingerprint);
    assert.equal(manager.getActiveCache().name, leaseB.cacheName);
    assert.deepEqual(creates, [
      { apiKey: keyA, model: PRIMARY_MODEL },
      { apiKey: keyB, model: PRIMARY_MODEL }
    ]);
    for (const metadata of [expectedA, expectedB, leaseA, leaseB, manager.getActiveCache()]) {
      const serialized = JSON.stringify(metadata);
      assert.equal(serialized.includes(keyA), false);
      assert.equal(serialized.includes(keyB), false);
      assert.equal(Object.hasOwn(metadata, 'apiKey'), false);
      assert.equal(Object.hasOwn(metadata, 'client'), false);
      assert.equal(Object.hasOwn(metadata, 'credentialHash'), false);
      assert.equal(Object.hasOwn(metadata, 'credentialIdentity'), false);
    }

    await leaseA.release();
    await leaseB.release();
    await manager.invalidate('test-cleanup');
  });

  it('scopes client identity and fingerprints to immutable provider namespaces', async () => {
    const contexts = [];
    const manager = createCacheManager({
      minCacheTokens: 0,
      createClient(apiKey, context) {
        contexts.push({
          apiKey,
          context,
          frozen: Object.isFrozen(context)
        });
        return {
          caches: {
            async create() {
              return {
                name: `cachedContents/${context.cacheNamespace}`,
                expireTime: new Date(Date.now() + 60_000).toISOString()
              };
            },
            async delete() {}
          }
        };
      }
    });
    const shared = {
      model: PRIMARY_MODEL,
      programmingLanguage: 'Python',
      resume: LONG_RESUME,
      jobDescription: LONG_JOB_DESCRIPTION,
      apiKey: 'same-exact-key',
      provider: 'portkey'
    };
    const firstParams = {
      ...shared,
      cacheNamespace: 'vertex-gateway-a',
      baseUrl: 'https://gateway-a.invalid/v1'
    };
    const secondParams = {
      ...shared,
      cacheNamespace: 'vertex-gateway-b',
      baseUrl: 'https://gateway-b.invalid/v1'
    };

    const firstFingerprint = manager.buildFingerprint(firstParams);
    const secondFingerprint = manager.buildFingerprint(secondParams);
    const first = await manager.acquireCache(firstParams);
    const second = await manager.acquireCache(secondParams);
    const secondHit = await manager.acquireCache(secondParams);

    assert.notEqual(firstFingerprint.fingerprint, secondFingerprint.fingerprint);
    assert.notEqual(first.fingerprint, second.fingerprint);
    assert.equal(contexts.length, 2);
    assert.deepEqual(contexts.map(({ apiKey, context, frozen }) => ({
      apiKey,
      context: { ...context },
      frozen
    })), [
      {
        apiKey: 'same-exact-key',
        context: {
          provider: 'portkey',
          cacheNamespace: 'vertex-gateway-a',
          baseUrl: 'https://gateway-a.invalid/v1'
        },
        frozen: true
      },
      {
        apiKey: 'same-exact-key',
        context: {
          provider: 'portkey',
          cacheNamespace: 'vertex-gateway-b',
          baseUrl: 'https://gateway-b.invalid/v1'
        },
        frozen: true
      }
    ]);

    for (const metadata of [
      firstFingerprint,
      secondFingerprint,
      first,
      second,
      manager.getActiveCache()
    ]) {
      const serialized = JSON.stringify(metadata);
      assert.equal(serialized.includes('same-exact-key'), false);
      assert.equal(Object.hasOwn(metadata, 'cacheNamespace'), false);
      assert.equal(Object.hasOwn(metadata, 'baseUrl'), false);
      assert.equal(Object.hasOwn(metadata, 'provider'), false);
    }
    assert.deepEqual(manager.getDiagnostics(), {
      enabled: true,
      activeCount: 1,
      hasActiveName: true,
      hitCount: 1
    });
    const diagnostics = JSON.stringify(manager.getDiagnostics());
    assert.equal(diagnostics.includes('same-exact-key'), false);
    assert.equal(diagnostics.includes('cachedContents'), false);
    assert.equal(diagnostics.includes(LONG_RESUME), false);

    await first.release();
    await second.release();
    await secondHit.release();
    await manager.invalidate('test-cleanup');
  });

  it('defers invalidation deletion while leased and deletes exactly once after release', async () => {
    const deletes = [];
    const manager = createCacheManager({
      minCacheTokens: 0,
      apiKey: 'lease-test-key',
      client: {
        caches: {
          async create() {
            return {
              name: 'cachedContents/leased',
              expireTime: new Date(Date.now() + 60_000).toISOString()
            };
          },
          async delete({ name }) {
            deletes.push(name);
          }
        }
      }
    });
    const lease = await manager.acquireCache({
      model: PRIMARY_MODEL,
      programmingLanguage: 'Python',
      resume: LONG_RESUME,
      jobDescription: LONG_JOB_DESCRIPTION,
      apiKey: 'lease-test-key'
    });

    await manager.invalidate('documents-cleared');
    assert.deepEqual(deletes, []);

    await lease.release();
    await lease.release();
    assert.deepEqual(deletes, ['cachedContents/leased']);
  });

  it('deletes an idle invalidated cache promptly with its original client', async () => {
    const deletes = [];
    const originalClient = {
      caches: {
        async create() {
          return {
            name: 'cachedContents/original-client',
            expireTime: new Date(Date.now() + 60_000).toISOString()
          };
        },
        async delete({ name }) {
          deletes.push({ client: 'original', name });
        }
      }
    };
    const manager = createCacheManager({
      minCacheTokens: 0,
      apiKey: 'original-key',
      client: originalClient,
      createClient() {
        throw new Error('replacement client must not delete the original cache');
      }
    });
    const lease = await manager.acquireCache({
      model: PRIMARY_MODEL,
      programmingLanguage: 'Python',
      resume: LONG_RESUME,
      jobDescription: LONG_JOB_DESCRIPTION,
      apiKey: 'original-key'
    });
    await lease.release();

    await manager.setApiKey('replacement-key');
    assert.deepEqual(deletes, [
      { client: 'original', name: 'cachedContents/original-client' }
    ]);
  });

  it('sanitizes deletion failures and keeps them out of public metadata', async () => {
    const secret = 'DELETE_FAILURE_SECRET_KEY';
    const warnings = [];
    const originalWarn = console.warn;
    const manager = createCacheManager({
      minCacheTokens: 0,
      apiKey: secret,
      client: {
        caches: {
          async create() {
            return {
              name: 'cachedContents/safe-delete-name',
              expireTime: new Date(Date.now() + 60_000).toISOString()
            };
          },
          async delete() {
            throw new Error(`delete rejected for ${secret}`);
          }
        }
      }
    });

    try {
      console.warn = (...args) => warnings.push(args);
      const lease = await manager.acquireCache({
        model: PRIMARY_MODEL,
        programmingLanguage: 'Python',
        resume: LONG_RESUME,
        jobDescription: LONG_JOB_DESCRIPTION,
        apiKey: secret
      });
      await lease.release();
      await manager.invalidate('settings-changed');

      const serializedMetadata = JSON.stringify(lease);
      const serializedWarnings = JSON.stringify(warnings);
      assert.equal(serializedMetadata.includes(secret), false);
      assert.equal(serializedWarnings.includes(secret), false);
      assert.equal(serializedWarnings.includes('delete rejected'), false);
      assert.equal(serializedWarnings.includes('client'), false);
      assert.equal(warnings.length, 1);
    } finally {
      console.warn = originalWarn;
    }
  });

  it('creates conflicting model and key caches concurrently without cross-returning resources', async () => {
    const primaryCreate = createDeferred();
    const fallbackCreate = createDeferred();
    const primaryStarted = createDeferred();
    const fallbackStarted = createDeferred();
    const deletes = [];

    const manager = createCacheManager({
      minCacheTokens: 0,
      createClient(apiKey) {
        return {
          caches: {
            create({ model }) {
              if (model === PRIMARY_MODEL) {
                primaryStarted.resolve();
                return primaryCreate.promise;
              }
              fallbackStarted.resolve();
              return fallbackCreate.promise;
            },
            async delete({ name }) {
              deletes.push({ apiKey, name });
            }
          }
        };
      }
    });

    const primaryParams = {
      model: PRIMARY_MODEL,
      programmingLanguage: 'Python',
      resume: LONG_RESUME,
      jobDescription: LONG_JOB_DESCRIPTION,
      apiKey: 'concurrent-key-a'
    };
    const fallbackParams = {
      ...primaryParams,
      model: FALLBACK_MODEL,
      apiKey: 'concurrent-key-b'
    };

    const expectedPrimary = manager.buildFingerprint(primaryParams);
    const expectedFallback = manager.buildFingerprint(fallbackParams);
    const primaryPromise = manager.acquireCache(primaryParams);
    await primaryStarted.promise;

    const fallbackPromise = manager.acquireCache(fallbackParams);
    await fallbackStarted.promise;

    primaryCreate.resolve({
      name: 'cachedContents/primary-3.8',
      expireTime: new Date(Date.now() + 60_000).toISOString()
    });
    const primaryResult = await primaryPromise;

    fallbackCreate.resolve({
      name: 'cachedContents/fallback-3.7',
      expireTime: new Date(Date.now() + 60_000).toISOString()
    });
    const fallbackResult = await fallbackPromise;

    assert.deepEqual(
      {
        cacheName: primaryResult.cacheName,
        model: primaryResult.model,
        fingerprint: primaryResult.fingerprint
      },
      {
        cacheName: 'cachedContents/primary-3.8',
        model: PRIMARY_MODEL,
        fingerprint: expectedPrimary.fingerprint
      }
    );
    assert.deepEqual(
      {
        cacheName: fallbackResult.cacheName,
        model: fallbackResult.model,
        fingerprint: fallbackResult.fingerprint
      },
      {
        cacheName: 'cachedContents/fallback-3.7',
        model: FALLBACK_MODEL,
        fingerprint: expectedFallback.fingerprint
      }
    );
    assert.equal(manager.getActiveCache().model, FALLBACK_MODEL);
    assert.equal(manager.getActiveCache().fingerprint, expectedFallback.fingerprint);
    assert.deepEqual(deletes, []);

    await primaryResult.release();
    assert.deepEqual(deletes, [
      {
        apiKey: 'concurrent-key-a',
        name: 'cachedContents/primary-3.8'
      }
    ]);
    await fallbackResult.release();
    await manager.invalidate('test-cleanup');
    assert.deepEqual(deletes, [
      {
        apiKey: 'concurrent-key-a',
        name: 'cachedContents/primary-3.8'
      },
      {
        apiKey: 'concurrent-key-b',
        name: 'cachedContents/fallback-3.7'
      }
    ]);
  });

  it('deletes an invalidated in-flight cache once and never returns or leases it', async () => {
    const createStarted = createDeferred();
    const createResult = createDeferred();
    const deletes = [];
    const manager = createCacheManager({
      minCacheTokens: 0,
      apiKey: 'old-test-key',
      client: {
        caches: {
          create() {
            createStarted.resolve();
            return createResult.promise;
          },
          async delete({ name }) {
            deletes.push(name);
          }
        }
      }
    });

    const expectedGeneration = manager.getGeneration();
    const acquirePromise = manager.acquireCache({
      model: PRIMARY_MODEL,
      programmingLanguage: 'Python',
      resume: LONG_RESUME,
      jobDescription: LONG_JOB_DESCRIPTION,
      apiKey: 'old-test-key',
      expectedGeneration
    });
    await createStarted.promise;

    await manager.invalidate('settings-changed');
    createResult.resolve({
      name: 'cachedContents/invalidated-primary',
      expireTime: new Date(Date.now() + 60_000).toISOString()
    });

    const result = await acquirePromise;
    assert.equal(result.used, false);
    assert.equal(result.reason, 'stale-generation');
    assert.equal(Object.hasOwn(result, 'cacheName'), false);
    assert.equal(Object.hasOwn(result, 'release'), false);
    assert.equal(manager.getActiveCache(), null);
    assert.deepEqual(deletes, ['cachedContents/invalidated-primary']);
  });
});
