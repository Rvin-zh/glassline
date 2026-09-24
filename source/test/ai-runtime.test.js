const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const { createAiRuntime } = require('../src/main-process/features/assistant/gemini-runtime');
const { sanitizeAppState, getDefaultAppState } = require('../src/services/state/app-state');

describe('isAiReady behavior', () => {
  it('is false for gemini without keys', () => {
    const runtime = createAiRuntime();
    runtime.setActiveAiProvider('gemini');
    runtime.setKeys([], 0);
    assert.equal(runtime.isAiReady(), false);
  });

  it('becomes true for gemini after keys + initialize', () => {
    const runtime = createAiRuntime();
    runtime.setActiveAiProvider('gemini');
    runtime.setKeys(['test-gemini-key'], 0);
    runtime.initializeGeminiService('test-gemini-key', 'gemini-3.8-flash', 'Python');
    assert.equal(runtime.isAiReady(), true);
    assert.ok(runtime.getService());
    assert.equal(typeof runtime.getService().askAiWithSessionContext, 'function');
  });

  it('requires portkey api key for portkey readiness', () => {
    const runtime = createAiRuntime();
    runtime.setActiveAiProvider('portkey');
    runtime.setActivePortkeyApiKey('');
    assert.equal(runtime.isAiReady(), false);

    runtime.setActivePortkeyApiKey('pk-test-key');
    runtime.initializePortkeyService('pk-test-key', 'gemini-3.8-flash', 'Python', {
      provider: '@vertex'
    });
    assert.equal(runtime.isAiReady(), true);
  });

  it('keeps exact Portkey cache configuration internal to the execution attempt', async () => {
    const apiKey = 'PORTKEY_INTERNAL_CACHE_SECRET';
    const baseUrl = 'https://internal-cache-gateway.example.invalid/v1';
    const runtime = createAiRuntime();
    runtime.setActiveAiProvider('portkey');
    runtime.setActivePortkeyApiKey(apiKey);
    runtime.setActivePortkeyProvider('@vertex');
    runtime.setActivePortkeyBaseUrl(baseUrl);
    runtime.setActiveGeminiModel('gemini-3.8-flash');
    runtime.initializePortkeyService(
      apiKey,
      'gemini-3.8-flash',
      'Python',
      { provider: '@vertex', baseUrl }
    );

    let captured;
    await runtime.executeWithKeyFailover(async (_service, execution) => {
      const descriptor = Object.getOwnPropertyDescriptor(
        execution,
        'getCacheConfiguration'
      );
      captured = {
        enumerable: descriptor?.enumerable,
        keys: Object.keys(execution),
        serialized: JSON.stringify(execution),
        configuration: execution.getCacheConfiguration(),
        frozen: Object.isFrozen(execution.getCacheConfiguration())
      };
      return 'ok';
    });

    assert.equal(captured.enumerable, false);
    assert.equal(captured.keys.includes('getCacheConfiguration'), false);
    assert.equal(captured.serialized.includes(apiKey), false);
    assert.equal(captured.serialized.includes(baseUrl), false);
    assert.deepEqual(captured.configuration, {
      apiKey,
      provider: '@vertex',
      baseUrl,
      cacheNamespace: `portkey-vertex-v1|@vertex|${baseUrl}`
    });
    assert.equal(captured.frozen, true);
    const diagnostics = JSON.stringify(runtime.getLastExecutionDiagnostics());
    assert.equal(diagnostics.includes(apiKey), false);
    assert.equal(diagnostics.includes(baseUrl), false);
    assert.equal(diagnostics.includes('portkey-vertex-v1'), false);
  });
});

describe('app-state sanitize preserves new fields', () => {
  it('keeps portkey, search, memory, and stt fields', () => {
    const sanitized = sanitizeAppState({
      aiProvider: 'portkey',
      portkeyApiKey: ' pk-secret ',
      portkeyProvider: '@vertex',
      portkeyBaseUrl: 'https://example.invalid',
      promptCacheEnabled: true,
      webSearchEnabled: true,
      webSearchProvider: 'tavily',
      tavilyApiKey: ' tv-key ',
      resumeText: 'resume body',
      jobDescriptionText: 'jd body',
      sessionMemorySummary: 'summary',
      durableNotes: [{ id: '1', text: 'note' }],
      sttProvider: 'openai',
      openaiApiKey: ' sk-test ',
      openaiSttModel: 'gpt-live-transcribe',
      geminiModel: 'gemini-3.7-flash'
    });

    assert.equal(sanitized.aiProvider, 'portkey');
    assert.equal(sanitized.portkeyApiKey, 'pk-secret');
    assert.equal(sanitized.portkeyProvider, '@vertex');
    assert.equal(sanitized.portkeyBaseUrl, 'https://example.invalid');
    assert.equal(sanitized.promptCacheEnabled, true);
    assert.equal(sanitized.webSearchEnabled, true);
    assert.equal(sanitized.webSearchProvider, 'tavily');
    assert.equal(sanitized.tavilyApiKey, 'tv-key');
    assert.equal(sanitized.resumeText, 'resume body');
    assert.equal(sanitized.jobDescriptionText, 'jd body');
    assert.equal(sanitized.sessionMemorySummary, 'summary');
    assert.equal(sanitized.durableNotes.length, 1);
    assert.equal(sanitized.sttProvider, 'openai');
    assert.equal(sanitized.openaiApiKey, 'sk-test');
    assert.equal(sanitized.openaiSttModel, 'gpt-live-transcribe');
    assert.equal(sanitized.geminiModel, 'gemini-3.7-flash');
  });

  it('defaults include the new keys', () => {
    const defaults = getDefaultAppState();
    for (const key of [
      'portkeyApiKey',
      'portkeyProvider',
      'portkeyBaseUrl',
      'promptCacheEnabled',
      'webSearchEnabled',
      'webSearchProvider',
      'tavilyApiKey',
      'resumeText',
      'jobDescriptionText',
      'sessionMemorySummary',
      'durableNotes',
      'sttProvider',
      'openaiApiKey',
      'openaiSttModel'
    ]) {
      assert.ok(key in defaults, `missing default key ${key}`);
    }
  });
});
