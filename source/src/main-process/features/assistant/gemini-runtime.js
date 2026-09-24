const GeminiService = require('../../../services/ai/gemini-service');
const PortkeyService = require('../../../services/ai/portkey-service');
const { createAssistantFacade } = require('../../../services/ai/assistant-facade');
const {
  resolveAiProvider,
  getAiProviders,
  getDefaultAiProvider,
  getDefaultPortkeyProvider,
  getDefaultPortkeyBaseUrl,
  resolveGeminiModel,
  resolveProgrammingLanguage,
  getGeminiModels,
  getDefaultGeminiModel,
  getDefaultGeminiFallbackModel,
  getGeminiMemoryModel,
  getProgrammingLanguages,
  getDefaultProgrammingLanguage,
  getDefaultForegroundThinkingLevel,
  resolveThinkingLevel
} = require('../../../config');

const GEMINI_ALL_KEYS_UNAVAILABLE_ERROR_CODE = 'GEMINI_ALL_KEYS_UNAVAILABLE';

function createPortkeyCacheNamespace(provider, baseUrl) {
  return [
    'portkey-vertex-v1',
    String(provider || '').trim(),
    String(baseUrl || '').trim().replace(/\/+$/, '')
  ].join('|');
}

function attachCacheConfigurationAccessor(context, configuration) {
  const snapshot = Object.freeze({ ...configuration });
  Object.defineProperty(context, 'getCacheConfiguration', {
    configurable: false,
    enumerable: false,
    writable: false,
    value: () => snapshot
  });
  return context;
}

function normalizeGeminiApiKeys(keys) {
  const sourceValues = Array.isArray(keys)
    ? keys
    : String(keys ?? '').split(',');
  const seen = new Set();
  const nextKeys = [];

  for (const rawValue of sourceValues) {
    const key = String(rawValue || '').trim();
    if (!key || seen.has(key)) {
      continue;
    }

    seen.add(key);
    nextKeys.push(key);
  }

  return nextKeys;
}

function wrapService(adapter) {
  if (!adapter) {
    return null;
  }

  // Always return a facade proxy object rather than mutating provider adapters.
  return createAssistantFacade(adapter);
}

function createAiRuntime() {
  let geminiService = null;
  let portkeyService = null;
  let activeAiProvider = getDefaultAiProvider();
  let activeGeminiModel = getDefaultGeminiModel();
  let activeProgrammingLanguage = getDefaultProgrammingLanguage();
  let activePortkeyApiKey = '';
  let activePortkeyProvider = getDefaultPortkeyProvider();
  let activePortkeyBaseUrl = getDefaultPortkeyBaseUrl();
  let activeThinkingLevel = getDefaultForegroundThinkingLevel();
  let activeWebSearchEnabled = false;
  let geminiApiKeys = [];
  let activeApiKeyIndex = 0;
  let activeKeyIndexChangeHandler = null;
  let lastExecutionDiagnostics = null;
  let runtimeConfigurationGeneration = 0;
  let executionQueue = Promise.resolve();

  function recordRuntimeConfigurationChange(previousValue, nextValue) {
    if (previousValue !== nextValue) {
      runtimeConfigurationGeneration += 1;
    }
  }

  function sameStringArray(left, right) {
    return left.length === right.length &&
      left.every((value, index) => value === right[index]);
  }

  function notifyActiveKeyIndexChanged(index) {
    if (typeof activeKeyIndexChangeHandler !== 'function') {
      return;
    }

    try {
      activeKeyIndexChangeHandler(index);
    } catch (error) {
      console.error('Failed to persist active Gemini API key index:', error);
    }
  }

  function normalizeKeyIndex(index) {
    if (geminiApiKeys.length === 0) {
      return 0;
    }

    const parsedIndex = Number.parseInt(String(index ?? ''), 10);
    const safeIndex = Number.isFinite(parsedIndex) ? parsedIndex : 0;
    const maxIndex = geminiApiKeys.length - 1;

    return Math.min(Math.max(safeIndex, 0), maxIndex);
  }

  function setActiveApiKeyIndex(index, options = {}) {
    const nextIndex = normalizeKeyIndex(index);
    const shouldNotify = options.notify !== false;
    const changed = nextIndex !== activeApiKeyIndex;
    const previousIndex = activeApiKeyIndex;
    activeApiKeyIndex = nextIndex;

    recordRuntimeConfigurationChange(previousIndex, nextIndex);
    if (changed && shouldNotify) {
      notifyActiveKeyIndexChanged(activeApiKeyIndex);
    }

    return activeApiKeyIndex;
  }

  function getActiveApiKey() {
    if (geminiApiKeys.length === 0) {
      return '';
    }

    return geminiApiKeys[activeApiKeyIndex] || '';
  }

  function hasApiKeys() {
    return geminiApiKeys.length > 0;
  }

  function hasPortkeyApiKey() {
    return Boolean(activePortkeyApiKey);
  }

  function isAiReady() {
    return getService()?.isReady?.() === true;
  }

  function initializeGeminiService(
    apiKey = getActiveApiKey(),
    modelName = activeGeminiModel,
    programmingLanguage = activeProgrammingLanguage
  ) {
    const nextGeminiModel = resolveGeminiModel(modelName);
    const nextProgrammingLanguage = resolveProgrammingLanguage(programmingLanguage);
    recordRuntimeConfigurationChange(activeGeminiModel, nextGeminiModel);
    recordRuntimeConfigurationChange(activeProgrammingLanguage, nextProgrammingLanguage);
    activeGeminiModel = nextGeminiModel;
    activeProgrammingLanguage = nextProgrammingLanguage;

    try {
      if (!apiKey) {
        console.error('Gemini API key not configured in app settings');
        geminiService = null;
        return null;
      }

      console.log(
        'Initializing Gemini AI Service with model and language:',
        activeGeminiModel,
        activeProgrammingLanguage
      );

      const adapterOptions = {
        modelName: activeGeminiModel,
        programmingLanguage: activeProgrammingLanguage,
        thinkingLevel: activeThinkingLevel,
        webSearchEnabled: activeWebSearchEnabled
      };

      if (geminiService) {
        geminiService.updateConfiguration({
          apiKey,
          ...adapterOptions
        });
      } else {
        geminiService = wrapService(new GeminiService(apiKey, adapterOptions));
      }

      console.log('Gemini AI Service initialized successfully');
      return geminiService;
    } catch (error) {
      geminiService = null;
      console.error('Failed to initialize Gemini AI Service:', error);
      return null;
    }
  }

  function setKeys(apiKeys, preferredIndex = 0) {
    const nextKeys = normalizeGeminiApiKeys(apiKeys);
    if (!sameStringArray(geminiApiKeys, nextKeys)) {
      runtimeConfigurationGeneration += 1;
    }
    geminiApiKeys = nextKeys;

    if (!hasApiKeys()) {
      setActiveApiKeyIndex(0);
      geminiService = null;
      return {
        geminiApiKeys: [],
        activeApiKeyIndex: 0,
        activeApiKey: ''
      };
    }

    setActiveApiKeyIndex(preferredIndex);

    return {
      geminiApiKeys: [...geminiApiKeys],
      activeApiKeyIndex,
      activeApiKey: getActiveApiKey()
    };
  }

  function getApiKeys() {
    return [...geminiApiKeys];
  }

  function switchToNextKey() {
    if (!hasApiKeys()) {
      return {
        switched: false,
        activeApiKeyIndex,
        activeApiKey: ''
      };
    }

    if (geminiApiKeys.length === 1) {
      return {
        switched: false,
        activeApiKeyIndex,
        activeApiKey: getActiveApiKey()
      };
    }

    const previousIndex = activeApiKeyIndex;
    const nextIndex = (activeApiKeyIndex + 1) % geminiApiKeys.length;
    setActiveApiKeyIndex(nextIndex);

    if (nextIndex === previousIndex) {
      return {
        switched: false,
        activeApiKeyIndex,
        activeApiKey: getActiveApiKey()
      };
    }

    initializeGeminiService(getActiveApiKey(), activeGeminiModel, activeProgrammingLanguage);

    return {
      switched: true,
      activeApiKeyIndex,
      activeApiKey: getActiveApiKey()
    };
  }

  function getErrorChain(error) {
    const chain = [];
    const seen = new Set();
    let current = error;

    while (current && !seen.has(current) && chain.length < 5) {
      chain.push(current);
      seen.add(current);
      current = current.cause;
    }

    return chain;
  }

  function getErrorStatuses(error) {
    const statuses = [];

    for (const entry of getErrorChain(error)) {
      for (const candidate of [
        entry?.status,
        entry?.statusCode,
        entry?.response?.status,
        entry?.code
      ]) {
        if (Number.isInteger(candidate)) {
          statuses.push(candidate);
          continue;
        }

        const match = String(candidate || '').match(/(?:^|\D)([45]\d{2})(?:\D|$)/);
        if (match) {
          statuses.push(Number.parseInt(match[1], 10));
        }
      }
    }

    return statuses;
  }

  function classifyExecutionFailure(error, service) {
    if (!error) {
      return 'unknown';
    }

    if (getErrorChain(error).some((entry) => (
      entry?.code === 'AI_CONTEXT_CHANGED' &&
      entry?.cancelled === true
    ))) {
      return 'cancelled';
    }

    if (getErrorChain(error).some((entry) => entry?.partialResponseStarted === true)) {
      return 'partial-response';
    }

    const aggregateCategories = Array.isArray(error.failureCategories)
      ? error.failureCategories
      : [];
    if (
      aggregateCategories.length > 0 &&
      aggregateCategories.every((category) => category === 'authentication')
    ) {
      return 'authentication';
    }
    if (aggregateCategories.includes('quota')) {
      return 'quota';
    }

    const relevantError = isAllKeysUnavailableError(error) && error.cause
      ? error.cause
      : error;
    const chain = getErrorChain(relevantError);
    const messages = chain
      .flatMap((entry) => [
        typeof entry === 'string' ? entry : '',
        entry?.message,
        entry?.code,
        entry?.type,
        entry?.reason,
        entry?.error?.code,
        entry?.error?.type,
        entry?.body?.error?.code,
        entry?.body?.error?.type,
        entry?.response?.data?.error?.code,
        entry?.response?.data?.error?.status
      ])
      .map((value) => String(value || '').toLowerCase())
      .filter(Boolean);
    const statuses = getErrorStatuses(relevantError);
    const includesMessage = (predicate) => messages.some(predicate);
    const knownModelNames = new Set([
      ...getGeminiModels(),
      service?.modelName,
      service?.model
    ]
      .map((modelName) => String(modelName || '').trim().toLowerCase())
      .filter(Boolean));
    const messageNamesModel = (message) => (
      [...knownModelNames].some((modelName) => message.includes(modelName))
    );

    if (includesMessage((message) => (
      message.includes('not configured') ||
      message.includes('service is not ready') ||
      message.includes('configure an api key') ||
      message.includes('configure it in settings') ||
      message.includes('no gemini api key configured') ||
      message.includes('no portkey api key configured') ||
      message.includes('invalid configuration') ||
      message.includes('invalid base url')
    ))) {
      return 'configuration';
    }

    if (
      statuses.includes(401) ||
      includesMessage((message) => (
        message.includes('api key not valid') ||
        message.includes('invalid api key') ||
        message.includes('api_key_invalid') ||
        message.includes('unauthenticated') ||
        message.includes('unauthorized') ||
        message.includes('authentication failed') ||
        message.includes('invalid credential') ||
        message.includes('expired api key') ||
        (
          (
            message.includes('api key') ||
            message.includes('api-key') ||
            message.includes('apikey') ||
            message.includes('credential')
          ) &&
          (
            message.includes('not allowed') ||
            message.includes('permission denied') ||
            message.includes('forbidden') ||
            message.includes('access denied')
          )
        )
      ))
    ) {
      return 'authentication';
    }

    if (
      statuses.includes(429) ||
      includesMessage((message) => (
        message.includes('quota') ||
        message.includes('rate limit') ||
        message.includes('resource_exhausted') ||
        message.includes('resource exhausted') ||
        message.includes('too many requests')
      )) ||
      service?.isQuotaExhaustedError?.(relevantError)
    ) {
      return 'quota';
    }

    if (includesMessage((message) => (
      message.includes('model_not_found') ||
      message.includes('model_unavailable') ||
      message.includes('model_not_allowed') ||
      message.includes('model_access_denied') ||
      message.includes('unsupported_model') ||
      message.includes('unsupported model') ||
      message.includes('model is not supported') ||
      message.includes('model does not exist') ||
      message.includes('model not found') ||
      message.includes('model unavailable') ||
      message.includes('model is unavailable') ||
      (
        statuses.includes(404) &&
        messageNamesModel(message) &&
        (
          message.includes('not found') ||
          message.includes('not supported')
        )
      ) ||
      (
        messageNamesModel(message) &&
        (
          message.includes('not allowed') ||
          message.includes('permission denied') ||
          message.includes('forbidden') ||
          message.includes('access denied')
        )
      )
    ))) {
      return 'model-unavailable';
    }

    if (
      statuses.includes(403) ||
      includesMessage((message) => (
        message.includes('permission denied') ||
        message.includes('forbidden')
      )) ||
      service?.isAuthenticationError?.(relevantError)
    ) {
      return 'authentication';
    }

    if (
      statuses.some((status) => status >= 500 && status <= 599) ||
      chain.some((entry) => entry?.retryable === true) ||
      includesMessage((message) => (
        message.includes('temporarily unavailable') ||
        message.includes('service unavailable') ||
        message.includes('internal server error') ||
        message.includes('timed out') ||
        message.includes('timeout') ||
        message.includes('network error') ||
        message.includes('econnreset') ||
        message.includes('etimedout') ||
        message.includes('socket hang up') ||
        message.includes('overloaded')
      )) ||
      service?.isRetryableError?.(relevantError)
    ) {
      return 'transient';
    }

    return 'unknown';
  }

  function isSwitchEligibleError(error, service = getService()) {
    const category = classifyExecutionFailure(error, service);
    return category === 'quota' || category === 'authentication';
  }

  function shouldAttemptModelFallback(provider, selectedModel, error, service) {
    if (
      (provider !== 'gemini' && provider !== 'portkey') ||
      selectedModel !== getDefaultGeminiModel() ||
      getDefaultGeminiFallbackModel() === selectedModel
    ) {
      return false;
    }

    const category = classifyExecutionFailure(error, service);
    return category === 'quota' ||
      category === 'model-unavailable' ||
      category === 'transient';
  }

  function createExecutionDiagnostics(provider, selectedModel) {
    return {
      selectedModel,
      modelUsed: selectedModel,
      fallbackModel: provider === 'gemini' || provider === 'portkey'
        ? getDefaultGeminiFallbackModel()
        : null,
      fallbackAttempted: false,
      fallbackUsed: false,
      failureCategory: null,
      failureTimestamp: null
    };
  }

  function recordExecutionFailure(diagnostics, error, service) {
    diagnostics.failureCategory = classifyExecutionFailure(error, service);
    diagnostics.failureTimestamp = new Date().toISOString();
  }

  function commitExecutionDiagnostics(diagnostics) {
    lastExecutionDiagnostics = Object.freeze({
      selectedModel: diagnostics.selectedModel,
      modelUsed: diagnostics.modelUsed,
      fallbackModel: diagnostics.fallbackModel,
      fallbackAttempted: diagnostics.fallbackAttempted,
      fallbackUsed: diagnostics.fallbackUsed,
      failureCategory: diagnostics.failureCategory,
      failureTimestamp: diagnostics.failureTimestamp
    });
  }

  function getLastExecutionDiagnostics() {
    return lastExecutionDiagnostics
      ? { ...lastExecutionDiagnostics }
      : null;
  }

  function createAllKeysUnavailableError(cause, failureCategories = []) {
    const allKeysUnavailableError = new Error(
      'All configured Gemini API keys are currently unavailable due to quota or authentication errors.'
    );

    allKeysUnavailableError.code = GEMINI_ALL_KEYS_UNAVAILABLE_ERROR_CODE;
    allKeysUnavailableError.isAllKeysUnavailable = true;
    allKeysUnavailableError.failureCategories = [...failureCategories];
    if (cause) {
      allKeysUnavailableError.cause = cause;
    }

    return allKeysUnavailableError;
  }

  function isAllKeysUnavailableError(error) {
    return Boolean(
      error && (
        error.code === GEMINI_ALL_KEYS_UNAVAILABLE_ERROR_CODE ||
        error.isAllKeysUnavailable === true
      )
    );
  }

  function configureGeminiExecutionService(apiKey, modelName) {
    if (!geminiService) {
      initializeGeminiService(apiKey, activeGeminiModel, activeProgrammingLanguage);
    }

    if (geminiService) {
      geminiService.updateConfiguration({
        apiKey,
        modelName,
        programmingLanguage: activeProgrammingLanguage,
        thinkingLevel: activeThinkingLevel,
        webSearchEnabled: activeWebSearchEnabled
      });
    }

    return geminiService;
  }

  function configurePortkeyExecutionService(modelName) {
    if (!portkeyService) {
      initializePortkeyService(
        activePortkeyApiKey,
        activeGeminiModel,
        activeProgrammingLanguage,
        {
          provider: activePortkeyProvider,
          baseUrl: activePortkeyBaseUrl
        }
      );
    }

    if (portkeyService) {
      portkeyService.updateConfiguration({
        apiKey: activePortkeyApiKey,
        provider: activePortkeyProvider,
        baseUrl: activePortkeyBaseUrl,
        modelName,
        programmingLanguage: activeProgrammingLanguage,
        thinkingLevel: activeThinkingLevel,
        webSearchEnabled: activeWebSearchEnabled
      });
    }

    return portkeyService;
  }

  function restoreSelectedModelConfiguration(provider, selectedModel, configurationGeneration) {
    if (activeAiProvider !== provider) {
      return;
    }

    const modelToRestore = runtimeConfigurationGeneration === configurationGeneration
      ? selectedModel
      : activeGeminiModel;

    if (provider === 'gemini' && geminiService) {
      configureGeminiExecutionService(getActiveApiKey(), modelToRestore);
    } else if (provider === 'portkey' && portkeyService) {
      configurePortkeyExecutionService(modelToRestore);
    }
  }

  function synchronizeNewerModelConfiguration(provider, selectedModel, configurationGeneration) {
    if (runtimeConfigurationGeneration === configurationGeneration) {
      return;
    }

    restoreSelectedModelConfiguration(provider, selectedModel, configurationGeneration);
  }

  function createRequestRebind(service, configuration) {
    let active = true;
    return {
      rebind() {
        if (!active) {
          throw new Error('AI execution request binding is no longer active.');
        }
        service?.updateConfiguration?.(configuration);
        return service;
      },
      deactivate() {
        active = false;
      }
    };
  }

  function executeServiceOperation(operation, service, context) {
    if (typeof service?.runWithExecutionContext !== 'function') {
      return operation(service, context);
    }

    return service.runWithExecutionContext(
      context,
      () => operation(service, context)
    );
  }

  async function executeGeminiModel(operation, modelName, options = {}) {
    const totalKeys = geminiApiKeys.length;
    const startIndex = activeApiKeyIndex;
    let attemptedKeys = 0;
    let lastSwitchEligibleError = null;
    const failureCategories = [];
    const cacheSuppressed = options.cacheSuppressed === true;
    const isModelFallback = options.isModelFallback === true;

    while (attemptedKeys < totalKeys) {
      const activeApiKey = getActiveApiKey();
      if (!activeApiKey) {
        break;
      }

      const currentService = configureGeminiExecutionService(activeApiKey, modelName);
      const attemptConfiguration = Object.freeze({
        apiKey: activeApiKey,
        modelName,
        programmingLanguage: currentService?.programmingLanguage || activeProgrammingLanguage,
        thinkingLevel: activeThinkingLevel,
        webSearchEnabled: activeWebSearchEnabled
      });
      const requestRebind = createRequestRebind(currentService, attemptConfiguration);

      try {
        const context = {
          activeApiKeyIndex,
          activeApiKey,
          provider: 'gemini',
          modelName,
          programmingLanguage: attemptConfiguration.programmingLanguage,
          isModelFallback,
          cacheSuppressed,
          attempt: attemptedKeys + 1,
          totalKeys,
          rebindServiceForRequest: requestRebind.rebind
        };
        return await executeServiceOperation(operation, currentService, context);
      } catch (error) {
        if (!isSwitchEligibleError(error, currentService)) {
          throw error;
        }

        lastSwitchEligibleError = error;
        failureCategories.push(classifyExecutionFailure(error, currentService));
        attemptedKeys += 1;

        if (attemptedKeys >= totalKeys) {
          if (activeApiKeyIndex !== startIndex) {
            setActiveApiKeyIndex(startIndex);
          }
          configureGeminiExecutionService(getActiveApiKey(), modelName);

          throw createAllKeysUnavailableError(lastSwitchEligibleError, failureCategories);
        }

        setActiveApiKeyIndex((activeApiKeyIndex + 1) % totalKeys);
      } finally {
        requestRebind.deactivate();
      }
    }

    throw createAllKeysUnavailableError(lastSwitchEligibleError, failureCategories);
  }

  async function executePortkeyModel(operation, modelName, options = {}) {
    const service = configurePortkeyExecutionService(modelName);
    const attemptConfiguration = Object.freeze({
      apiKey: activePortkeyApiKey,
      provider: activePortkeyProvider,
      baseUrl: activePortkeyBaseUrl,
      modelName,
      programmingLanguage: service?.programmingLanguage || activeProgrammingLanguage,
      thinkingLevel: activeThinkingLevel,
      webSearchEnabled: activeWebSearchEnabled
    });
    const requestRebind = createRequestRebind(service, attemptConfiguration);
    const cacheConfiguration = {
      apiKey: attemptConfiguration.apiKey,
      provider: attemptConfiguration.provider,
      baseUrl: attemptConfiguration.baseUrl,
      cacheNamespace: createPortkeyCacheNamespace(
        attemptConfiguration.provider,
        attemptConfiguration.baseUrl
      )
    };
    const context = attachCacheConfigurationAccessor({
      activeApiKeyIndex: 0,
      activeApiKey: '',
      provider: 'portkey',
      modelName,
      programmingLanguage: attemptConfiguration.programmingLanguage,
      isModelFallback: options.isModelFallback === true,
      cacheSuppressed: options.cacheSuppressed === true,
      attempt: 1,
      totalKeys: 0,
      rebindServiceForRequest: requestRebind.rebind
    }, cacheConfiguration);
    try {
      return await executeServiceOperation(operation, service, context);
    } finally {
      requestRebind.deactivate();
    }
  }

  async function executeQueued(operation) {
    const provider = activeAiProvider;
    const selectedModel = activeGeminiModel;
    const configurationGeneration = runtimeConfigurationGeneration;
    const diagnostics = createExecutionDiagnostics(provider, selectedModel);

    if (provider === 'portkey') {
      if (!portkeyService) {
        initializePortkeyService();
      }
      if (!portkeyService?.isReady?.()) {
        const error = new Error('No Portkey API key configured. Add it in Settings.');
        recordExecutionFailure(diagnostics, error, portkeyService);
        commitExecutionDiagnostics(diagnostics);
        throw error;
      }
    } else if (!hasApiKeys()) {
      const error = new Error('No Gemini API key configured. Add it in Settings.');
      recordExecutionFailure(diagnostics, error, geminiService);
      commitExecutionDiagnostics(diagnostics);
      throw error;
    }

    const executeModel = provider === 'portkey'
      ? (modelName, options) => executePortkeyModel(operation, modelName, options)
      : (modelName, options) => executeGeminiModel(operation, modelName, options);

    let primaryResult;
    let primaryError;
    let primarySucceeded = false;

    try {
      primaryResult = await executeModel(selectedModel, {
        isModelFallback: false
      });
      primarySucceeded = true;
    } catch (error) {
      primaryError = error;
    }

    if (primarySucceeded) {
      try {
        synchronizeNewerModelConfiguration(
          provider,
          selectedModel,
          configurationGeneration
        );
      } catch (error) {
        const service = provider === 'portkey' ? portkeyService : geminiService;
        recordExecutionFailure(diagnostics, error, service);
        commitExecutionDiagnostics(diagnostics);
        throw error;
      }

      commitExecutionDiagnostics(diagnostics);
      return primaryResult;
    }

    const service = provider === 'portkey' ? portkeyService : geminiService;
    recordExecutionFailure(diagnostics, primaryError, service);

    if (!shouldAttemptModelFallback(provider, selectedModel, primaryError, service)) {
      try {
        synchronizeNewerModelConfiguration(
          provider,
          selectedModel,
          configurationGeneration
        );
      } catch (error) {
        const selectedService = provider === 'portkey' ? portkeyService : geminiService;
        recordExecutionFailure(diagnostics, error, selectedService);
        commitExecutionDiagnostics(diagnostics);
        throw error;
      }

      commitExecutionDiagnostics(diagnostics);
      throw primaryError;
    }

    diagnostics.fallbackAttempted = true;
    diagnostics.modelUsed = diagnostics.fallbackModel;

    let fallbackResult;
    let fallbackFailure = null;
    try {
      fallbackResult = await executeModel(diagnostics.fallbackModel, {
        cacheSuppressed: true,
        isModelFallback: true
      });
    } catch (error) {
      fallbackFailure = error;
      const fallbackService = provider === 'portkey' ? portkeyService : geminiService;
      recordExecutionFailure(diagnostics, error, fallbackService);
    }

    try {
      restoreSelectedModelConfiguration(
        provider,
        selectedModel,
        configurationGeneration
      );
    } catch (error) {
      fallbackFailure = fallbackFailure || error;
      const selectedService = provider === 'portkey' ? portkeyService : geminiService;
      recordExecutionFailure(diagnostics, error, selectedService);
    }

    if (fallbackFailure) {
      commitExecutionDiagnostics(diagnostics);
      throw fallbackFailure;
    }

    diagnostics.fallbackUsed = true;
    commitExecutionDiagnostics(diagnostics);
    return fallbackResult;
  }

  function executeWithKeyFailover(operation) {
    if (typeof operation !== 'function') {
      return Promise.reject(new Error('AI failover operation must be a function.'));
    }

    const execution = executionQueue.then(() => executeQueued(operation));
    executionQueue = execution.then(
      () => undefined,
      () => undefined
    );
    return execution;
  }

  function initializePortkeyService(
    apiKey = activePortkeyApiKey,
    modelName = activeGeminiModel,
    programmingLanguage = activeProgrammingLanguage,
    options = {}
  ) {
    const nextPortkeyApiKey = String(apiKey || '').trim();
    const nextPortkeyProvider = String(options.provider ?? activePortkeyProvider ?? getDefaultPortkeyProvider()).trim()
      || getDefaultPortkeyProvider();
    const nextPortkeyBaseUrl = String(options.baseUrl ?? activePortkeyBaseUrl ?? '').trim().replace(/\/+$/, '');
    const nextGeminiModel = resolveGeminiModel(modelName);
    const nextProgrammingLanguage = resolveProgrammingLanguage(programmingLanguage);
    recordRuntimeConfigurationChange(activePortkeyApiKey, nextPortkeyApiKey);
    recordRuntimeConfigurationChange(activePortkeyProvider, nextPortkeyProvider);
    recordRuntimeConfigurationChange(activePortkeyBaseUrl, nextPortkeyBaseUrl);
    recordRuntimeConfigurationChange(activeGeminiModel, nextGeminiModel);
    recordRuntimeConfigurationChange(activeProgrammingLanguage, nextProgrammingLanguage);
    activePortkeyApiKey = nextPortkeyApiKey;
    activePortkeyProvider = nextPortkeyProvider;
    activePortkeyBaseUrl = nextPortkeyBaseUrl;
    activeGeminiModel = nextGeminiModel;
    activeProgrammingLanguage = nextProgrammingLanguage;

    try {
      if (!activePortkeyApiKey) {
        console.error('Portkey API key not configured in app settings');
        portkeyService = null;
        return null;
      }

      console.log(
        'Initializing Portkey AI Service with model and language:',
        activeGeminiModel,
        activeProgrammingLanguage
      );

      const adapterOptions = {
        apiKey: activePortkeyApiKey,
        provider: activePortkeyProvider,
        baseUrl: activePortkeyBaseUrl,
        modelName: activeGeminiModel,
        programmingLanguage: activeProgrammingLanguage,
        thinkingLevel: activeThinkingLevel,
        webSearchEnabled: activeWebSearchEnabled
      };

      if (portkeyService) {
        portkeyService.updateConfiguration(adapterOptions);
      } else {
        portkeyService = wrapService(new PortkeyService(adapterOptions));
      }

      console.log('Portkey AI Service initialized successfully');
      return portkeyService;
    } catch (error) {
      portkeyService = null;
      console.error('Failed to initialize Portkey AI Service:', error);
      return null;
    }
  }

  function initializeAiService() {
    if (activeAiProvider === 'portkey') {
      return initializePortkeyService(activePortkeyApiKey, activeGeminiModel, activeProgrammingLanguage, {
        provider: activePortkeyProvider,
        baseUrl: activePortkeyBaseUrl
      });
    }
    return initializeGeminiService(getActiveApiKey(), activeGeminiModel, activeProgrammingLanguage);
  }

  function setActiveAiProvider(providerName) {
    const nextAiProvider = resolveAiProvider(providerName);
    recordRuntimeConfigurationChange(activeAiProvider, nextAiProvider);
    activeAiProvider = nextAiProvider;
    return activeAiProvider;
  }

  function getActiveAiProvider() {
    return activeAiProvider;
  }

  function setActivePortkeyApiKey(apiKey) {
    const nextPortkeyApiKey = String(apiKey || '').trim();
    recordRuntimeConfigurationChange(activePortkeyApiKey, nextPortkeyApiKey);
    activePortkeyApiKey = nextPortkeyApiKey;
    return activePortkeyApiKey;
  }

  function getActivePortkeyApiKey() {
    return activePortkeyApiKey;
  }

  function setActivePortkeyProvider(provider) {
    const nextPortkeyProvider = String(provider || getDefaultPortkeyProvider()).trim()
      || getDefaultPortkeyProvider();
    recordRuntimeConfigurationChange(activePortkeyProvider, nextPortkeyProvider);
    activePortkeyProvider = nextPortkeyProvider;
    return activePortkeyProvider;
  }

  function getActivePortkeyProvider() {
    return activePortkeyProvider;
  }

  function setActivePortkeyBaseUrl(baseUrl) {
    const nextPortkeyBaseUrl = String(baseUrl || '').trim().replace(/\/+$/, '');
    recordRuntimeConfigurationChange(activePortkeyBaseUrl, nextPortkeyBaseUrl);
    activePortkeyBaseUrl = nextPortkeyBaseUrl;
    return activePortkeyBaseUrl;
  }

  function getActivePortkeyBaseUrl() {
    return activePortkeyBaseUrl;
  }

  function setActiveThinkingLevel(level) {
    const nextThinkingLevel = resolveThinkingLevel(level, getDefaultForegroundThinkingLevel());
    recordRuntimeConfigurationChange(activeThinkingLevel, nextThinkingLevel);
    activeThinkingLevel = nextThinkingLevel;
    return activeThinkingLevel;
  }

  function getActiveThinkingLevel() {
    return activeThinkingLevel;
  }

  function setActiveWebSearchEnabled(enabled) {
    const nextWebSearchEnabled = Boolean(enabled);
    recordRuntimeConfigurationChange(activeWebSearchEnabled, nextWebSearchEnabled);
    activeWebSearchEnabled = nextWebSearchEnabled;
    return activeWebSearchEnabled;
  }

  function getActiveWebSearchEnabled() {
    return activeWebSearchEnabled;
  }

  function getService() {
    if (activeAiProvider === 'portkey') {
      return portkeyService;
    }
    return geminiService;
  }

  function getActiveGeminiModel() {
    return activeGeminiModel;
  }

  function getActiveProgrammingLanguage() {
    return activeProgrammingLanguage;
  }

  function setActiveGeminiModel(modelName) {
    const nextGeminiModel = resolveGeminiModel(modelName);
    recordRuntimeConfigurationChange(activeGeminiModel, nextGeminiModel);
    activeGeminiModel = nextGeminiModel;
    return activeGeminiModel;
  }

  function setActiveProgrammingLanguage(language) {
    const nextProgrammingLanguage = resolveProgrammingLanguage(language);
    recordRuntimeConfigurationChange(activeProgrammingLanguage, nextProgrammingLanguage);
    activeProgrammingLanguage = nextProgrammingLanguage;
    return activeProgrammingLanguage;
  }

  function setActiveKeyIndexChangeHandler(handler) {
    activeKeyIndexChangeHandler = typeof handler === 'function' ? handler : null;
  }

  return {
    initializeGeminiService,
    initializePortkeyService,
    initializeAiService,
    setKeys,
    getApiKeys,
    hasApiKeys,
    hasPortkeyApiKey,
    isAiReady,
    getActiveApiKey,
    getActiveApiKeyIndex: () => activeApiKeyIndex,
    switchToNextKey,
    executeWithKeyFailover,
    isAllKeysUnavailableError,
    setActiveKeyIndexChangeHandler,
    getService,
    getAiProviders,
    getDefaultAiProvider,
    getActiveAiProvider,
    setActiveAiProvider,
    getGeminiModels,
    getDefaultGeminiModel,
    getDefaultGeminiFallbackModel,
    getGeminiMemoryModel,
    getLastExecutionDiagnostics,
    getActiveGeminiModel,
    setActiveGeminiModel,
    getDefaultPortkeyProvider,
    getDefaultPortkeyBaseUrl,
    getActivePortkeyApiKey,
    setActivePortkeyApiKey,
    getActivePortkeyProvider,
    setActivePortkeyProvider,
    getActivePortkeyBaseUrl,
    setActivePortkeyBaseUrl,
    getActiveThinkingLevel,
    setActiveThinkingLevel,
    getActiveWebSearchEnabled,
    setActiveWebSearchEnabled,
    getProgrammingLanguages,
    getDefaultProgrammingLanguage,
    getActiveProgrammingLanguage,
    setActiveProgrammingLanguage
  };
}

// Backward-compatible alias
const createGeminiRuntime = createAiRuntime;

module.exports = {
  GEMINI_ALL_KEYS_UNAVAILABLE_ERROR_CODE,
  createAiRuntime,
  createGeminiRuntime
};
