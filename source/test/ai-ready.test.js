'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const { createAiRuntime, createGeminiRuntime } = require('../src/main-process/features/assistant/gemini-runtime');

describe('isAiReady', () => {
  it('exports createGeminiRuntime as a compatibility alias', () => {
    assert.equal(createGeminiRuntime, createAiRuntime);
  });

  it('is false for gemini without keys', () => {
    const runtime = createAiRuntime();
    runtime.setActiveAiProvider('gemini');
    runtime.setKeys([], 0);
    assert.equal(runtime.isAiReady(), false);
  });

  it('is true for gemini after keys and initialize', () => {
    const runtime = createAiRuntime();
    runtime.setActiveAiProvider('gemini');
    runtime.setKeys(['test-gemini-key'], 0);
    runtime.initializeGeminiService('test-gemini-key', 'gemini-3.8-flash', 'Python');
    assert.equal(runtime.isAiReady(), true);
    assert.equal(typeof runtime.getService().askAiWithSessionContext, 'function');
  });

  it('requires portkey api key and initialized service', () => {
    const runtime = createAiRuntime();
    runtime.setActiveAiProvider('portkey');
    runtime.setActivePortkeyApiKey('');
    assert.equal(runtime.isAiReady(), false);

    runtime.setActivePortkeyApiKey('pk-test-key');
    runtime.initializePortkeyService('pk-test-key', 'gemini-3.8-flash', 'Python', {
      provider: '@vertex'
    });
    assert.equal(runtime.isAiReady(), true);
    assert.equal(runtime.getActiveAiProvider(), 'portkey');
    assert.equal(typeof runtime.getService().askAiWithSessionContext, 'function');
  });
});
