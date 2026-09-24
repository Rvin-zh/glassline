'use strict';

const { GoogleGenAI } = require('@google/genai');
const {
  getDefaultGeminiModel,
  resolveGeminiModel,
  resolveProgrammingLanguage,
  resolveThinkingLevel,
  getDefaultForegroundThinkingLevel,
  thinkingLevelToGeminiApi
} = require('../../config');

class GeminiService {
  constructor(apiKey, options = {}) {
    this.apiKey = String(apiKey || '').trim();
    this.modelName = resolveGeminiModel(options.modelName);
    this.model = this.modelName;
    this.programmingLanguage = resolveProgrammingLanguage(options.programmingLanguage);
    this.thinkingLevel = resolveThinkingLevel(
      options.thinkingLevel,
      getDefaultForegroundThinkingLevel()
    );
    this.systemInstruction = typeof options.systemInstruction === 'string'
      ? options.systemInstruction
      : '';
    this.webSearchEnabled = Boolean(options.webSearchEnabled);
    this.cachedContentName = typeof options.cachedContentName === 'string'
      ? options.cachedContentName
      : '';

    this.client = null;

    this.requestQueue = [];
    this.lastRequestTime = 0;
    this.minRequestInterval = Number(options.minRequestInterval) >= 0
      ? Number(options.minRequestInterval)
      : 1000;
    this.maxRetries = 3;
    this.isProcessing = false;

    this.dailyTokenCount = 0;
    this.maxDailyTokens = 4000000;
    this.lastResetTime = Date.now();

    this.conversationHistory = [];
    this.maxHistoryLength = 20;

    this.capabilities = {
      provider: 'gemini',
      supportsMultimodal: true,
      supportsStreaming: true,
      supportsGoogleSearch: true,
      supportsThinkingLevels: true
    };

    this._initializeClient();
  }

  _initializeClient() {
    if (!this.apiKey) {
      this.client = null;
      return;
    }

    this.client = new GoogleGenAI({ apiKey: this.apiKey });
    console.log('Initializing Gemini model via @google/genai:', this.modelName);
  }

  isReady() {
    return Boolean(this.client && this.apiKey && this.modelName);
  }

  _createRequestSnapshot(options = {}) {
    const thinkingLevel = resolveThinkingLevel(
      options.thinkingLevel ?? this.thinkingLevel,
      this.thinkingLevel
    );
    const cacheSuppressed = options.cacheSuppressed === true;

    return Object.freeze({
      client: this.client,
      apiKey: this.apiKey,
      modelName: this.modelName,
      systemInstruction: typeof options.systemInstruction === 'string'
        ? options.systemInstruction
        : this.systemInstruction,
      thinkingLevel,
      webSearchEnabled: options.webSearchEnabled == null
        ? this.webSearchEnabled
        : Boolean(options.webSearchEnabled),
      cachedContentName: cacheSuppressed
        ? ''
        : typeof options.cachedContentName === 'string'
          ? options.cachedContentName
          : this.cachedContentName,
      cacheSuppressed,
      maxRetries: this.maxRetries
    });
  }

  _isRequestSnapshotReady(snapshot) {
    return Boolean(snapshot?.client && snapshot.apiKey && snapshot.modelName);
  }

  updateConfiguration(options = {}) {
    const previousProgrammingLanguage = this.programmingLanguage;
    const nextApiKey = String(options.apiKey ?? this.apiKey ?? '').trim();
    const nextModelName = resolveGeminiModel(options.modelName ?? this.modelName);
    const nextProgrammingLanguage = resolveProgrammingLanguage(
      options.programmingLanguage ?? this.programmingLanguage
    );
    const nextThinkingLevel = resolveThinkingLevel(
      options.thinkingLevel ?? this.thinkingLevel,
      this.thinkingLevel
    );
    const nextSystemInstruction = typeof options.systemInstruction === 'string'
      ? options.systemInstruction
      : this.systemInstruction;
    const nextWebSearchEnabled = options.webSearchEnabled == null
      ? this.webSearchEnabled
      : Boolean(options.webSearchEnabled);
    const nextCachedContentName = typeof options.cachedContentName === 'string'
      ? options.cachedContentName
      : this.cachedContentName;

    const apiKeyChanged = nextApiKey !== this.apiKey;
    const modelChanged = nextModelName !== this.modelName;
    const programmingLanguageChanged = nextProgrammingLanguage !== previousProgrammingLanguage;
    const thinkingChanged = nextThinkingLevel !== this.thinkingLevel;
    const systemChanged = nextSystemInstruction !== this.systemInstruction;
    const searchChanged = nextWebSearchEnabled !== this.webSearchEnabled;
    const cacheChanged = nextCachedContentName !== this.cachedContentName;

    if (apiKeyChanged) {
      this.apiKey = nextApiKey;
      this._initializeClient();
    }

    this.modelName = nextModelName;
    this.model = nextModelName;
    this.programmingLanguage = nextProgrammingLanguage;
    this.thinkingLevel = nextThinkingLevel;
    this.systemInstruction = nextSystemInstruction;
    this.webSearchEnabled = nextWebSearchEnabled;
    this.cachedContentName = nextCachedContentName;

    return {
      apiKeyChanged,
      modelChanged,
      programmingLanguageChanged,
      thinkingChanged,
      systemChanged,
      searchChanged,
      cacheChanged
    };
  }

  checkAndResetDailyLimit() {
    const now = Date.now();
    const dayInMs = 24 * 60 * 60 * 1000;

    if (now - this.lastResetTime >= dayInMs) {
      console.log('Resetting daily token count');
      this.dailyTokenCount = 0;
      this.lastResetTime = now;
    }
  }

  estimateTokens(text) {
    return Math.ceil(String(text || '').length / 4);
  }

  isQuotaExhaustedError(error) {
    const message = String(error?.message || '').toLowerCase();
    return (
      message.includes('quota exceeded') ||
      message.includes('exceeded your current quota') ||
      message.includes('resource_exhausted') ||
      message.includes('generate_content_free_tier_requests') ||
      message.includes('daily request limit')
    );
  }

  isAuthenticationError(error) {
    const message = String(error?.message || '').toLowerCase();
    return (
      message.includes('api key not valid') ||
      message.includes('invalid api key') ||
      message.includes('api_key_invalid') ||
      message.includes('401') ||
      message.includes('403') ||
      message.includes('permission denied') ||
      message.includes('unauthorized') ||
      message.includes('forbidden')
    );
  }

  isRetryableError(error) {
    const message = String(error?.message || '');
    return (
      message.includes('429') ||
      message.includes('500') ||
      message.includes('503') ||
      message.includes('RATE_LIMIT') ||
      message.includes('unavailable')
    );
  }

  async waitForRateLimit() {
    const now = Date.now();
    const timeSinceLastRequest = now - this.lastRequestTime;

    if (this.minRequestInterval > 0 && timeSinceLastRequest < this.minRequestInterval) {
      const waitTime = this.minRequestInterval - timeSinceLastRequest;
      await new Promise((resolve) => setTimeout(resolve, waitTime));
    }

    this.lastRequestTime = Date.now();
  }

  async processQueue() {
    if (this.isProcessing || this.requestQueue.length === 0) {
      return;
    }

    this.isProcessing = true;

    while (this.requestQueue.length > 0) {
      const request = this.requestQueue.shift();

      try {
        await this.waitForRateLimit();
        const result = await this._executeRequest(request);
        request.resolve(result);
      } catch (error) {
        request.reject(error);
      }
    }

    this.isProcessing = false;
  }

  _normalizeContents(data) {
    if (typeof data === 'string') {
      return data;
    }

    if (Array.isArray(data)) {
      return data.map((part) => {
        if (typeof part === 'string') {
          return { text: part };
        }
        if (part?.text) {
          return { text: part.text };
        }
        if (part?.inlineData) {
          return {
            inlineData: {
              mimeType: part.inlineData.mimeType || 'image/png',
              data: part.inlineData.data
            }
          };
        }
        return part;
      });
    }

    return data;
  }

  _buildGenerateConfig(snapshot) {
    const config = {};
    const systemInstruction = snapshot.systemInstruction;
    const thinkingLevel = snapshot.thinkingLevel;
    const webSearchEnabled = snapshot.webSearchEnabled;
    const cachedContent = snapshot.cachedContentName;

    if (systemInstruction && !cachedContent) {
      config.systemInstruction = systemInstruction;
    }

    if (thinkingLevel) {
      config.thinkingConfig = {
        thinkingLevel: thinkingLevelToGeminiApi(thinkingLevel)
      };
    }

    if (webSearchEnabled) {
      config.tools = [{ googleSearch: {} }];
    }

    if (cachedContent) {
      config.cachedContent = cachedContent;
    }

    return config;
  }

  _extractTextFromResponse(response) {
    if (!response) {
      return '';
    }

    if (typeof response.text === 'string') {
      return response.text;
    }

    if (typeof response.text === 'function') {
      try {
        return String(response.text() || '');
      } catch (_) {
        // fall through
      }
    }

    const candidates = response.candidates || response.response?.candidates || [];
    const parts = candidates[0]?.content?.parts || [];
    return parts
      .map((part) => (typeof part?.text === 'string' ? part.text : ''))
      .join('');
  }

  async _executeRequest(request, retryCount = 0) {
    const snapshot = request.snapshot;
    if (!this._isRequestSnapshotReady(snapshot)) {
      throw new Error('Gemini service is not ready. Configure an API key and model in Settings.');
    }

    try {
      this.checkAndResetDailyLimit();

      const estimatedTokens = this.estimateTokens(JSON.stringify(request.data));
      if (this.dailyTokenCount + estimatedTokens > this.maxDailyTokens) {
        throw new Error('Daily token limit reached');
      }

      const contents = this._normalizeContents(request.data);
      const config = this._buildGenerateConfig(snapshot);
      const model = snapshot.modelName;

      if (typeof request.onChunk === 'function') {
        console.log(`[Gemini API] Streaming ${request.type} request started`);
        const stream = await snapshot.client.models.generateContentStream({
          model,
          contents,
          config
        });

        let fullText = '';
        let chunkIndex = 0;

        for await (const chunk of stream) {
          const chunkText = this._extractTextFromResponse(chunk);
          if (chunkText) {
            fullText += chunkText;
            chunkIndex += 1;
            request._firstChunkSent = true;
            request.onChunk({ text: chunkText, index: chunkIndex });
          }
        }

        this.dailyTokenCount += this.estimateTokens(fullText);
        console.log(`[Gemini API] Streaming ${request.type} completed (${chunkIndex} chunks, ${fullText.length} chars)`);
        return fullText;
      }

      console.log(`[Gemini API] Non-streaming ${request.type} request started`);
      const result = await snapshot.client.models.generateContent({
        model,
        contents,
        config
      });
      const responseText = this._extractTextFromResponse(result);
      this.dailyTokenCount += estimatedTokens;
      console.log(`[Gemini API] Non-streaming ${request.type} completed (${responseText.length} chars)`);
      return responseText;
    } catch (error) {
      console.error(`Request error (attempt ${retryCount + 1}):`, error.message);

      if (request._firstChunkSent) {
        error.partialResponseStarted = true;
        throw error;
      }

      if (this.isQuotaExhaustedError(error)) {
        throw error;
      }

      if (retryCount < snapshot.maxRetries && this.isRetryableError(error)) {
        const backoffTime = Math.pow(2, retryCount) * 2000;
        await new Promise((resolve) => setTimeout(resolve, backoffTime));
        return this._executeRequest(request, retryCount + 1);
      }

      throw error;
    }
  }

  addToHistory(role, content) {
    this.conversationHistory.push({ role, content });
    if (this.conversationHistory.length > this.maxHistoryLength) {
      this.conversationHistory = this.conversationHistory.slice(-this.maxHistoryLength);
    }
  }

  clearHistory() {
    this.conversationHistory = [];
  }

  getContextString() {
    return this.conversationHistory
      .map((entry) => `${entry.role}: ${entry.content}`)
      .join('\n\n');
  }

  async generateText(prompt, options = {}) {
    const snapshot = this._createRequestSnapshot(options);
    const onChunk = typeof options.onChunk === 'function' ? options.onChunk : null;

    return new Promise((resolve, reject) => {
      this.requestQueue.push({
        type: 'text',
        data: prompt,
        snapshot,
        resolve,
        reject,
        onChunk
      });
      this.processQueue();
    });
  }

  async generateMultimodal(parts, options = {}) {
    const snapshot = this._createRequestSnapshot(options);
    const onChunk = typeof options.onChunk === 'function' ? options.onChunk : null;

    return new Promise((resolve, reject) => {
      this.requestQueue.push({
        type: 'multimodal',
        data: parts,
        snapshot,
        resolve,
        reject,
        onChunk
      });
      this.processQueue();
    });
  }
}

module.exports = GeminiService;
