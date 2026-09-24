'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const {
  getAiProviders,
  getGeminiModels,
  getDefaultGeminiFallbackModel,
  getGeminiMemoryModel,
  resolveAiProvider,
  resolveThinkingLevel,
  resolveSttProvider,
  getSttSampleRate,
  resolveWebSearchProvider
} = require('../src/config');

describe('config', () => {
  it('includes Gemini and Portkey providers', () => {
    assert.deepEqual(getAiProviders(), ['gemini', 'portkey']);
  });

  it('exposes current flash models without regular 3.5 flash', () => {
    const models = getGeminiModels();
    assert.ok(models.includes('gemini-3.8-flash'));
    assert.ok(models.includes('gemini-3.7-flash'));
    assert.ok(models.includes('gemini-3.5-flash-lite'));
    assert.equal(models.includes('gemini-3.5-flash'), false);
    assert.equal(getDefaultGeminiFallbackModel(), 'gemini-3.7-flash');
    assert.equal(getGeminiMemoryModel(), 'gemini-3.5-flash-lite');
  });

  it('resolves providers and thinking levels with safe fallbacks', () => {
    assert.equal(resolveAiProvider('portkey'), 'portkey');
    assert.equal(resolveAiProvider('nope'), 'gemini');
    assert.equal(resolveThinkingLevel('low'), 'low');
    assert.equal(resolveThinkingLevel('nope', 'minimal'), 'minimal');
  });

  it('maps STT sample rates and search providers', () => {
    assert.equal(resolveSttProvider('openai'), 'openai');
    assert.equal(getSttSampleRate('assemblyai'), 16000);
    assert.equal(getSttSampleRate('openai'), 24000);
    assert.equal(resolveWebSearchProvider('tavily'), 'tavily');
  });
});
