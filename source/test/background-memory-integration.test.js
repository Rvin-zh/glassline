'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const {
  registerContextServicesIpc
} = require('../src/main-process/features/assistant/context-services-ipc');
const {
  createAiRuntime
} = require('../src/main-process/features/assistant/gemini-runtime');
const {
  createMemoryService
} = require('../src/services/ai/memory-service');
const {
  createInvokeActions
} = require('../src/windows/assistant/preload/actions');

const MEMORY_MODEL = 'gemini-3.5-flash-lite';

function createSummary(topic) {
  return {
    currentTopic: topic,
    questions: [],
    facts: [],
    candidateExamples: [],
    strengthsGaps: [],
    commitments: [],
    proposedDurableNotes: []
  };
}

describe('memory service background diagnostics', () => {
  it('preserves the last valid summary and records only a failure category and time', async () => {
    let fail = false;
    const warnings = [];
    const originalWarn = console.warn;
    console.warn = (...args) => warnings.push(args.join(' '));

    try {
      const memoryService = createMemoryService({
        initialSummary: createSummary('Previous valid topic'),
        debounceMs: 60_000,
        getGenerationStatus: () => ({
          provider: 'portkey',
          model: MEMORY_MODEL,
          ready: true
        }),
        async generateText() {
          if (fail) {
            const error = new Error(
              'secret-key-value and private memory prompt must not be logged'
            );
            error.memoryErrorCategory = 'authentication';
            throw error;
          }
          return createSummary('Fresh valid topic');
        }
      });

      memoryService.triggerUpdate({ transcript: 'first transcript' });
      await memoryService.flush();
      const lastSuccessAt = memoryService.getStatus().lastSuccessAt;
      assert.match(lastSuccessAt, /^\d{4}-\d{2}-\d{2}T/);
      assert.equal(memoryService.getSummary().currentTopic, 'Fresh valid topic');

      fail = true;
      memoryService.triggerUpdate({
        transcript: 'private memory prompt'
      });
      await memoryService.flush();

      assert.equal(memoryService.getSummary().currentTopic, 'Fresh valid topic');
      assert.deepEqual(memoryService.getStatus(), {
        busy: false,
        modelName: MEMORY_MODEL,
        thinkingLevel: 'minimal',
        debounceMs: 60_000,
        reviewQueueCount: 0,
        durableNotesCount: 0,
        hasSummary: true,
        provider: 'portkey',
        model: MEMORY_MODEL,
        ready: true,
        lastSuccessAt,
        lastErrorCategory: 'authentication',
        lastErrorAt: memoryService.getStatus().lastErrorAt
      });
      assert.match(memoryService.getStatus().lastErrorAt, /^\d{4}-\d{2}-\d{2}T/);
      assert.equal(warnings.length, 1);
      assert.equal(warnings[0].includes('secret-key-value'), false);
      assert.equal(warnings[0].includes('private memory prompt'), false);
    } finally {
      console.warn = originalWarn;
    }
  });

  it('reports dynamic provider readiness from the active generator config', () => {
    let status = {
      provider: 'gemini',
      model: MEMORY_MODEL,
      ready: false
    };
    const memoryService = createMemoryService({
      getGenerationStatus: () => status,
      generateText: async () => createSummary('unused')
    });

    assert.equal(memoryService.getStatus().provider, 'gemini');
    assert.equal(memoryService.getStatus().ready, false);

    status = {
      provider: 'portkey',
      model: MEMORY_MODEL,
      ready: true
    };
    assert.equal(memoryService.getStatus().provider, 'portkey');
    assert.equal(memoryService.getStatus().model, MEMORY_MODEL);
    assert.equal(memoryService.getStatus().ready, true);
  });
});

describe('context-services background memory configuration', () => {
  it('reports configured Portkey memory ready without a Gemini key', () => {
    const runtime = createAiRuntime();
    runtime.setActiveAiProvider('portkey');
    runtime.setKeys('', 0);
    runtime.setActivePortkeyApiKey('portkey-only-key');
    runtime.setActivePortkeyProvider('@vertex');
    runtime.setActivePortkeyBaseUrl('https://memory-gateway.invalid/v1');

    let state = {
      aiProvider: 'portkey',
      geminiApiKey: '',
      portkeyApiKey: 'portkey-only-key',
      portkeyProvider: '@vertex',
      portkeyBaseUrl: 'https://memory-gateway.invalid/v1',
      promptCacheEnabled: false,
      documents: null,
      durableNotes: []
    };
    const handlers = new Map();

    const services = registerContextServicesIpc({
      ipcMain: {
        handle(channel, handler) {
          handlers.set(channel, handler);
        }
      },
      app: {},
      getAppState: () => state,
      setAppState(nextState) {
        state = nextState;
      },
      saveAppState(_app, patch) {
        state = { ...state, ...patch };
        return state;
      },
      geminiRuntime: runtime,
      sendToRenderer() {}
    });

    const result = handlers.get('memory-get-summary')();
    assert.equal(result.success, true);
    assert.equal(result.status.provider, 'portkey');
    assert.equal(result.status.model, MEMORY_MODEL);
    assert.equal(result.status.ready, true);
    assert.equal(result.status.lastSuccessAt, null);
    assert.equal(result.status.lastErrorCategory, null);
    assert.equal(result.status.lastErrorAt, null);
    assert.equal(services.backgroundMemoryGenerator.getStatus().ready, true);
    assert.equal(typeof handlers.get('memory-flush'), 'function');
  });

  it('exposes memory flush through the invoke-only preload bridge', async () => {
    const calls = [];
    const actions = createInvokeActions({
      invoke(channel, ...args) {
        calls.push({ channel, args });
        return Promise.resolve({ success: true });
      }
    });

    await actions.memoryFlush();
    assert.deepEqual(calls, [{ channel: 'memory-flush', args: [] }]);
  });
});
