'use strict';

const { GoogleGenAI } = require('@google/genai');
const PortkeyModule = require('portkey-ai');
const {
  getDefaultPortkeyProvider,
  getGeminiMemoryModel
} = require('../../config');

const Portkey = PortkeyModule.default || PortkeyModule.Portkey || PortkeyModule;
const MEMORY_MODEL = getGeminiMemoryModel();
const MEMORY_TEMPERATURE = 0.2;
const MEMORY_THINKING_LEVEL = 'minimal';

function normalizeConfiguration(current = {}, updates = {}) {
  const provider = String(
    updates.provider ?? current.provider ?? 'gemini'
  ).trim().toLowerCase() === 'portkey'
    ? 'portkey'
    : 'gemini';

  return Object.freeze({
    provider,
    geminiApiKey: String(
      updates.geminiApiKey ?? current.geminiApiKey ?? ''
    ).trim(),
    portkeyApiKey: String(
      updates.portkeyApiKey ?? current.portkeyApiKey ?? ''
    ).trim(),
    portkeyProvider: String(
      updates.portkeyProvider
        ?? current.portkeyProvider
        ?? getDefaultPortkeyProvider()
    ).trim() || getDefaultPortkeyProvider(),
    portkeyBaseUrl: String(
      updates.portkeyBaseUrl ?? current.portkeyBaseUrl ?? ''
    ).trim().replace(/\/+$/, ''),
    model: MEMORY_MODEL
  });
}

function isSnapshotReady(snapshot) {
  if (snapshot.provider === 'portkey') {
    return Boolean(snapshot.portkeyApiKey && snapshot.portkeyProvider);
  }
  return Boolean(snapshot.geminiApiKey);
}

function classifyBackgroundMemoryError(error) {
  if (error?.memoryErrorCategory) {
    return error.memoryErrorCategory;
  }

  const status = Number(error?.status || error?.statusCode || error?.response?.status);
  const message = String(error?.message || '').toLowerCase();

  if (
    status === 401
    || status === 403
    || message.includes('unauthorized')
    || message.includes('forbidden')
    || message.includes('api key')
    || message.includes('credential')
  ) {
    return 'authentication';
  }
  if (
    status === 429
    || message.includes('quota')
    || message.includes('rate limit')
    || message.includes('too many requests')
  ) {
    return 'quota';
  }
  if (
    status >= 500
    || message.includes('timeout')
    || message.includes('timed out')
    || message.includes('network')
    || message.includes('econn')
    || message.includes('socket')
  ) {
    return 'transient';
  }
  if (error instanceof SyntaxError || message.includes('invalid json')) {
    return 'invalid-response';
  }
  if (
    error?.code === 'MEMORY_NOT_CONFIGURED'
    || message.includes('not configured')
  ) {
    return 'configuration';
  }
  return 'unknown';
}

function createPublicError(category) {
  const error = new Error(`Background memory generation failed (${category})`);
  error.code = 'BACKGROUND_MEMORY_GENERATION_FAILED';
  error.memoryErrorCategory = category;
  return error;
}

function parseJsonResponse(value) {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    return value;
  }

  const text = String(value || '').trim();
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  try {
    const parsed = JSON.parse(fenced ? fenced[1].trim() : text);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new SyntaxError('Invalid JSON response object');
    }
    return parsed;
  } catch {
    const error = new SyntaxError('Invalid JSON response');
    error.memoryErrorCategory = 'invalid-response';
    throw error;
  }
}

function readGeminiText(response) {
  if (typeof response?.text === 'string') {
    return response.text;
  }
  if (typeof response?.response?.text === 'function') {
    return response.response.text();
  }
  return response;
}

function readPortkeyText(response) {
  return response?.choices?.[0]?.message?.content;
}

function createBackgroundMemoryGenerator(options = {}) {
  const createGeminiClient = typeof options.createGeminiClient === 'function'
    ? options.createGeminiClient
    : (configuration) => new GoogleGenAI(configuration);
  const createPortkeyClient = typeof options.createPortkeyClient === 'function'
    ? options.createPortkeyClient
    : (configuration) => new Portkey(configuration);

  let configuration = normalizeConfiguration({}, options);
  let queue = Promise.resolve();
  let queueDepth = 0;
  let busy = false;
  let lastSuccessAt = null;
  let lastErrorCategory = null;
  let lastErrorAt = null;

  function getStatus() {
    return {
      provider: configuration.provider,
      model: MEMORY_MODEL,
      ready: isSnapshotReady(configuration),
      busy,
      queueDepth,
      lastSuccessAt,
      lastErrorCategory,
      lastErrorAt
    };
  }

  function updateConfiguration(updates = {}) {
    configuration = normalizeConfiguration(configuration, updates);
    return getStatus();
  }

  async function execute(snapshot, prompt) {
    busy = true;
    try {
      if (!isSnapshotReady(snapshot)) {
        const error = new Error('Background memory provider is not configured');
        error.code = 'MEMORY_NOT_CONFIGURED';
        throw error;
      }

      let rawResponse;
      if (snapshot.provider === 'portkey') {
        const clientOptions = {
          apiKey: snapshot.portkeyApiKey,
          provider: snapshot.portkeyProvider,
          strictOpenAiCompliance: false
        };
        if (snapshot.portkeyBaseUrl) {
          clientOptions.baseURL = snapshot.portkeyBaseUrl;
        }
        const client = createPortkeyClient(clientOptions);
        const response = await client.chat.completions.create({
          model: MEMORY_MODEL,
          messages: [{ role: 'user', content: prompt }],
          stream: false,
          temperature: MEMORY_TEMPERATURE,
          response_format: { type: 'json_object' },
          thinking: { type: 'enabled', budget_tokens: 256 },
          reasoning: { effort: 'none' }
        });
        rawResponse = readPortkeyText(response);
      } else {
        const client = createGeminiClient({ apiKey: snapshot.geminiApiKey });
        const response = await client.models.generateContent({
          model: MEMORY_MODEL,
          contents: prompt,
          config: {
            temperature: MEMORY_TEMPERATURE,
            responseMimeType: 'application/json',
            thinkingConfig: {
              thinkingLevel: MEMORY_THINKING_LEVEL
            }
          }
        });
        rawResponse = readGeminiText(response);
      }

      const parsed = parseJsonResponse(rawResponse);
      lastSuccessAt = new Date().toISOString();
      lastErrorCategory = null;
      lastErrorAt = null;
      return parsed;
    } catch (error) {
      const category = classifyBackgroundMemoryError(error);
      lastErrorCategory = category;
      lastErrorAt = new Date().toISOString();
      throw createPublicError(category);
    } finally {
      queueDepth -= 1;
      busy = queueDepth > 0;
    }
  }

  function generateText(prompt) {
    const snapshot = configuration;
    const promptSnapshot = String(prompt || '');
    queueDepth += 1;
    const execution = queue.then(() => execute(snapshot, promptSnapshot));
    queue = execution.then(
      () => undefined,
      () => undefined
    );
    return execution;
  }

  return {
    generateText,
    updateConfiguration,
    getStatus
  };
}

module.exports = {
  MEMORY_MODEL,
  MEMORY_TEMPERATURE,
  MEMORY_THINKING_LEVEL,
  classifyBackgroundMemoryError,
  parseJsonResponse,
  createBackgroundMemoryGenerator
};
