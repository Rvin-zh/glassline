'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const GeminiService = require('../src/services/ai/gemini-service');
const PortkeyService = require('../src/services/ai/portkey-service');

async function* failingGeminiStream(error) {
  yield { text: 'partial gemini response' };
  throw error;
}

async function* failingPortkeyStream(error) {
  yield {
    choices: [
      {
        delta: {
          content: 'partial portkey response'
        }
      }
    ]
  };
  throw error;
}

describe('AI adapter partial-stream errors', () => {
  it('marks Gemini errors after the first emitted chunk', async () => {
    const failure = Object.assign(new Error('gemini stream failed'), { status: 503 });
    const service = new GeminiService('gemini-test-key', {
      modelName: 'gemini-3.8-flash',
      minRequestInterval: 0
    });
    const chunks = [];
    service.client = {
      models: {
        generateContentStream: async () => failingGeminiStream(failure)
      }
    };

    await assert.rejects(
      service.generateText('hello', {
        onChunk: (chunk) => chunks.push(chunk.text)
      }),
      (error) => {
        assert.equal(error, failure);
        assert.equal(error.partialResponseStarted, true);
        return true;
      }
    );

    assert.deepEqual(chunks, ['partial gemini response']);
  });

  it('marks Portkey errors after the first emitted chunk', async () => {
    const failure = Object.assign(new Error('portkey stream failed'), { status: 503 });
    const service = new PortkeyService({
      apiKey: 'portkey-test-key',
      modelName: 'gemini-3.8-flash',
      provider: '@vertex',
      minRequestInterval: 0
    });
    const chunks = [];
    service.client = {
      chat: {
        completions: {
          create: async () => failingPortkeyStream(failure)
        }
      }
    };

    await assert.rejects(
      service.generateText('hello', {
        onChunk: (chunk) => chunks.push(chunk.text)
      }),
      (error) => {
        assert.equal(error, failure);
        assert.equal(error.partialResponseStarted, true);
        return true;
      }
    );

    assert.deepEqual(chunks, ['partial portkey response']);
  });
});
