'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const GeminiService = require('../src/services/ai/gemini-service');
const PortkeyService = require('../src/services/ai/portkey-service');

const PRIMARY_MODEL = 'gemini-3.8-flash';
const FALLBACK_MODEL = 'gemini-3.7-flash';

function createDeferred() {
  let resolve;
  let reject;
  const promise = new Promise((promiseResolve, promiseReject) => {
    resolve = promiseResolve;
    reject = promiseReject;
  });

  return { promise, resolve, reject };
}

function blockFirstRateLimitWait(service) {
  const entered = createDeferred();
  const release = createDeferred();
  let waitCount = 0;

  service.waitForRateLimit = async () => {
    waitCount += 1;
    if (waitCount === 1) {
      entered.resolve();
      await release.promise;
    }
  };

  return {
    entered: entered.promise,
    release: () => release.resolve()
  };
}

function interceptBackoff(expectedDelay) {
  const originalSetTimeout = global.setTimeout;
  const entered = createDeferred();
  let releaseCallback = null;

  global.setTimeout = (callback, delay, ...args) => {
    if (delay === expectedDelay && releaseCallback === null) {
      releaseCallback = () => callback(...args);
      entered.resolve();
      return {
        ref() {
          return this;
        },
        unref() {
          return this;
        }
      };
    }

    return originalSetTimeout(callback, delay, ...args);
  };

  return {
    entered: entered.promise,
    release() {
      if (releaseCallback) {
        const callback = releaseCallback;
        releaseCallback = null;
        callback();
      }
    },
    restore() {
      global.setTimeout = originalSetTimeout;
    }
  };
}

function createGeminiClient(calls, responseText) {
  return {
    models: {
      async generateContent(request) {
        calls.push(request);
        return { text: responseText };
      }
    }
  };
}

function createPortkeyClient(calls, responseText) {
  return {
    chat: {
      completions: {
        async create(request) {
          calls.push(request);
          return {
            choices: [
              {
                message: {
                  content: responseText
                }
              }
            ]
          };
        }
      }
    }
  };
}

describe('Gemini request configuration snapshots', () => {
  it('keeps queued requests on their original client and defaults, then uses new settings', async () => {
    const oldCalls = [];
    const newCalls = [];
    const service = new GeminiService('old-gemini-key', {
      modelName: PRIMARY_MODEL,
      systemInstruction: 'old system',
      thinkingLevel: 'low',
      webSearchEnabled: true,
      cachedContentName: 'old-cache',
      minRequestInterval: 0
    });
    service.client = createGeminiClient(oldCalls, 'old response');
    const wait = blockFirstRateLimitWait(service);

    const cachedRequest = service.generateText('cached defaults');
    await wait.entered;
    const uncachedRequest = service.generateText('uncached defaults', {
      cachedContentName: ''
    });
    const explicitOptions = {
      systemInstruction: 'explicit system',
      thinkingLevel: 'medium',
      webSearchEnabled: false,
      cachedContentName: ''
    };
    const explicitRequest = service.generateText('explicit options', explicitOptions);

    explicitOptions.systemInstruction = 'mutated explicit system';
    explicitOptions.thinkingLevel = 'high';
    explicitOptions.webSearchEnabled = true;
    explicitOptions.cachedContentName = 'mutated-cache';
    service.updateConfiguration({
      apiKey: '',
      modelName: FALLBACK_MODEL,
      systemInstruction: 'new system',
      thinkingLevel: 'high',
      webSearchEnabled: false,
      cachedContentName: 'new-cache'
    });
    assert.equal(service.isReady(), false);

    wait.release();
    assert.deepEqual(
      await Promise.all([cachedRequest, uncachedRequest, explicitRequest]),
      ['old response', 'old response', 'old response']
    );
    assert.equal(oldCalls.length, 3);
    assert.deepEqual(oldCalls.map((request) => request.model), [
      PRIMARY_MODEL,
      PRIMARY_MODEL,
      PRIMARY_MODEL
    ]);
    assert.deepEqual(oldCalls[0].config, {
      thinkingConfig: { thinkingLevel: 'LOW' },
      tools: [{ googleSearch: {} }],
      cachedContent: 'old-cache'
    });
    assert.deepEqual(oldCalls[1].config, {
      systemInstruction: 'old system',
      thinkingConfig: { thinkingLevel: 'LOW' },
      tools: [{ googleSearch: {} }]
    });
    assert.deepEqual(oldCalls[2].config, {
      systemInstruction: 'explicit system',
      thinkingConfig: { thinkingLevel: 'MEDIUM' }
    });
    assert.equal(newCalls.length, 0);

    service.updateConfiguration({ apiKey: 'new-gemini-key' });
    service.client = createGeminiClient(newCalls, 'new response');
    const cachedNewResponse = await service.generateText('new cached defaults');
    const uncachedNewResponse = await service.generateText('new uncached defaults', {
      cachedContentName: ''
    });

    assert.equal(cachedNewResponse, 'new response');
    assert.equal(uncachedNewResponse, 'new response');
    assert.deepEqual(newCalls.map((request) => request.model), [
      FALLBACK_MODEL,
      FALLBACK_MODEL
    ]);
    assert.deepEqual(newCalls[0].config, {
      thinkingConfig: { thinkingLevel: 'HIGH' },
      cachedContent: 'new-cache'
    });
    assert.deepEqual(newCalls[1].config, {
      systemInstruction: 'new system',
      thinkingConfig: { thinkingLevel: 'HIGH' }
    });
  });

  it('keeps retries on the enqueue-time client and model during backoff', async () => {
    const oldCalls = [];
    const newCalls = [];
    const firstAttemptFailed = createDeferred();
    const service = new GeminiService('old-gemini-key', {
      modelName: PRIMARY_MODEL,
      systemInstruction: 'old retry system',
      thinkingLevel: 'low',
      webSearchEnabled: true,
      minRequestInterval: 0
    });
    service.maxRetries = 1;
    service.client = {
      models: {
        async generateContent(request) {
          oldCalls.push(request);
          if (oldCalls.length === 1) {
            firstAttemptFailed.resolve();
            throw new Error('503 temporarily unavailable');
          }
          return { text: 'retry response' };
        }
      }
    };

    const backoff = interceptBackoff(2000);
    try {
      const responsePromise = service.generateText('retry me');
      await firstAttemptFailed.promise;
      await backoff.entered;

      service.updateConfiguration({
        apiKey: '',
        modelName: FALLBACK_MODEL,
        systemInstruction: 'new retry system',
        thinkingLevel: 'high',
        webSearchEnabled: false
      });
      service.client = createGeminiClient(newCalls, 'wrong client response');

      backoff.release();
      assert.equal(await responsePromise, 'retry response');
    } finally {
      backoff.release();
      backoff.restore();
    }

    assert.deepEqual(oldCalls.map((request) => request.model), [
      PRIMARY_MODEL,
      PRIMARY_MODEL
    ]);
    assert.deepEqual(oldCalls[1].config, {
      systemInstruction: 'old retry system',
      thinkingConfig: { thinkingLevel: 'LOW' },
      tools: [{ googleSearch: {} }]
    });
    assert.equal(newCalls.length, 0);
  });
});

describe('Portkey request configuration snapshots', () => {
  it('advertises Vertex cache support and snapshots cached_content at enqueue time', async () => {
    const calls = [];
    const service = new PortkeyService({
      apiKey: 'portkey-cache-key',
      provider: '@vertex',
      baseUrl: 'https://gateway.portkey.invalid/v1',
      modelName: PRIMARY_MODEL,
      minRequestInterval: 0
    });
    service.client = createPortkeyClient(calls, 'cached response');

    const response = service.generateText('live turn only', {
      cachedContentName:
        'projects/safe-project/locations/us-central1/cachedContents/cache-1'
    });
    service.updateConfiguration({
      provider: '@openai',
      modelName: FALLBACK_MODEL
    });

    assert.equal(await response, 'cached response');
    assert.equal(calls.length, 1);
    assert.equal(
      calls[0].cached_content,
      'projects/safe-project/locations/us-central1/cachedContents/cache-1'
    );
    assert.equal(calls[0].model, PRIMARY_MODEL);
    assert.equal(service.capabilities.supportsExplicitCache, false);

    const unsupportedCalls = [];
    service.client = createPortkeyClient(unsupportedCalls, 'uncached response');
    await service.generateText('full prompt', {
      cachedContentName:
        'projects/safe-project/locations/us-central1/cachedContents/cache-2'
    });
    assert.equal(
      Object.hasOwn(unsupportedCalls[0], 'cached_content'),
      false
    );
  });

  it('keeps queued requests on their original client and defaults, then uses new settings', async () => {
    const oldCalls = [];
    const newCalls = [];
    const service = new PortkeyService({
      apiKey: 'old-portkey-key',
      provider: '@old-provider',
      baseUrl: 'https://old.portkey.invalid',
      modelName: PRIMARY_MODEL,
      systemInstruction: 'old system',
      thinkingLevel: 'low',
      webSearchEnabled: true,
      minRequestInterval: 0
    });
    service.client = createPortkeyClient(oldCalls, 'old response');
    const wait = blockFirstRateLimitWait(service);

    const defaultRequest = service.generateText('default options');
    await wait.entered;
    const explicitOptions = {
      systemInstruction: 'explicit system',
      thinkingLevel: 'medium',
      webSearchEnabled: false
    };
    const explicitRequest = service.generateText('explicit options', explicitOptions);

    explicitOptions.systemInstruction = 'mutated explicit system';
    explicitOptions.thinkingLevel = 'high';
    explicitOptions.webSearchEnabled = true;
    service.updateConfiguration({
      apiKey: '',
      provider: '@new-provider',
      baseUrl: 'https://new.portkey.invalid',
      modelName: FALLBACK_MODEL,
      systemInstruction: 'new system',
      thinkingLevel: 'minimal',
      webSearchEnabled: false
    });
    assert.equal(service.isReady(), false);

    wait.release();
    assert.deepEqual(
      await Promise.all([defaultRequest, explicitRequest]),
      ['old response', 'old response']
    );
    assert.equal(oldCalls.length, 2);
    assert.deepEqual(oldCalls.map((request) => request.model), [
      PRIMARY_MODEL,
      PRIMARY_MODEL
    ]);
    assert.deepEqual(oldCalls[0].messages, [
      { role: 'system', content: 'old system' },
      { role: 'user', content: 'default options' }
    ]);
    assert.deepEqual(oldCalls[0].thinking, {
      type: 'enabled',
      budget_tokens: 256
    });
    assert.deepEqual(oldCalls[0].reasoning, { effort: 'low' });
    assert.deepEqual(oldCalls[1].messages, [
      { role: 'system', content: 'explicit system' },
      { role: 'user', content: 'explicit options' }
    ]);
    assert.deepEqual(oldCalls[1].thinking, {
      type: 'enabled',
      budget_tokens: 1024
    });
    assert.deepEqual(oldCalls[1].reasoning, { effort: 'medium' });
    assert.equal(newCalls.length, 0);

    service.updateConfiguration({ apiKey: 'new-portkey-key' });
    service.client = createPortkeyClient(newCalls, 'new response');
    assert.equal(await service.generateText('new defaults'), 'new response');
    assert.equal(newCalls.length, 1);
    assert.equal(newCalls[0].model, FALLBACK_MODEL);
    assert.deepEqual(newCalls[0].messages, [
      { role: 'system', content: 'new system' },
      { role: 'user', content: 'new defaults' }
    ]);
    assert.deepEqual(newCalls[0].thinking, {
      type: 'enabled',
      budget_tokens: 256
    });
    assert.deepEqual(newCalls[0].reasoning, { effort: 'none' });
  });

  it('keeps retries on the enqueue-time client and model during backoff', async () => {
    const oldCalls = [];
    const newCalls = [];
    const firstAttemptFailed = createDeferred();
    const service = new PortkeyService({
      apiKey: 'old-portkey-key',
      provider: '@old-provider',
      baseUrl: 'https://old.portkey.invalid',
      modelName: PRIMARY_MODEL,
      systemInstruction: 'old retry system',
      thinkingLevel: 'low',
      minRequestInterval: 0
    });
    service.maxRetries = 1;
    service.client = {
      chat: {
        completions: {
          async create(request) {
            oldCalls.push(request);
            if (oldCalls.length === 1) {
              firstAttemptFailed.resolve();
              throw new Error('503 temporarily unavailable');
            }
            return {
              choices: [
                {
                  message: {
                    content: 'retry response'
                  }
                }
              ]
            };
          }
        }
      }
    };

    const backoff = interceptBackoff(1000);
    try {
      const responsePromise = service.generateText('retry me');
      await firstAttemptFailed.promise;
      await backoff.entered;

      service.updateConfiguration({
        apiKey: '',
        provider: '@new-provider',
        baseUrl: 'https://new.portkey.invalid',
        modelName: FALLBACK_MODEL,
        systemInstruction: 'new retry system',
        thinkingLevel: 'high'
      });
      service.client = createPortkeyClient(newCalls, 'wrong client response');

      backoff.release();
      assert.equal(await responsePromise, 'retry response');
    } finally {
      backoff.release();
      backoff.restore();
    }

    assert.deepEqual(oldCalls.map((request) => request.model), [
      PRIMARY_MODEL,
      PRIMARY_MODEL
    ]);
    assert.deepEqual(oldCalls[1].messages, [
      { role: 'system', content: 'old retry system' },
      { role: 'user', content: 'retry me' }
    ]);
    assert.deepEqual(oldCalls[1].reasoning, { effort: 'low' });
    assert.equal(newCalls.length, 0);
  });
});
