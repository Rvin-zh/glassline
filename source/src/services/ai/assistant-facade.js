const {
  buildAnswerQuestionPrompt,
  buildAskAiSessionPrompt,
  buildCacheablePromptPrefix,
  buildFollowUpEmailPrompt,
  buildInsightsPrompt,
  buildMeetingNotesPrompt,
  buildScreenshotAnalysisPrompt,
  buildSuggestResponsePrompt
} = require('./prompts');
const { assertAiAdapter } = require('./contracts');

/**
 * Provider-neutral assistant facade.
 * Owns prompt construction + history bookkeeping; adapters only perform I/O.
 */
function createAssistantFacade(adapter) {
  assertAiAdapter(adapter, 'Assistant facade adapter');
  const adapterGenerateText = adapter.generateText.bind(adapter);
  const adapterGenerateMultimodal = adapter.generateMultimodal.bind(adapter);
  let executionContext = Object.freeze({
    provider: adapter.capabilities?.provider || '',
    modelName: adapter.modelName || adapter.model || '',
    isModelFallback: false,
    cacheSuppressed: false
  });

  function isCacheSuppressed() {
    return executionContext.cacheSuppressed === true;
  }

  function canUseExplicitCachedContent() {
    const adapterModel = adapter.modelName || adapter.model || '';
    const providerSupportsCache =
      executionContext.provider === 'gemini' ||
      (
        executionContext.provider === 'portkey' &&
        adapter.capabilities?.supportsExplicitCache === true
      );
    return (
      providerSupportsCache &&
      executionContext.isModelFallback !== true &&
      executionContext.cacheSuppressed !== true &&
      executionContext.modelName === adapterModel
    );
  }

  function requestOptions(options = {}) {
    const cacheSuppressed = isCacheSuppressed();
    return {
      ...options,
      cachedContentName: canUseExplicitCachedContent()
        ? options.cachedContentName
        : '',
      cacheSuppressed
    };
  }

  async function runWithExecutionContext(context = {}, operation) {
    if (typeof operation !== 'function') {
      throw new Error('Assistant facade execution context requires an operation.');
    }

    const previousContext = executionContext;
    executionContext = Object.freeze({
      provider: context.provider || adapter.capabilities?.provider || '',
      modelName: context.modelName || adapter.modelName || adapter.model || '',
      isModelFallback: context.isModelFallback === true,
      cacheSuppressed: context.cacheSuppressed === true
    });

    try {
      return await operation();
    } finally {
      executionContext = previousContext;
    }
  }

  function resolveContextString(options = {}) {
    if (typeof options.contextString === 'string') {
      return options.contextString;
    }
    if (typeof options.contextStringOverride === 'string') {
      return options.contextStringOverride;
    }
    return adapter.getContextString();
  }

  function streamOptions(options = {}) {
    return {
      onChunk: typeof options.onChunk === 'function' ? options.onChunk : null,
      systemInstruction: options.systemInstruction,
      thinkingLevel: options.thinkingLevel,
      webSearchEnabled: options.webSearchEnabled,
      cachedContentName: options.cachedContentName
    };
  }

  function pinnedPromptFields(options = {}) {
    return {
      resume: options.resume || '',
      jobDescription: options.jobDescription || '',
      memorySummary: options.memorySummary || '',
      durableNotes: options.durableNotes || [],
      searchResults: options.searchResults || []
    };
  }

  function outputPromptFields(options = {}) {
    return {
      outputFormat: options.outputFormat,
      customOutputTemplate: options.customOutputTemplate
    };
  }

  /**
   * When explicit provider cached content is attached, omit the byte-identical
   * reusable prefix from the live turn so we do not pay for it twice.
   */
  function maybeStripCachedPrefix(fullPrompt, options = {}) {
    if (!canUseExplicitCachedContent()) {
      return fullPrompt;
    }

    const cacheName = typeof options.cachedContentName === 'string'
      ? options.cachedContentName.trim()
      : '';
    if (!cacheName) {
      return fullPrompt;
    }

    const prefix = buildCacheablePromptPrefix({
      programmingLanguage: adapter.programmingLanguage,
      resume: options.resume || '',
      jobDescription: options.jobDescription || ''
    });

    if (prefix && fullPrompt.startsWith(prefix)) {
      return fullPrompt.slice(prefix.length).replace(/^\n+/, '');
    }

    return fullPrompt;
  }

  function generateText(prompt, options = {}) {
    return adapterGenerateText(prompt, requestOptions(options));
  }

  function generateMultimodal(parts, options = {}) {
    return adapterGenerateMultimodal(parts, requestOptions(options));
  }

  async function analyzeScreenshots(imageParts, additionalContext = '', options = {}) {
    const contextString = resolveContextString(options);
    const prompt = maybeStripCachedPrefix(
      buildScreenshotAnalysisPrompt({
        contextString,
        additionalContext,
        programmingLanguage: adapter.programmingLanguage,
        screenshotCount: Array.isArray(imageParts) ? imageParts.length : 1,
        ...pinnedPromptFields(options),
        ...outputPromptFields(options)
      }),
      options
    );

    let result;
    if (adapter.capabilities?.supportsMultimodal) {
      result = await generateMultimodal(
        [{ text: prompt }, ...imageParts],
        streamOptions(options)
      );
    } else {
      result = await generateText(
        `${prompt}\n\n[Note: ${imageParts.length} screenshot(s) were captured but image analysis requires a vision-capable model. Respond based on the text context provided.]`,
        streamOptions(options)
      );
    }

    adapter.addToHistory('assistant', `Screenshot analysis: ${result}`);
    return result;
  }

  async function analyzeScreenshot(imageBase64, additionalContext = '', options = {}) {
    return analyzeScreenshots(
      [
        {
          inlineData: {
            mimeType: 'image/png',
            data: imageBase64
          }
        }
      ],
      additionalContext,
      options
    );
  }

  async function askAiWithSessionContext(options = {}) {
    const contextString = resolveContextString(options);
    const prompt = maybeStripCachedPrefix(
      buildAskAiSessionPrompt({
        contextString,
        transcriptContext: options.transcriptContext || '',
        sessionSummary: options.sessionSummary || '',
        screenshotCount: options.screenshotCount || 0,
        programmingLanguage: adapter.programmingLanguage,
        mode: options.mode || 'best-next-answer',
        ...pinnedPromptFields(options),
        ...outputPromptFields(options)
      }),
      options
    );

    const result = await generateText(prompt, streamOptions(options));
    adapter.addToHistory('assistant', `Ask AI: ${result}`);
    return result;
  }

  async function askAiWithSessionContextAndScreenshots(imageParts, options = {}) {
    const contextString = resolveContextString(options);
    const prompt = maybeStripCachedPrefix(
      buildAskAiSessionPrompt({
        contextString,
        transcriptContext: options.transcriptContext || '',
        sessionSummary: options.sessionSummary || '',
        screenshotCount: options.screenshotCount || imageParts.length,
        programmingLanguage: adapter.programmingLanguage,
        mode: options.mode || 'best-next-answer',
        ...pinnedPromptFields(options),
        ...outputPromptFields(options)
      }),
      options
    );
    let result;
    if (adapter.capabilities?.supportsMultimodal) {
      result = await generateMultimodal(
        [{ text: prompt }, ...imageParts],
        streamOptions(options)
      );
    } else {
      result = await generateText(
        `${prompt}\n\n[Note: ${imageParts.length} screenshot(s) were captured but image analysis requires a vision-capable model.]`,
        streamOptions(options)
      );
    }

    adapter.addToHistory('assistant', `Ask AI: ${result}`);
    return result;
  }

  async function suggestResponse(context, options = {}) {
    const contextString = resolveContextString(options);
    const prompt = buildSuggestResponsePrompt({
      contextString,
      context,
      programmingLanguage: adapter.programmingLanguage,
      ...outputPromptFields(options)
    });

    return generateText(prompt, streamOptions(options));
  }

  async function generateMeetingNotes(options = {}) {
    const contextString = resolveContextString(options);
    if (!contextString.trim()) {
      return 'No conversation history to summarize.';
    }
    const prompt = buildMeetingNotesPrompt({ contextString });
    return generateText(prompt, streamOptions(options));
  }

  async function generateFollowUpEmail(options = {}) {
    if (!Array.isArray(adapter.conversationHistory) || adapter.conversationHistory.length === 0) {
      return 'No conversation history to create email from.';
    }

    const contextString = adapter.getContextString();
    const prompt = buildFollowUpEmailPrompt({ contextString });
    return generateText(prompt, streamOptions(options));
  }

  async function answerQuestion(question, options = {}) {
    const contextString = adapter.getContextString();
    const prompt = buildAnswerQuestionPrompt({
      contextString,
      question,
      programmingLanguage: adapter.programmingLanguage,
      ...outputPromptFields(options)
    });

    const result = await generateText(prompt, streamOptions(options));
    adapter.addToHistory('user', question);
    adapter.addToHistory('assistant', result);
    return result;
  }

  async function getConversationInsights(options = {}) {
    const contextString = resolveContextString(options);
    if (!contextString.trim()) {
      return 'Not enough conversation data for insights.';
    }
    const prompt = buildInsightsPrompt({ contextString });
    return generateText(prompt, streamOptions(options));
  }

  return {
    adapter,
    get model() {
      return adapter.model || adapter.modelName;
    },
    get modelName() {
      return adapter.modelName || adapter.model;
    },
    get programmingLanguage() {
      return adapter.programmingLanguage;
    },
    get conversationHistory() {
      return adapter.conversationHistory;
    },
    get capabilities() {
      return adapter.capabilities;
    },
    get cacheSuppressed() {
      return isCacheSuppressed();
    },
    // Bind originals so later Object.assign onto an adapter cannot recurse.
    isReady: adapter.isReady.bind(adapter),
    generateText,
    generateMultimodal,
    updateConfiguration: adapter.updateConfiguration.bind(adapter),
    addToHistory: adapter.addToHistory.bind(adapter),
    clearHistory: adapter.clearHistory.bind(adapter),
    getContextString: adapter.getContextString.bind(adapter),
    isQuotaExhaustedError: adapter.isQuotaExhaustedError.bind(adapter),
    isAuthenticationError: adapter.isAuthenticationError.bind(adapter),
    isRetryableError: adapter.isRetryableError.bind(adapter),
    runWithExecutionContext,
    analyzeScreenshots,
    analyzeScreenshot,
    askAiWithSessionContext,
    askAiWithSessionContextAndScreenshots,
    suggestResponse,
    generateMeetingNotes,
    generateFollowUpEmail,
    answerQuestion,
    getConversationInsights
  };
}

module.exports = {
  createAssistantFacade
};
