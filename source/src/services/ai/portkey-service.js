'use strict';

const PortkeyModule = require('portkey-ai');
const Portkey = PortkeyModule.default || PortkeyModule.Portkey || PortkeyModule;
const {
  resolveGeminiModel,
  resolveProgrammingLanguage,
  resolveThinkingLevel,
  getDefaultForegroundThinkingLevel,
  getDefaultPortkeyProvider,
  getDefaultPortkeyBaseUrl,
  thinkingLevelToPortkey
} = require('../../config');

function isVertexProviderSlug(provider) {
  const slug = String(provider || '')
    .trim()
    .replace(/^@/, '')
    .toLowerCase();
  return slug.split(/[-_.]/).includes('vertex');
}

class PortkeyService {
  constructor(options = {}) {
    this.apiKey = String(options.apiKey || '').trim();
    this.provider = String(options.provider || getDefaultPortkeyProvider()).trim() || getDefaultPortkeyProvider();
    this.baseUrl = String(options.baseUrl || getDefaultPortkeyBaseUrl() || '').trim();
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

    this.client = null;
    this.requestQueue = [];
    this.lastRequestTime = 0;
    this.minRequestInterval = Number(options.minRequestInterval) >= 0
      ? Number(options.minRequestInterval)
      : 500;
    this.maxRetries = 3;
    this.isProcessing = false;
    this.conversationHistory = [];
    this.maxHistoryLength = 20;

    this.capabilities = {
      provider: 'portkey',
      supportsMultimodal: true,
      supportsStreaming: true,
      supportsGoogleSearch: false,
      supportsThinkingLevels: true,
      supportsExplicitCache: isVertexProviderSlug(this.provider)
    };

    this._initializeClient();
  }

  _initializeClient() {
    if (!this.apiKey) {
      this.client = null;
      return;
    }

    const clientOptions = {
      apiKey: this.apiKey,
      strictOpenAiCompliance: false
    };

    if (this.provider) {
      // Prefer Model Catalog slug form when user supplies @provider.
      clientOptions.provider = this.provider.startsWith('@')
        ? this.provider
        : this.provider;
    }

    if (this.baseUrl) {
      clientOptions.baseURL = this.baseUrl;
    }

    this.client = new Portkey(clientOptions);
    console.log('Initializing Portkey AI Service with model:', this.modelName);
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
      provider: this.provider,
      baseUrl: this.baseUrl,
      modelName: this.modelName,
      systemInstruction: typeof options.systemInstruction === 'string'
        ? options.systemInstruction
        : this.systemInstruction,
      thinkingLevel,
      webSearchEnabled: options.webSearchEnabled == null
        ? this.webSearchEnabled
        : Boolean(options.webSearchEnabled),
      cachedContentName:
        !cacheSuppressed &&
        isVertexProviderSlug(this.provider) &&
        typeof options.cachedContentName === 'string'
          ? options.cachedContentName.trim()
          : '',
      cacheSuppressed,
      maxRetries: this.maxRetries
    });
  }

  _isRequestSnapshotReady(snapshot) {
    return Boolean(snapshot?.client && snapshot.apiKey && snapshot.modelName);
  }

  updateConfiguration(options = {}) {
    const nextApiKey = String(options.apiKey ?? this.apiKey ?? '').trim();
    const nextProvider = String(options.provider ?? this.provider ?? getDefaultPortkeyProvider()).trim()
      || getDefaultPortkeyProvider();
    const nextBaseUrl = String(options.baseUrl ?? this.baseUrl ?? '').trim();
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

    const apiKeyChanged = nextApiKey !== this.apiKey;
    const providerChanged = nextProvider !== this.provider;
    const baseUrlChanged = nextBaseUrl !== this.baseUrl;
    const modelChanged = nextModelName !== this.modelName;
    const programmingLanguageChanged = nextProgrammingLanguage !== this.programmingLanguage;

    this.apiKey = nextApiKey;
    this.provider = nextProvider;
    this.baseUrl = nextBaseUrl;
    this.modelName = nextModelName;
    this.model = nextModelName;
    this.programmingLanguage = nextProgrammingLanguage;
    this.thinkingLevel = nextThinkingLevel;
    this.systemInstruction = nextSystemInstruction;
    this.webSearchEnabled = nextWebSearchEnabled;
    this.capabilities.supportsExplicitCache = isVertexProviderSlug(this.provider);

    if (apiKeyChanged || providerChanged || baseUrlChanged) {
      this._initializeClient();
    }

    return {
      apiKeyChanged,
      providerChanged,
      baseUrlChanged,
      modelChanged,
      programmingLanguageChanged
    };
  }

  isQuotaExhaustedError(error) {
    const message = String(error?.message || '').toLowerCase();
    return message.includes('quota') || message.includes('rate limit') || message.includes('429');
  }

  isAuthenticationError(error) {
    const message = String(error?.message || '').toLowerCase();
    return (
      message.includes('api key') ||
      message.includes('unauthorized') ||
      message.includes('401') ||
      message.includes('403') ||
      message.includes('forbidden')
    );
  }

  isRetryableError(error) {
    const message = String(error?.message || '');
    return message.includes('429') || message.includes('500') || message.includes('503');
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

  _partsToMessageContent(parts) {
    if (typeof parts === 'string') {
      return parts;
    }

    if (!Array.isArray(parts)) {
      return String(parts || '');
    }

    const content = [];
    for (const part of parts) {
      if (typeof part === 'string') {
        content.push({ type: 'text', text: part });
        continue;
      }
      if (part?.text) {
        content.push({ type: 'text', text: part.text });
        continue;
      }
      if (part?.inlineData?.data) {
        const mime = part.inlineData.mimeType || 'image/png';
        content.push({
          type: 'image_url',
          image_url: {
            url: `data:${mime};base64,${part.inlineData.data}`
          }
        });
      }
    }

    return content.length === 1 && content[0].type === 'text'
      ? content[0].text
      : content;
  }

  _buildMessages(promptOrParts, snapshot) {
    const messages = [];
    const systemInstruction = snapshot.systemInstruction;

    if (systemInstruction) {
      messages.push({ role: 'system', content: systemInstruction });
    }

    messages.push({
      role: 'user',
      content: this._partsToMessageContent(promptOrParts)
    });

    return messages;
  }

  _buildRequestBody(promptOrParts, snapshot, onChunk) {
    const thinkingLevel = thinkingLevelToPortkey(snapshot.thinkingLevel);

    const body = {
      model: snapshot.modelName,
      messages: this._buildMessages(promptOrParts, snapshot),
      stream: typeof onChunk === 'function'
    };

    // Gemini-via-Portkey thinking control (requires strictOpenAiCompliance: false).
    body.thinking = {
      type: 'enabled',
      // Map low/medium/high to a rough budget; Portkey maps to provider thinking.
      budget_tokens: thinkingLevel === 'high' ? 2048 : thinkingLevel === 'medium' ? 1024 : 256
    };

    // Also pass reasoning.effort for Responses-compatible gateways.
    body.reasoning = {
      effort: thinkingLevel === 'minimal' ? 'none' : thinkingLevel
    };

    if (snapshot.cachedContentName) {
      body.cached_content = snapshot.cachedContentName;
    }

    return body;
  }

  async waitForRateLimit() {
    const now = Date.now();
    const elapsed = now - this.lastRequestTime;
    if (this.minRequestInterval > 0 && elapsed < this.minRequestInterval) {
      await new Promise((resolve) => setTimeout(resolve, this.minRequestInterval - elapsed));
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
        request.resolve(await this._executeRequest(request));
      } catch (error) {
        request.reject(error);
      }
    }
    this.isProcessing = false;
  }

  async _executeRequest(request, retryCount = 0) {
    const snapshot = request.snapshot;
    if (!this._isRequestSnapshotReady(snapshot)) {
      throw new Error('Portkey service is not ready. Configure Portkey API key in Settings.');
    }

    try {
      const body = this._buildRequestBody(request.data, snapshot, request.onChunk);

      if (typeof request.onChunk === 'function') {
        const stream = await snapshot.client.chat.completions.create(body);
        let fullText = '';
        let chunkIndex = 0;

        for await (const chunk of stream) {
          const delta = chunk?.choices?.[0]?.delta?.content;
          if (typeof delta === 'string' && delta) {
            fullText += delta;
            chunkIndex += 1;
            request._firstChunkSent = true;
            request.onChunk({ text: delta, index: chunkIndex });
          }
        }

        return fullText;
      }

      const result = await snapshot.client.chat.completions.create(body);
      return String(result?.choices?.[0]?.message?.content || '');
    } catch (error) {
      if (request._firstChunkSent) {
        error.partialResponseStarted = true;
        throw error;
      }

      if (retryCount < snapshot.maxRetries && this.isRetryableError(error)) {
        await new Promise((resolve) => setTimeout(resolve, Math.pow(2, retryCount) * 1000));
        return this._executeRequest(request, retryCount + 1);
      }

      throw error;
    }
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

module.exports = PortkeyService;
module.exports.isVertexProviderSlug = isVertexProviderSlug;
