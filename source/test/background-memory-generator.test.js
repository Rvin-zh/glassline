'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

let backgroundMemoryModule = null;
try {
  backgroundMemoryModule = require('../src/services/ai/background-memory-generator');
} catch {
  // The first TDD run intentionally exercises the missing focused module.
}

const MEMORY_MODEL = 'gemini-3.5-flash-lite';

function getCreateBackgroundMemoryGenerator() {
  assert.ok(
    backgroundMemoryModule,
    'background memory generator module must exist'
  );
  return backgroundMemoryModule.createBackgroundMemoryGenerator;
}

function createSummary(topic = 'Queues') {
  return {
    currentTopic: topic,
    questions: ['How do you handle backpressure?'],
    facts: ['Candidate used a bounded worker pool'],
    candidateExamples: ['Protected a webhook pipeline'],
    strengthsGaps: ['Strong reliability reasoning'],
    commitments: [],
    proposedDurableNotes: [{ text: 'Uses bounded queues for backpressure' }]
  };
}

function createDeferred() {
  let resolve;
  let reject;
  const promise = new Promise((promiseResolve, promiseReject) => {
    resolve = promiseResolve;
    reject = promiseReject;
  });
  return { promise, resolve, reject };
}

function createPortkeyClient(onRequest) {
  return {
    chat: {
      completions: {
        create: onRequest
      }
    }
  };
}

describe('background memory generator', () => {
  it('uses an isolated Portkey client with exact model and minimal JSON settings', async () => {
    const createBackgroundMemoryGenerator = getCreateBackgroundMemoryGenerator();
    const clientConfigurations = [];
    const requests = [];
    const foregroundRuntime = {
      service: { modelName: 'gemini-3.8-flash', requestQueue: ['foreground'] },
      calls: 0
    };
    const originalForeground = structuredClone(foregroundRuntime);

    const generator = createBackgroundMemoryGenerator({
      provider: 'portkey',
      portkeyApiKey: 'memory-portkey-key',
      portkeyProvider: '@vertex',
      portkeyBaseUrl: 'https://memory-gateway.invalid/v1',
      foregroundRuntime,
      createPortkeyClient(configuration) {
        clientConfigurations.push(configuration);
        return createPortkeyClient(async (request) => {
          requests.push(request);
          return {
            choices: [{
              message: { content: JSON.stringify(createSummary()) }
            }]
          };
        });
      }
    });

    const result = await generator.generateText('memory-only prompt');

    assert.deepEqual(result, createSummary());
    assert.deepEqual(clientConfigurations, [{
      apiKey: 'memory-portkey-key',
      provider: '@vertex',
      baseURL: 'https://memory-gateway.invalid/v1',
      strictOpenAiCompliance: false
    }]);
    assert.deepEqual(requests, [{
      model: MEMORY_MODEL,
      messages: [{ role: 'user', content: 'memory-only prompt' }],
      stream: false,
      temperature: 0.2,
      response_format: { type: 'json_object' },
      thinking: { type: 'enabled', budget_tokens: 256 },
      reasoning: { effort: 'none' }
    }]);
    assert.deepEqual(foregroundRuntime, originalForeground);
  });

  it('snapshots Portkey key, provider, and base URL when each job is queued', async () => {
    const createBackgroundMemoryGenerator = getCreateBackgroundMemoryGenerator();
    const firstStarted = createDeferred();
    const releaseFirst = createDeferred();
    const clientConfigurations = [];
    const requestOrder = [];

    const generator = createBackgroundMemoryGenerator({
      provider: 'portkey',
      portkeyApiKey: 'old-key',
      portkeyProvider: '@old',
      portkeyBaseUrl: 'https://old.invalid/v1',
      createPortkeyClient(configuration) {
        clientConfigurations.push(configuration);
        return createPortkeyClient(async (request) => {
          requestOrder.push(request.messages[0].content);
          if (request.messages[0].content === 'first prompt') {
            firstStarted.resolve();
            await releaseFirst.promise;
          }
          return {
            choices: [{
              message: {
                content: JSON.stringify(createSummary(request.messages[0].content))
              }
            }]
          };
        });
      }
    });

    const first = generator.generateText('first prompt');
    await firstStarted.promise;
    generator.updateConfiguration({
      provider: 'portkey',
      portkeyApiKey: 'new-key',
      portkeyProvider: '@new',
      portkeyBaseUrl: 'https://new.invalid/v1',
      model: 'must-not-change-the-memory-model'
    });
    const second = generator.generateText('second prompt');
    releaseFirst.resolve();

    assert.deepEqual(
      (await Promise.all([first, second])).map((summary) => summary.currentTopic),
      ['first prompt', 'second prompt']
    );
    assert.deepEqual(requestOrder, ['first prompt', 'second prompt']);
    assert.deepEqual(clientConfigurations, [
      {
        apiKey: 'old-key',
        provider: '@old',
        baseURL: 'https://old.invalid/v1',
        strictOpenAiCompliance: false
      },
      {
        apiKey: 'new-key',
        provider: '@new',
        baseURL: 'https://new.invalid/v1',
        strictOpenAiCompliance: false
      }
    ]);
    assert.equal(generator.getStatus().model, MEMORY_MODEL);
  });

  it('keeps its queue independent from foreground work', async () => {
    const createBackgroundMemoryGenerator = getCreateBackgroundMemoryGenerator();
    const backgroundStarted = createDeferred();
    const releaseBackground = createDeferred();
    let foregroundCompleted = false;

    const generator = createBackgroundMemoryGenerator({
      provider: 'portkey',
      portkeyApiKey: 'background-key',
      portkeyProvider: '@vertex',
      createPortkeyClient() {
        return createPortkeyClient(async () => {
          backgroundStarted.resolve();
          await releaseBackground.promise;
          return {
            choices: [{
              message: { content: JSON.stringify(createSummary()) }
            }]
          };
        });
      }
    });

    const background = generator.generateText('blocked background prompt');
    await backgroundStarted.promise;
    await Promise.resolve().then(() => {
      foregroundCompleted = true;
    });

    assert.equal(foregroundCompleted, true);
    assert.deepEqual(generator.getStatus(), {
      provider: 'portkey',
      model: MEMORY_MODEL,
      ready: true,
      busy: true,
      queueDepth: 1,
      lastSuccessAt: null,
      lastErrorCategory: null,
      lastErrorAt: null
    });

    releaseBackground.resolve();
    await background;
  });

  it('keeps direct Gemini generation working with existing JSON behavior', async () => {
    const createBackgroundMemoryGenerator = getCreateBackgroundMemoryGenerator();
    const clientConfigurations = [];
    const requests = [];

    const generator = createBackgroundMemoryGenerator({
      provider: 'gemini',
      geminiApiKey: 'direct-gemini-key',
      createGeminiClient(configuration) {
        clientConfigurations.push(configuration);
        return {
          models: {
            async generateContent(request) {
              requests.push(request);
              return { text: JSON.stringify(createSummary('Direct Gemini')) };
            }
          }
        };
      }
    });

    assert.deepEqual(
      await generator.generateText('direct memory prompt'),
      createSummary('Direct Gemini')
    );
    assert.deepEqual(clientConfigurations, [{ apiKey: 'direct-gemini-key' }]);
    assert.deepEqual(requests, [{
      model: MEMORY_MODEL,
      contents: 'direct memory prompt',
      config: {
        temperature: 0.2,
        responseMimeType: 'application/json',
        thinkingConfig: { thinkingLevel: 'minimal' }
      }
    }]);
    assert.equal(generator.getStatus().provider, 'gemini');
    assert.equal(generator.getStatus().ready, true);
  });

  it('reports only categorized failure diagnostics and can recover on the next job', async () => {
    const createBackgroundMemoryGenerator = getCreateBackgroundMemoryGenerator();
    let shouldFail = true;

    const generator = createBackgroundMemoryGenerator({
      provider: 'portkey',
      portkeyApiKey: 'never-expose-this-key',
      portkeyProvider: '@vertex',
      createPortkeyClient() {
        return createPortkeyClient(async () => {
          if (shouldFail) {
            throw Object.assign(
              new Error('401 request included never-expose-this-key and memory-only prompt'),
              { status: 401 }
            );
          }
          return {
            choices: [{
              message: { content: JSON.stringify(createSummary('Recovered')) }
            }]
          };
        });
      }
    });

    await assert.rejects(
      generator.generateText('memory-only prompt'),
      /Background memory generation failed/
    );
    const failedStatus = generator.getStatus();
    assert.equal(failedStatus.lastErrorCategory, 'authentication');
    assert.match(failedStatus.lastErrorAt, /^\d{4}-\d{2}-\d{2}T/);
    assert.equal(JSON.stringify(failedStatus).includes('never-expose'), false);
    assert.equal(JSON.stringify(failedStatus).includes('memory-only prompt'), false);

    shouldFail = false;
    const recovered = await generator.generateText('safe retry');
    assert.equal(recovered.currentTopic, 'Recovered');
    const recoveredStatus = generator.getStatus();
    assert.match(recoveredStatus.lastSuccessAt, /^\d{4}-\d{2}-\d{2}T/);
    assert.equal(recoveredStatus.lastErrorCategory, null);
    assert.equal(recoveredStatus.lastErrorAt, null);
  });

  it('categorizes invalid JSON without retaining response content', async () => {
    const createBackgroundMemoryGenerator = getCreateBackgroundMemoryGenerator();
    const generator = createBackgroundMemoryGenerator({
      provider: 'portkey',
      portkeyApiKey: 'portkey-key',
      portkeyProvider: '@vertex',
      createPortkeyClient() {
        return createPortkeyClient(async () => ({
          choices: [{
            message: { content: 'not JSON and must not enter diagnostics' }
          }]
        }));
      }
    });

    await assert.rejects(
      generator.generateText('prompt must not enter diagnostics'),
      /Background memory generation failed/
    );
    const status = generator.getStatus();
    assert.equal(status.lastErrorCategory, 'invalid-response');
    assert.equal(JSON.stringify(status).includes('not JSON'), false);
    assert.equal(JSON.stringify(status).includes('prompt must'), false);
  });
});
