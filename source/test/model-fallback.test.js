'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const { createAiRuntime } = require('../src/main-process/features/assistant/gemini-runtime');

const PRIMARY_MODEL = 'gemini-3.8-flash';
const FALLBACK_MODEL = 'gemini-3.7-flash';
const ALTERNATE_MODEL = 'gemini-3.5-flash-lite';

function createDeferred() {
  let resolve;
  let reject;
  const promise = new Promise((promiseResolve, promiseReject) => {
    resolve = promiseResolve;
    reject = promiseReject;
  });

  return { promise, resolve, reject };
}

function createRuntime(provider, model = PRIMARY_MODEL, options = {}) {
  const runtime = createAiRuntime();
  runtime.setActiveAiProvider(provider);
  runtime.setActiveGeminiModel(model);

  if (provider === 'portkey') {
    const apiKey = options.apiKey || 'pk-test-key';
    runtime.setActivePortkeyApiKey(apiKey);
    runtime.initializePortkeyService(apiKey, model, 'Python', {
      provider: '@vertex',
      baseUrl: 'https://portkey.example.invalid'
    });
    return runtime;
  }

  const keys = options.keys || ['gemini-test-key'];
  runtime.setKeys(keys, 0);
  runtime.initializeGeminiService(keys[0], model, 'Python');
  return runtime;
}

function transientError(message = 'model temporarily unavailable') {
  return Object.assign(new Error(message), { status: 503 });
}

function quotaError(message = 'quota exceeded') {
  return Object.assign(new Error(message), { status: 429 });
}

describe('foreground Gemini model fallback', () => {
  it('uses 3.7 once after a transient Portkey 3.8 failure and restores configuration', async () => {
    const runtime = createRuntime('portkey');
    const originalService = runtime.getService();
    originalService.addToHistory('user', 'keep this history');
    const attempts = [];

    const result = await runtime.executeWithKeyFailover(async (service) => {
      attempts.push(service.modelName);
      if (service.modelName === PRIMARY_MODEL) {
        throw transientError();
      }
      return 'fallback response';
    });

    assert.equal(result, 'fallback response');
    assert.deepEqual(attempts, [PRIMARY_MODEL, FALLBACK_MODEL]);
    assert.equal(runtime.getActiveGeminiModel(), PRIMARY_MODEL);
    assert.equal(runtime.getService(), originalService);
    assert.equal(runtime.getService().modelName, PRIMARY_MODEL);
    assert.equal(runtime.getActivePortkeyProvider(), '@vertex');
    assert.equal(runtime.getActivePortkeyBaseUrl(), 'https://portkey.example.invalid');
    assert.deepEqual(runtime.getService().conversationHistory, [
      { role: 'user', content: 'keep this history' }
    ]);

    const diagnostics = runtime.getLastExecutionDiagnostics();
    assert.equal(diagnostics.selectedModel, PRIMARY_MODEL);
    assert.equal(diagnostics.modelUsed, FALLBACK_MODEL);
    assert.equal(diagnostics.fallbackModel, FALLBACK_MODEL);
    assert.equal(diagnostics.fallbackAttempted, true);
    assert.equal(diagnostics.fallbackUsed, true);
    assert.equal(diagnostics.failureCategory, 'transient');
    assert.match(diagnostics.failureTimestamp, /^\d{4}-\d{2}-\d{2}T/);
  });

  it('uses 3.7 once after a transient direct Gemini 3.8 failure', async () => {
    const runtime = createRuntime('gemini');
    const attempts = [];

    const result = await runtime.executeWithKeyFailover(async (service) => {
      attempts.push(service.modelName);
      if (service.modelName === PRIMARY_MODEL) {
        throw transientError();
      }
      return 'direct fallback response';
    });

    assert.equal(result, 'direct fallback response');
    assert.deepEqual(attempts, [PRIMARY_MODEL, FALLBACK_MODEL]);
    assert.equal(runtime.getActiveGeminiModel(), PRIMARY_MODEL);
    assert.equal(runtime.getService().modelName, PRIMARY_MODEL);
  });

  it('uses 3.7 for the standard Gemini named-model 404 response', async () => {
    const runtime = createRuntime('gemini');
    const attempts = [];
    const modelNotFoundError = Object.assign(
      new Error(
        `models/${PRIMARY_MODEL} is not found for API version v1beta, ` +
        'or is not supported for generateContent'
      ),
      { status: 404 }
    );

    const result = await runtime.executeWithKeyFailover(async (service) => {
      attempts.push(service.modelName);
      if (service.modelName === PRIMARY_MODEL) {
        throw modelNotFoundError;
      }
      return '404 fallback response';
    });

    assert.equal(result, '404 fallback response');
    assert.deepEqual(attempts, [PRIMARY_MODEL, FALLBACK_MODEL]);
    assert.equal(runtime.getLastExecutionDiagnostics().failureCategory, 'model-unavailable');
  });

  it('keeps a generic models endpoint 404 unknown without fallback', async () => {
    const runtime = createRuntime('gemini');
    const attempts = [];
    const endpointNotFoundError = Object.assign(
      new Error('The models endpoint was not found'),
      { status: 404 }
    );

    await assert.rejects(
      runtime.executeWithKeyFailover(async (service) => {
        attempts.push(service.modelName);
        throw endpointNotFoundError;
      }),
      (error) => error === endpointNotFoundError
    );

    assert.deepEqual(attempts, [PRIMARY_MODEL]);
    const diagnostics = runtime.getLastExecutionDiagnostics();
    assert.equal(diagnostics.fallbackAttempted, false);
    assert.equal(diagnostics.failureCategory, 'unknown');
  });

  it('uses 3.7 when a 404 names the configured model ID', async () => {
    const runtime = createRuntime('gemini');
    const attempts = [];
    const configuredModelError = Object.assign(
      new Error(`Model ${PRIMARY_MODEL} is not supported by this endpoint`),
      { status: 404 }
    );

    const result = await runtime.executeWithKeyFailover(async (service) => {
      attempts.push(service.modelName);
      if (service.modelName === PRIMARY_MODEL) {
        throw configuredModelError;
      }
      return 'configured-model fallback response';
    });

    assert.equal(result, 'configured-model fallback response');
    assert.deepEqual(attempts, [PRIMARY_MODEL, FALLBACK_MODEL]);
    assert.equal(runtime.getLastExecutionDiagnostics().failureCategory, 'model-unavailable');
  });

  for (const code of ['MODEL_NOT_FOUND', 'MODEL_UNAVAILABLE']) {
    it(`uses 3.7 for structured ${code} without model text`, async () => {
      const runtime = createRuntime('gemini');
      const attempts = [];
      const structuredModelError = Object.assign(new Error('request failed'), { code });

      const result = await runtime.executeWithKeyFailover(async (service) => {
        attempts.push(service.modelName);
        if (service.modelName === PRIMARY_MODEL) {
          throw structuredModelError;
        }
        return 'structured-code fallback response';
      });

      assert.equal(result, 'structured-code fallback response');
      assert.deepEqual(attempts, [PRIMARY_MODEL, FALLBACK_MODEL]);
      assert.equal(runtime.getLastExecutionDiagnostics().failureCategory, 'model-unavailable');
    });
  }

  it('does not model-fallback for an unrelated 404 response', async () => {
    const runtime = createRuntime('gemini');
    const attempts = [];
    const unrelatedNotFoundError = Object.assign(
      new Error('Requested application route was not found'),
      { status: 404 }
    );

    await assert.rejects(
      runtime.executeWithKeyFailover(async (service) => {
        attempts.push(service.modelName);
        throw unrelatedNotFoundError;
      }),
      (error) => error === unrelatedNotFoundError
    );

    assert.deepEqual(attempts, [PRIMARY_MODEL]);
    const diagnostics = runtime.getLastExecutionDiagnostics();
    assert.equal(diagnostics.fallbackAttempted, false);
    assert.equal(diagnostics.failureCategory, 'unknown');
  });

  it('uses 3.7 for a named-model not-allowed failure even when the status is 403', async () => {
    const runtime = createRuntime('portkey');
    const attempts = [];

    const result = await runtime.executeWithKeyFailover(async (service) => {
      attempts.push(service.modelName);
      if (service.modelName === PRIMARY_MODEL) {
        throw Object.assign(new Error(`Model ${PRIMARY_MODEL} is not allowed for this route`), {
          status: 403
        });
      }
      return 'allowed fallback response';
    });

    assert.equal(result, 'allowed fallback response');
    assert.deepEqual(attempts, [PRIMARY_MODEL, FALLBACK_MODEL]);
    assert.equal(runtime.getLastExecutionDiagnostics().failureCategory, 'model-unavailable');
  });

  it('classifies a generic API-key 403 as authentication without model fallback', async () => {
    const runtime = createRuntime('gemini', PRIMARY_MODEL, {
      keys: ['gemini-test-key-a', 'gemini-test-key-b']
    });
    const attempts = [];
    const authenticationError = Object.assign(
      new Error('API key is not allowed to access this resource'),
      { status: 403 }
    );

    await assert.rejects(
      runtime.executeWithKeyFailover(async (service, context) => {
        attempts.push([service.modelName, context.activeApiKeyIndex]);
        throw authenticationError;
      }),
      (error) => runtime.isAllKeysUnavailableError(error)
    );

    assert.deepEqual(attempts, [
      [PRIMARY_MODEL, 0],
      [PRIMARY_MODEL, 1]
    ]);
    const diagnostics = runtime.getLastExecutionDiagnostics();
    assert.equal(diagnostics.fallbackAttempted, false);
    assert.equal(diagnostics.fallbackUsed, false);
    assert.equal(diagnostics.failureCategory, 'authentication');
  });

  it('recognizes a model-specific error code without relying on its message', async () => {
    const runtime = createRuntime('portkey');
    const attempts = [];

    const result = await runtime.executeWithKeyFailover(async (service) => {
      attempts.push(service.modelName);
      if (service.modelName === PRIMARY_MODEL) {
        throw Object.assign(new Error('request failed'), {
          code: 'MODEL_NOT_ALLOWED',
          status: 403
        });
      }
      return 'coded fallback response';
    });

    assert.equal(result, 'coded fallback response');
    assert.deepEqual(attempts, [PRIMARY_MODEL, FALLBACK_MODEL]);
    assert.equal(runtime.getLastExecutionDiagnostics().failureCategory, 'model-unavailable');
  });

  it('rotates direct Gemini keys within each quota-bound model', async () => {
    const runtime = createRuntime('gemini', PRIMARY_MODEL, {
      keys: ['gemini-test-key-a', 'gemini-test-key-b']
    });
    const attempts = [];

    const result = await runtime.executeWithKeyFailover(async (service, context) => {
      attempts.push([service.modelName, context.activeApiKeyIndex]);
      if (service.modelName === PRIMARY_MODEL || context.activeApiKeyIndex === 0) {
        throw quotaError();
      }
      return 'second fallback key worked';
    });

    assert.equal(result, 'second fallback key worked');
    assert.deepEqual(attempts, [
      [PRIMARY_MODEL, 0],
      [PRIMARY_MODEL, 1],
      [FALLBACK_MODEL, 0],
      [FALLBACK_MODEL, 1]
    ]);
    assert.equal(runtime.getActiveApiKeyIndex(), 1);
    assert.equal(runtime.getActiveGeminiModel(), PRIMARY_MODEL);
    assert.equal(runtime.getService().modelName, PRIMARY_MODEL);
  });

  it('does not model-fallback after authentication exhaustion', async () => {
    const runtime = createRuntime('gemini', PRIMARY_MODEL, {
      keys: ['gemini-test-key-a', 'gemini-test-key-b']
    });
    const attempts = [];
    const authenticationError = Object.assign(
      new Error('API key not valid: AUTH_FAILURE_MARKER'),
      { status: 401 }
    );

    await assert.rejects(
      runtime.executeWithKeyFailover(async (service, context) => {
        attempts.push([service.modelName, context.activeApiKeyIndex]);
        throw authenticationError;
      }),
      (error) => runtime.isAllKeysUnavailableError(error)
    );

    assert.deepEqual(attempts, [
      [PRIMARY_MODEL, 0],
      [PRIMARY_MODEL, 1]
    ]);
    const diagnostics = runtime.getLastExecutionDiagnostics();
    assert.equal(diagnostics.fallbackAttempted, false);
    assert.equal(diagnostics.fallbackUsed, false);
    assert.equal(diagnostics.failureCategory, 'authentication');
  });

  it('does not model-fallback for a configuration failure', async () => {
    const runtime = createRuntime('portkey');
    const attempts = [];
    const configurationError = new Error(
      'Portkey service is not ready. Configure an API key in Settings.'
    );

    await assert.rejects(
      runtime.executeWithKeyFailover(async (service) => {
        attempts.push(service.modelName);
        throw configurationError;
      }),
      (error) => error === configurationError
    );

    assert.deepEqual(attempts, [PRIMARY_MODEL]);
    const diagnostics = runtime.getLastExecutionDiagnostics();
    assert.equal(diagnostics.fallbackAttempted, false);
    assert.equal(diagnostics.failureCategory, 'configuration');
  });

  it('does not model-fallback after a partial streaming response', async () => {
    const runtime = createRuntime('portkey');
    const attempts = [];
    const partialError = Object.assign(transientError(), {
      partialResponseStarted: true
    });

    await assert.rejects(
      runtime.executeWithKeyFailover(async (service) => {
        attempts.push(service.modelName);
        throw partialError;
      }),
      (error) => error === partialError
    );

    assert.deepEqual(attempts, [PRIMARY_MODEL]);
    assert.equal(runtime.getService().modelName, PRIMARY_MODEL);
    const diagnostics = runtime.getLastExecutionDiagnostics();
    assert.equal(diagnostics.fallbackAttempted, false);
    assert.equal(diagnostics.failureCategory, 'partial-response');
  });

  it('does not model-fallback when 3.7 is selected', async () => {
    const runtime = createRuntime('portkey', FALLBACK_MODEL);
    const attempts = [];

    await assert.rejects(
      runtime.executeWithKeyFailover(async (service) => {
        attempts.push(service.modelName);
        throw transientError();
      }),
      /unavailable/
    );

    assert.deepEqual(attempts, [FALLBACK_MODEL]);
    assert.equal(runtime.getActiveGeminiModel(), FALLBACK_MODEL);
    assert.equal(runtime.getService().modelName, FALLBACK_MODEL);
    assert.equal(runtime.getLastExecutionDiagnostics().fallbackAttempted, false);
  });

  it('restores 3.8 after fallback failure and stores only sanitized diagnostics', async () => {
    const runtime = createRuntime('portkey', PRIMARY_MODEL, {
      apiKey: 'PORTKEY_DIAGNOSTIC_SECRET'
    });
    const attempts = [];

    await assert.rejects(
      runtime.executeWithKeyFailover(async (service) => {
        attempts.push(service.modelName);
        throw transientError(
          service.modelName === PRIMARY_MODEL
            ? 'PRIMARY_ERROR_MESSAGE PORTKEY_DIAGNOSTIC_SECRET'
            : 'FALLBACK_ERROR_MESSAGE PORTKEY_DIAGNOSTIC_SECRET'
        );
      }),
      /FALLBACK_ERROR_MESSAGE/
    );

    assert.deepEqual(attempts, [PRIMARY_MODEL, FALLBACK_MODEL]);
    assert.equal(runtime.getActiveGeminiModel(), PRIMARY_MODEL);
    assert.equal(runtime.getService().modelName, PRIMARY_MODEL);

    const diagnostics = runtime.getLastExecutionDiagnostics();
    assert.equal(diagnostics.selectedModel, PRIMARY_MODEL);
    assert.equal(diagnostics.modelUsed, FALLBACK_MODEL);
    assert.equal(diagnostics.fallbackAttempted, true);
    assert.equal(diagnostics.fallbackUsed, false);
    assert.equal(diagnostics.failureCategory, 'transient');
    assert.match(diagnostics.failureTimestamp, /^\d{4}-\d{2}-\d{2}T/);

    const serialized = JSON.stringify(diagnostics);
    assert.equal(serialized.includes('PRIMARY_ERROR_MESSAGE'), false);
    assert.equal(serialized.includes('FALLBACK_ERROR_MESSAGE'), false);
    assert.equal(serialized.includes('PORTKEY_DIAGNOSTIC_SECRET'), false);
  });

  it('serializes primary, fallback, restoration, and the next execution', async () => {
    const runtime = createRuntime('portkey');
    const primaryStarted = createDeferred();
    const releasePrimary = createDeferred();
    const attempts = [];
    const contextMismatches = [];

    function recordAttempt(caller, service, context) {
      attempts.push(`${caller}:${service.modelName}`);
      if (context.modelName !== service.modelName) {
        contextMismatches.push({
          caller,
          contextModel: context.modelName,
          serviceModel: service.modelName
        });
      }
    }

    const executionA = runtime.executeWithKeyFailover(async (service, context) => {
      recordAttempt('A', service, context);
      if (service.modelName === PRIMARY_MODEL) {
        primaryStarted.resolve();
        await releasePrimary.promise;
        if (context.modelName !== service.modelName) {
          contextMismatches.push({
            caller: 'A-after-wait',
            contextModel: context.modelName,
            serviceModel: service.modelName
          });
        }
        throw transientError();
      }
      return 'A fallback response';
    });

    await primaryStarted.promise;
    const executionB = runtime.executeWithKeyFailover(async (service, context) => {
      recordAttempt('B', service, context);
      return 'B primary response';
    });

    await Promise.resolve();
    assert.deepEqual(attempts, [`A:${PRIMARY_MODEL}`]);

    releasePrimary.resolve();
    assert.deepEqual(
      await Promise.all([executionA, executionB]),
      ['A fallback response', 'B primary response']
    );
    assert.deepEqual(attempts, [
      `A:${PRIMARY_MODEL}`,
      `A:${FALLBACK_MODEL}`,
      `B:${PRIMARY_MODEL}`
    ]);
    assert.deepEqual(contextMismatches, []);
    assert.equal(runtime.getService().modelName, PRIMARY_MODEL);
  });

  it('serializes direct Gemini key rotation without leaking key context', async () => {
    const runtime = createRuntime('gemini', PRIMARY_MODEL, {
      keys: ['gemini-test-key-a', 'gemini-test-key-b']
    });
    const firstKeyStarted = createDeferred();
    const releaseFirstKey = createDeferred();
    const attempts = [];
    const contextMismatches = [];

    function recordAttempt(caller, service, context) {
      attempts.push(`${caller}:${context.activeApiKeyIndex}`);
      if (
        context.modelName !== service.modelName ||
        context.activeApiKey !== service.adapter.apiKey
      ) {
        contextMismatches.push({
          caller,
          contextModel: context.modelName,
          serviceModel: service.modelName,
          contextKeyIndex: context.activeApiKeyIndex
        });
      }
    }

    const executionA = runtime.executeWithKeyFailover(async (service, context) => {
      recordAttempt('A', service, context);
      if (context.activeApiKeyIndex === 0) {
        firstKeyStarted.resolve();
        await releaseFirstKey.promise;
        if (context.activeApiKey !== service.adapter.apiKey) {
          contextMismatches.push({
            caller: 'A-after-wait',
            contextKeyIndex: context.activeApiKeyIndex
          });
        }
        throw quotaError();
      }
      return 'A second key response';
    });

    await firstKeyStarted.promise;
    const executionB = runtime.executeWithKeyFailover(async (service, context) => {
      recordAttempt('B', service, context);
      if (context.activeApiKeyIndex === 0) {
        throw quotaError();
      }
      return 'B active key response';
    });

    await Promise.resolve();
    assert.deepEqual(attempts, ['A:0']);

    releaseFirstKey.resolve();
    assert.deepEqual(
      await Promise.all([executionA, executionB]),
      ['A second key response', 'B active key response']
    );
    assert.deepEqual(attempts, ['A:0', 'A:1', 'B:1']);
    assert.deepEqual(contextMismatches, []);
  });

  it('syncs a newer model after direct Gemini key-rotation success', async () => {
    const runtime = createRuntime('gemini', PRIMARY_MODEL, {
      keys: ['gemini-test-key-a', 'gemini-test-key-b']
    });
    const firstKeyStarted = createDeferred();
    const releaseFirstKey = createDeferred();
    const expectedResult = { text: 'second key response' };
    const attempts = [];

    const execution = runtime.executeWithKeyFailover(async (service, context) => {
      attempts.push([service.modelName, context.activeApiKeyIndex]);
      if (context.activeApiKeyIndex === 0) {
        firstKeyStarted.resolve();
        await releaseFirstKey.promise;
        throw quotaError();
      }
      return expectedResult;
    });

    await firstKeyStarted.promise;
    runtime.setActiveGeminiModel(ALTERNATE_MODEL);
    releaseFirstKey.resolve();

    assert.equal(await execution, expectedResult);
    assert.deepEqual(attempts, [
      [PRIMARY_MODEL, 0],
      [PRIMARY_MODEL, 1]
    ]);
    assert.equal(runtime.getActiveGeminiModel(), ALTERNATE_MODEL);
    assert.equal(runtime.getService().modelName, ALTERNATE_MODEL);
    assert.deepEqual(runtime.getLastExecutionDiagnostics(), {
      selectedModel: PRIMARY_MODEL,
      modelUsed: PRIMARY_MODEL,
      fallbackModel: FALLBACK_MODEL,
      fallbackAttempted: false,
      fallbackUsed: false,
      failureCategory: null,
      failureTimestamp: null
    });
  });

  it('syncs a newer model after a direct primary non-fallback failure', async () => {
    const runtime = createRuntime('gemini');
    const primaryStarted = createDeferred();
    const releasePrimary = createDeferred();
    const primaryError = Object.assign(new Error('Malformed request payload'), {
      status: 400
    });

    const execution = runtime.executeWithKeyFailover(async () => {
      primaryStarted.resolve();
      await releasePrimary.promise;
      throw primaryError;
    });
    const rejection = assert.rejects(execution, (error) => error === primaryError);

    await primaryStarted.promise;
    runtime.setActiveGeminiModel(ALTERNATE_MODEL);
    releasePrimary.resolve();
    await rejection;

    assert.equal(runtime.getActiveGeminiModel(), ALTERNATE_MODEL);
    assert.equal(runtime.getService().modelName, ALTERNATE_MODEL);
    const diagnostics = runtime.getLastExecutionDiagnostics();
    assert.equal(diagnostics.selectedModel, PRIMARY_MODEL);
    assert.equal(diagnostics.modelUsed, PRIMARY_MODEL);
    assert.equal(diagnostics.fallbackAttempted, false);
    assert.equal(diagnostics.failureCategory, 'unknown');
    assert.match(diagnostics.failureTimestamp, /^\d{4}-\d{2}-\d{2}T/);
  });

  it('syncs a newer model after Portkey primary success', async () => {
    const runtime = createRuntime('portkey');
    const primaryStarted = createDeferred();
    const releasePrimary = createDeferred();
    const expectedResult = { text: 'Portkey primary response' };

    const execution = runtime.executeWithKeyFailover(async () => {
      primaryStarted.resolve();
      await releasePrimary.promise;
      return expectedResult;
    });

    await primaryStarted.promise;
    runtime.setActiveGeminiModel(ALTERNATE_MODEL);
    releasePrimary.resolve();

    assert.equal(await execution, expectedResult);
    assert.equal(runtime.getActiveGeminiModel(), ALTERNATE_MODEL);
    assert.equal(runtime.getService().modelName, ALTERNATE_MODEL);
    assert.deepEqual(runtime.getLastExecutionDiagnostics(), {
      selectedModel: PRIMARY_MODEL,
      modelUsed: PRIMARY_MODEL,
      fallbackModel: FALLBACK_MODEL,
      fallbackAttempted: false,
      fallbackUsed: false,
      failureCategory: null,
      failureTimestamp: null
    });
  });

  it('continues the execution queue after a caller rejects', async () => {
    const runtime = createRuntime('portkey');
    const firstStarted = createDeferred();
    const releaseFirst = createDeferred();
    const attempts = [];
    const firstError = new Error('invalid configuration for first caller');

    const firstExecution = runtime.executeWithKeyFailover(async () => {
      attempts.push('A');
      firstStarted.resolve();
      await releaseFirst.promise;
      throw firstError;
    });
    const firstRejection = assert.rejects(
      firstExecution,
      (error) => error === firstError
    );

    await firstStarted.promise;
    const secondExecution = runtime.executeWithKeyFailover(async () => {
      attempts.push('B');
      return 'second caller response';
    });

    await Promise.resolve();
    assert.deepEqual(attempts, ['A']);

    releaseFirst.resolve();
    await firstRejection;
    assert.equal(await secondExecution, 'second caller response');
    assert.deepEqual(attempts, ['A', 'B']);
  });

  it('restores the current selection when settings change before fallback', async () => {
    const runtime = createRuntime('portkey');
    const primaryStarted = createDeferred();
    const releasePrimary = createDeferred();
    const attempts = [];

    const execution = runtime.executeWithKeyFailover(async (service) => {
      attempts.push(service.modelName);
      if (service.modelName === PRIMARY_MODEL) {
        primaryStarted.resolve();
        await releasePrimary.promise;
        throw transientError();
      }
      return 'fallback response';
    });

    await primaryStarted.promise;
    runtime.setActiveGeminiModel(ALTERNATE_MODEL);
    runtime.initializePortkeyService(
      'pk-test-key',
      ALTERNATE_MODEL,
      'Python',
      {
        provider: '@vertex',
        baseUrl: 'https://portkey.example.invalid'
      }
    );

    releasePrimary.resolve();
    assert.equal(await execution, 'fallback response');
    assert.deepEqual(attempts, [PRIMARY_MODEL, FALLBACK_MODEL]);
    assert.equal(runtime.getActiveGeminiModel(), ALTERNATE_MODEL);
    assert.equal(runtime.getService().modelName, ALTERNATE_MODEL);
  });

  it('syncs a newer model after fallback failure without replacing its error', async () => {
    const runtime = createRuntime('portkey');
    const primaryStarted = createDeferred();
    const releasePrimary = createDeferred();
    const primaryError = transientError('primary unavailable');
    const fallbackError = transientError('fallback unavailable');
    const attempts = [];

    const execution = runtime.executeWithKeyFailover(async (service) => {
      attempts.push(service.modelName);
      if (service.modelName === PRIMARY_MODEL) {
        primaryStarted.resolve();
        await releasePrimary.promise;
        throw primaryError;
      }
      throw fallbackError;
    });
    const rejection = assert.rejects(execution, (error) => error === fallbackError);

    await primaryStarted.promise;
    runtime.setActiveGeminiModel(ALTERNATE_MODEL);
    releasePrimary.resolve();
    await rejection;

    assert.deepEqual(attempts, [PRIMARY_MODEL, FALLBACK_MODEL]);
    assert.equal(runtime.getActiveGeminiModel(), ALTERNATE_MODEL);
    assert.equal(runtime.getService().modelName, ALTERNATE_MODEL);
    const diagnostics = runtime.getLastExecutionDiagnostics();
    assert.equal(diagnostics.selectedModel, PRIMARY_MODEL);
    assert.equal(diagnostics.modelUsed, FALLBACK_MODEL);
    assert.equal(diagnostics.fallbackAttempted, true);
    assert.equal(diagnostics.fallbackUsed, false);
    assert.equal(diagnostics.failureCategory, 'transient');
  });

  it('snapshots queued selection at start and does not restore over settings changes', async () => {
    const runtime = createRuntime('portkey');
    const fallbackStarted = createDeferred();
    const releaseFallback = createDeferred();
    const attempts = [];
    let fallbackService = null;

    const executionA = runtime.executeWithKeyFailover(async (service, context) => {
      attempts.push(`A:${service.modelName}`);
      if (service.modelName === PRIMARY_MODEL) {
        throw transientError();
      }
      fallbackService = service;
      fallbackStarted.resolve();
      assert.equal(service.cacheSuppressed, true);
      assert.equal(context.cacheSuppressed, true);
      await releaseFallback.promise;
      assert.equal(service.cacheSuppressed, true);
      return 'A fallback response';
    });

    await fallbackStarted.promise;
    const executionB = runtime.executeWithKeyFailover(async (service) => {
      attempts.push(`B:${service.modelName}`);
      return 'B newly selected response';
    });

    runtime.setActiveGeminiModel(ALTERNATE_MODEL);
    runtime.initializePortkeyService(
      'pk-test-key',
      ALTERNATE_MODEL,
      'Python',
      {
        provider: '@vertex',
        baseUrl: 'https://portkey.example.invalid'
      }
    );

    releaseFallback.resolve();
    assert.deepEqual(
      await Promise.all([executionA, executionB]),
      ['A fallback response', 'B newly selected response']
    );
    assert.deepEqual(attempts, [
      `A:${PRIMARY_MODEL}`,
      `A:${FALLBACK_MODEL}`,
      `B:${ALTERNATE_MODEL}`
    ]);
    assert.equal(fallbackService.cacheSuppressed, false);
    assert.equal(runtime.getService().cacheSuppressed, false);
    assert.equal(runtime.getActiveGeminiModel(), ALTERNATE_MODEL);
    assert.equal(runtime.getService().modelName, ALTERNATE_MODEL);
  });

  it('keeps the primary Gemini cache, suppresses it on fallback, and does not leak suppression', async () => {
    const runtime = createRuntime('gemini');
    const adapter = runtime.getService().adapter;
    const requests = [];
    const markerStates = [];
    const primaryCache = 'cachedContents/gemini-3.8-primary';
    const nextCache = 'cachedContents/gemini-3.8-next';
    const pinnedOptions = {
      contextString: 'LIVE_CONTEXT_MARKER',
      resume: 'PINNED_RESUME_MARKER',
      jobDescription: 'PINNED_JOB_MARKER',
      cachedContentName: primaryCache,
      outputFormat: 'detailed'
    };
    let primaryFailuresRemaining = 1;
    let fallbackService = null;

    adapter.maxRetries = 0;
    adapter.waitForRateLimit = async () => {};
    adapter.client = {
      models: {
        async generateContent(request) {
          requests.push(request);
          if (request.model === PRIMARY_MODEL && primaryFailuresRemaining > 0) {
            primaryFailuresRemaining -= 1;
            throw transientError('primary Gemini request unavailable');
          }
          return { text: `response from ${request.model}` };
        }
      }
    };

    const result = await runtime.executeWithKeyFailover(async (service, context) => {
      markerStates.push({
        model: service.modelName,
        provider: context.provider,
        isModelFallback: context.isModelFallback,
        serviceCacheSuppressed: service.cacheSuppressed,
        contextCacheSuppressed: context.cacheSuppressed
      });
      if (service.modelName === FALLBACK_MODEL) {
        fallbackService = service;
      }
      return service.askAiWithSessionContext(pinnedOptions);
    });

    assert.equal(result, `response from ${FALLBACK_MODEL}`);
    assert.deepEqual(markerStates, [
      {
        model: PRIMARY_MODEL,
        provider: 'gemini',
        isModelFallback: false,
        serviceCacheSuppressed: false,
        contextCacheSuppressed: false
      },
      {
        model: FALLBACK_MODEL,
        provider: 'gemini',
        isModelFallback: true,
        serviceCacheSuppressed: true,
        contextCacheSuppressed: true
      }
    ]);
    assert.deepEqual(requests.map((request) => request.model), [
      PRIMARY_MODEL,
      FALLBACK_MODEL
    ]);
    assert.equal(requests[0].config.cachedContent, primaryCache);
    assert.equal(requests[0].contents.includes('You are Invisibrain'), false);
    assert.equal(requests[0].contents.includes('PINNED_RESUME_MARKER'), false);
    assert.equal(requests[0].contents.includes('PINNED_JOB_MARKER'), false);
    assert.equal(
      requests[0].contents.split('=== ACTIVE OUTPUT FORMAT: DETAILED ===').length - 1,
      1
    );
    assert.equal(Object.hasOwn(requests[1].config, 'cachedContent'), false);
    assert.equal(requests[1].contents.includes('You are Invisibrain'), true);
    assert.equal(requests[1].contents.includes('PINNED_RESUME_MARKER'), true);
    assert.equal(requests[1].contents.includes('PINNED_JOB_MARKER'), true);
    assert.equal(
      requests[1].contents.split('=== ACTIVE OUTPUT FORMAT: DETAILED ===').length - 1,
      1
    );
    assert.equal(fallbackService.cacheSuppressed, false);
    assert.equal(runtime.getService().cacheSuppressed, false);

    const nextResult = await runtime.executeWithKeyFailover((service, context) => {
      assert.equal(service.cacheSuppressed, false);
      assert.equal(context.cacheSuppressed, false);
      return service.askAiWithSessionContext({
        ...pinnedOptions,
        cachedContentName: nextCache
      });
    });

    assert.equal(nextResult, `response from ${PRIMARY_MODEL}`);
    assert.equal(requests.length, 3);
    assert.equal(requests[2].model, PRIMARY_MODEL);
    assert.equal(requests[2].config.cachedContent, nextCache);
    assert.equal(requests[2].contents.includes('PINNED_RESUME_MARKER'), false);
    assert.equal(requests[2].contents.includes('PINNED_JOB_MARKER'), false);
  });

  it('restores the fallback cache marker after failure', async () => {
    const runtime = createRuntime('gemini');
    const fallbackError = transientError('fallback execution failed');
    let fallbackService = null;

    await assert.rejects(
      runtime.executeWithKeyFailover(async (service, context) => {
        if (service.modelName === PRIMARY_MODEL) {
          assert.equal(service.cacheSuppressed, false);
          assert.equal(context.cacheSuppressed, false);
          throw transientError('primary execution failed');
        }

        fallbackService = service;
        assert.equal(service.cacheSuppressed, true);
        assert.equal(context.cacheSuppressed, true);
        throw fallbackError;
      }),
      (error) => error === fallbackError
    );

    assert.equal(fallbackService.cacheSuppressed, false);
    assert.equal(runtime.getService().cacheSuppressed, false);

    assert.equal(
      await runtime.executeWithKeyFailover((service, context) => {
        assert.equal(service.cacheSuppressed, false);
        assert.equal(context.cacheSuppressed, false);
        return 'next request';
      }),
      'next request'
    );
  });

  it('uses a Portkey Vertex cache only on the primary multimodal request', async () => {
    const runtime = createRuntime('portkey');
    runtime.setKeys(['also-configured-gemini-key'], 0);
    const adapter = runtime.getService().adapter;
    const requests = [];
    const snapshots = [];
    const executionContexts = [];
    const cacheName =
      'projects/safe-project/locations/us-central1/cachedContents/gemini-3.8-portkey';
    const originalCreateRequestSnapshot = adapter._createRequestSnapshot.bind(adapter);

    adapter.maxRetries = 0;
    adapter.waitForRateLimit = async () => {};
    adapter._createRequestSnapshot = (options) => {
      const snapshot = originalCreateRequestSnapshot(options);
      snapshots.push({
        cachedContentName: snapshot.cachedContentName,
        cacheSuppressed: snapshot.cacheSuppressed
      });
      return snapshot;
    };
    adapter.client = {
      chat: {
        completions: {
          async create(request) {
            requests.push(request);
            if (request.model === PRIMARY_MODEL) {
              throw transientError('primary Portkey request unavailable');
            }
            return {
              choices: [
                {
                  message: {
                    content: `response from ${request.model}`
                  }
                }
              ]
            };
          }
        }
      }
    };

    const result = await runtime.executeWithKeyFailover((service, context) => {
      executionContexts.push({
        provider: context.provider,
        modelName: context.modelName,
        isModelFallback: context.isModelFallback
      });
      return service.analyzeScreenshots(
        [{ inlineData: { mimeType: 'image/png', data: 'aW1hZ2U=' } }],
        'SCREEN_CONTEXT_MARKER',
        {
          contextString: 'LIVE_CONTEXT_MARKER',
          resume: 'PORTKEY_PINNED_RESUME_MARKER',
          jobDescription: 'PORTKEY_PINNED_JOB_MARKER',
          cachedContentName: cacheName
        }
      );
    });

    assert.equal(result, `response from ${FALLBACK_MODEL}`);
    assert.deepEqual(requests.map((request) => request.model), [
      PRIMARY_MODEL,
      FALLBACK_MODEL
    ]);
    assert.deepEqual(executionContexts, [
      {
        provider: 'portkey',
        modelName: PRIMARY_MODEL,
        isModelFallback: false
      },
      {
        provider: 'portkey',
        modelName: FALLBACK_MODEL,
        isModelFallback: true
      }
    ]);
    assert.deepEqual(
      snapshots,
      [
        { cachedContentName: cacheName, cacheSuppressed: false },
        { cachedContentName: '', cacheSuppressed: true }
      ]
    );
    const prompts = requests.map((request) => (
      request.messages
        .find((message) => message.role === 'user')
        .content
        .find((part) => part.type === 'text')
        .text
    ));
    assert.equal(prompts[0].includes('You are Invisibrain'), false);
    assert.equal(prompts[0].includes('PORTKEY_PINNED_RESUME_MARKER'), false);
    assert.equal(prompts[0].includes('PORTKEY_PINNED_JOB_MARKER'), false);
    assert.equal(prompts[1].includes('You are Invisibrain'), true);
    assert.equal(prompts[1].includes('PORTKEY_PINNED_RESUME_MARKER'), true);
    assert.equal(prompts[1].includes('PORTKEY_PINNED_JOB_MARKER'), true);
    assert.equal(requests.some((request) => Object.hasOwn(request, 'cachedContentName')), false);
    assert.equal(requests[0].cached_content, cacheName);
    assert.equal(Object.hasOwn(requests[1], 'cached_content'), false);
    assert.equal(runtime.getService().cacheSuppressed, false);
  });

  for (const provider of ['gemini', 'portkey']) {
    it(`keeps actual ${provider} fallback sends on 3.8 then 3.7`, async () => {
      const runtime = createRuntime(provider);
      const adapter = runtime.getService().adapter;
      const rateLimitEntered = createDeferred();
      const releaseRateLimit = createDeferred();
      const fallbackQueued = createDeferred();
      const pendingSends = [];
      const actualModels = [];
      let waitCount = 0;

      adapter.waitForRateLimit = async () => {
        waitCount += 1;
        if (waitCount === 1) {
          rateLimitEntered.resolve();
          await releaseRateLimit.promise;
        }
      };

      if (provider === 'gemini') {
        adapter.client = {
          models: {
            async generateContent(request) {
              actualModels.push(request.model);
              return { text: `response from ${request.model}` };
            }
          }
        };
      } else {
        adapter.client = {
          chat: {
            completions: {
              async create(request) {
                actualModels.push(request.model);
                return {
                  choices: [
                    {
                      message: {
                        content: `response from ${request.model}`
                      }
                    }
                  ]
                };
              }
            }
          }
        };
      }

      const execution = runtime.executeWithKeyFailover(async (service) => {
        const modelAtEnqueue = service.modelName;
        const send = service.generateText(`request for ${modelAtEnqueue}`);
        pendingSends.push(send);

        if (modelAtEnqueue === PRIMARY_MODEL) {
          throw transientError();
        }

        fallbackQueued.resolve();
        return await send;
      });

      await rateLimitEntered.promise;
      await fallbackQueued.promise;
      releaseRateLimit.resolve();

      assert.equal(await execution, `response from ${FALLBACK_MODEL}`);
      await Promise.all(pendingSends);
      assert.deepEqual(actualModels, [PRIMARY_MODEL, FALLBACK_MODEL]);

      const diagnostics = runtime.getLastExecutionDiagnostics();
      assert.equal(diagnostics.selectedModel, PRIMARY_MODEL);
      assert.equal(diagnostics.modelUsed, FALLBACK_MODEL);
      assert.equal(diagnostics.fallbackModel, FALLBACK_MODEL);
      assert.equal(diagnostics.fallbackAttempted, true);
      assert.equal(diagnostics.fallbackUsed, true);
      assert.equal(diagnostics.failureCategory, 'transient');
      assert.match(diagnostics.failureTimestamp, /^\d{4}-\d{2}-\d{2}T/);
    });
  }
});
