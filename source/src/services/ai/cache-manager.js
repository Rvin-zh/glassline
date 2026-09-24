const crypto = require('crypto');
const {
  STATIC_PROMPT_VERSION,
  buildCacheablePromptPrefix
} = require('./prompts');

const MIN_CACHE_TOKENS = 4096;
const DEFAULT_TTL_SECONDS = 3600;

function estimateTokens(text) {
  const normalized = typeof text === 'string' ? text : String(text || '');
  return Math.ceil(normalized.length / 4);
}

function hashText(text) {
  return crypto.createHash('sha256').update(String(text || ''), 'utf8').digest('hex');
}

function createCacheManager(options = {}) {
  const minCacheTokens = Number.isFinite(options.minCacheTokens)
    ? options.minCacheTokens
    : MIN_CACHE_TOKENS;
  const defaultTtlSeconds = Number.isFinite(options.defaultTtlSeconds)
    ? options.defaultTtlSeconds
    : DEFAULT_TTL_SECONDS;
  const createClient = typeof options.createClient === 'function'
    ? options.createClient
    : null;
  const nowFn = typeof options.now === 'function' ? options.now : () => Date.now();

  let apiKey = String(options.apiKey || '').trim();
  let enabled = options.enabled !== false;

  let activeCache = null;
  let cacheGeneration = 0;
  let creationSequence = 0;
  let cacheHitCount = 0;
  const createInFlightByKey = new Map();
  const latestCreationByGeneration = new Map();
  const clientsByIdentity = new Map();

  function credentialIdentity(value) {
    return hashText(`credential-v1\0${String(value || '').trim()}`);
  }

  function resolveClientContext(params = {}) {
    const provider = String(
      params.provider ?? options.provider ?? 'gemini'
    ).trim() || 'gemini';
    const cacheNamespace = String(
      params.cacheNamespace ?? options.cacheNamespace ?? provider
    ).trim() || provider;
    const baseUrl = String(
      params.baseUrl ?? options.baseUrl ?? ''
    ).trim().replace(/\/+$/, '');
    return Object.freeze({
      provider,
      cacheNamespace,
      baseUrl
    });
  }

  function clientIdentity(exactApiKey, context) {
    return hashText([
      'cache-client-v2',
      credentialIdentity(exactApiKey),
      context.provider,
      context.cacheNamespace,
      context.baseUrl
    ].join('\0'));
  }

  if (options.client) {
    const initialContext = resolveClientContext(options);
    clientsByIdentity.set(
      clientIdentity(apiKey, initialContext),
      options.client
    );
  }

  function resolveApiKey(params = {}) {
    return Object.prototype.hasOwnProperty.call(params, 'apiKey')
      ? String(params.apiKey || '').trim()
      : apiKey;
  }

  function getClient(exactApiKey, context) {
    const normalized = String(exactApiKey || '').trim();
    if (!normalized) {
      return null;
    }

    const identity = clientIdentity(normalized, context);
    if (clientsByIdentity.has(identity)) {
      return clientsByIdentity.get(identity);
    }

    if (!createClient) {
      return null;
    }

    const client = createClient(normalized, context);
    if (client) {
      clientsByIdentity.set(identity, client);
    }
    return client || null;
  }

  function setApiKey(nextApiKey) {
    const normalized = String(nextApiKey || '').trim();
    if (normalized !== apiKey) {
      apiKey = normalized;
      return invalidate('api-key-changed');
    }
    return Promise.resolve({ invalidated: false, reason: 'api-key-unchanged' });
  }

  function setEnabled(nextEnabled) {
    const nextValue = nextEnabled !== false;
    const changed = nextValue !== enabled;
    enabled = nextValue;
    if (changed) {
      return invalidate(enabled ? 'enabled' : 'disabled');
    }
    return Promise.resolve({ invalidated: false, reason: 'unchanged' });
  }

  function buildFingerprint({
    model,
    programmingLanguage,
    resume = '',
    jobDescription = '',
    promptVersion = STATIC_PROMPT_VERSION,
    apiKey: fingerprintApiKey,
    provider,
    cacheNamespace,
    baseUrl
  } = {}) {
    const prefix = buildCacheablePromptPrefix({
      programmingLanguage,
      resume,
      jobDescription
    });

    const exactApiKey = fingerprintApiKey === undefined
      ? apiKey
      : String(fingerprintApiKey || '').trim();
    const clientContext = resolveClientContext({
      provider,
      cacheNamespace,
      baseUrl
    });

    const metadata = {
      tokenEstimate: estimateTokens(prefix),
      fingerprint: hashText([
        'cache-fingerprint-v2',
        clientContext.provider,
        clientContext.cacheNamespace,
        clientContext.baseUrl,
        String(model || ''),
        String(programmingLanguage || ''),
        String(promptVersion || ''),
        hashText(prefix),
        hashText(resume),
        hashText(jobDescription),
        credentialIdentity(exactApiKey)
      ].join('|'))
    };
    Object.defineProperty(metadata, 'prefix', {
      configurable: false,
      enumerable: false,
      writable: false,
      value: prefix
    });
    return metadata;
  }

  function isExpired(entry = activeCache, at = nowFn()) {
    if (!entry) {
      return true;
    }
    return !entry.expireAt || at >= entry.expireAt;
  }

  function cacheMetadata(entry, extra = {}) {
    if (!entry) {
      return null;
    }
    return {
      cacheName: entry.name,
      model: entry.model,
      fingerprint: entry.fingerprint,
      tokenEstimate: entry.tokenEstimate,
      expireAt: entry.expireAt,
      createdAt: entry.createdAt,
      usageMetadata: entry.usageMetadata,
      ...extra
    };
  }

  function getGeneration() {
    return cacheGeneration;
  }

  function isGenerationCurrent(expectedGeneration) {
    return Number.isSafeInteger(expectedGeneration) &&
      expectedGeneration === cacheGeneration;
  }

  async function deleteStaleEntry(entry) {
    if (
      !entry ||
      !entry.stale ||
      entry.leaseCount > 0 ||
      (entry.pendingAcquirers > 0 && entry.neverLease !== true) ||
      entry.deleted
    ) {
      return;
    }
    if (entry.deletePromise) {
      return entry.deletePromise;
    }

    entry.deletePromise = (async () => {
      try {
        if (entry.name && typeof entry.client?.caches?.delete === 'function') {
          await entry.client.caches.delete({ name: entry.name });
        }
      } catch (_) {
        console.warn('[cache-manager] Failed to delete cached content.', {
          model: entry.model,
          fingerprint: entry.fingerprint
        });
      } finally {
        entry.deleted = true;
      }
    })();

    return entry.deletePromise;
  }

  function markStale(entry, reason) {
    if (!entry) {
      return Promise.resolve();
    }

    entry.stale = true;
    entry.staleReason = reason;
    if (activeCache === entry) {
      activeCache = null;
    }
    return deleteStaleEntry(entry);
  }

  function expireActiveCacheIfNeeded() {
    if (activeCache && isExpired(activeCache)) {
      const expired = activeCache;
      activeCache = null;
      void markStale(expired, 'expired');
    }
  }

  function getActiveCache() {
    expireActiveCacheIfNeeded();
    if (!activeCache || activeCache.stale) {
      return null;
    }
    return {
      name: activeCache.name,
      ...cacheMetadata(activeCache)
    };
  }

  async function invalidate(reason = 'manual') {
    const previous = activeCache;
    const hadInFlight = createInFlightByKey.size > 0;
    cacheGeneration += 1;
    activeCache = null;

    if (previous) {
      await markStale(previous, reason);
    }

    return { invalidated: Boolean(previous || hadInFlight), reason };
  }

  async function discardCurrentCaches(reason) {
    const previous = activeCache;
    activeCache = null;
    latestCreationByGeneration.set(cacheGeneration, ++creationSequence);
    if (previous) {
      await markStale(previous, reason);
    }
  }

  function releaseEntry(entry) {
    if (!entry || entry.leaseCount <= 0) {
      return Promise.resolve();
    }
    entry.leaseCount -= 1;
    return deleteStaleEntry(entry);
  }

  function cacheLease(entry, reused) {
    if (reused) {
      cacheHitCount += 1;
    }
    entry.leaseCount += 1;
    let released = false;
    const result = cacheMetadata(entry, {
      used: true,
      reused
    });
    Object.defineProperty(result, 'release', {
      configurable: false,
      enumerable: false,
      writable: false,
      value: async () => {
        if (released) {
          return;
        }
        released = true;
        await releaseEntry(entry);
      }
    });
    return result;
  }

  function creationKey(generation, fingerprint) {
    return JSON.stringify([generation, fingerprint]);
  }

  function unavailableResult(reason, details = {}) {
    return {
      used: false,
      reason,
      ...details
    };
  }

  function staleGenerationResult() {
    return unavailableResult('stale-generation', {
      retryable: true,
      cancelled: true
    });
  }

  function finishAcquirer(record) {
    record.pendingAcquirers = Math.max(0, record.pendingAcquirers - 1);
    if (record.entry) {
      record.entry.pendingAcquirers = record.pendingAcquirers;
      void deleteStaleEntry(record.entry);
    }
    if (
      record.settled &&
      record.pendingAcquirers === 0 &&
      createInFlightByKey.get(record.key) === record
    ) {
      createInFlightByKey.delete(record.key);
    }
  }

  async function createEntry(record) {
    try {
      const created = await record.client.caches.create({
        model: record.model,
        config: {
          displayName: `open-cluely-${record.fingerprint.slice(0, 12)}`,
          contents: [{ role: 'user', parts: [{ text: record.prefix }] }],
          ttl: `${record.ttl}s`
        }
      });

      if (!created?.name) {
        throw new Error('Cached content creation returned no name.');
      }

      const expireAt = created?.expireTime
        ? Date.parse(created.expireTime)
        : nowFn() + record.ttl * 1000;
      const entry = {
        name: created.name,
        model: record.model,
        fingerprint: record.fingerprint,
        tokenEstimate: record.tokenEstimate,
        expireAt: Number.isFinite(expireAt)
          ? expireAt
          : nowFn() + record.ttl * 1000,
        createdAt: nowFn(),
        usageMetadata: created.usageMetadata || null,
        client: record.client,
        leaseCount: 0,
        pendingAcquirers: record.pendingAcquirers,
        stale: false,
        staleReason: null,
        deletePromise: null,
        deleted: false,
        neverLease: false
      };
      record.entry = entry;

      const isLatestCreation =
        latestCreationByGeneration.get(record.generation) === record.sequence;
      const generationChanged = !isGenerationCurrent(record.generation);
      if (
        !enabled ||
        generationChanged ||
        !isLatestCreation
      ) {
        entry.stale = true;
        entry.staleReason = generationChanged
          ? 'invalidated-during-create'
          : isLatestCreation
            ? 'disabled-during-create'
            : 'superseded-during-create';

        if (generationChanged) {
          entry.neverLease = true;
          await deleteStaleEntry(entry);
          return { result: staleGenerationResult() };
        }
      } else {
        const previous = activeCache;
        activeCache = entry;
        if (previous && previous !== entry) {
          void markStale(previous, 'superseded');
        }
      }

      return { entry };
    } catch (_) {
      console.warn('[cache-manager] Failed to create cached content.', {
        model: record.model,
        fingerprint: record.fingerprint
      });
      return {
        result: unavailableResult('create-failed', {
          model: record.model,
          fingerprint: record.fingerprint,
          tokenEstimate: record.tokenEstimate
        })
      };
    } finally {
      record.settled = true;
    }
  }

  async function acquireFromRecord(record) {
    record.pendingAcquirers += 1;
    if (record.entry) {
      record.entry.pendingAcquirers = record.pendingAcquirers;
    }

    try {
      const created = await record.promise;
      if (!created.entry) {
        return created.result;
      }
      if (!isGenerationCurrent(record.generation)) {
        created.entry.neverLease = true;
        await markStale(created.entry, 'invalidated-after-create');
        return staleGenerationResult();
      }
      return cacheLease(created.entry, false);
    } finally {
      finishAcquirer(record);
    }
  }

  async function acquireCache(params = {}) {
    const hasExpectedGeneration =
      Object.prototype.hasOwnProperty.call(params, 'expectedGeneration');
    const expectedGeneration = hasExpectedGeneration
      ? params.expectedGeneration
      : cacheGeneration;
    if (!isGenerationCurrent(expectedGeneration)) {
      return staleGenerationResult();
    }

    if (!enabled) {
      return unavailableResult('disabled');
    }

    const {
      model,
      programmingLanguage,
      resume = '',
      jobDescription = '',
      ttlSeconds = defaultTtlSeconds,
      promptVersion = STATIC_PROMPT_VERSION
    } = params;
    const exactApiKey = resolveApiKey(params);
    const clientContext = resolveClientContext(params);

    const { prefix, tokenEstimate, fingerprint } = buildFingerprint({
      model,
      programmingLanguage,
      resume,
      jobDescription,
      promptVersion,
      apiKey: exactApiKey,
      provider: clientContext.provider,
      cacheNamespace: clientContext.cacheNamespace,
      baseUrl: clientContext.baseUrl
    });

    if (tokenEstimate < minCacheTokens) {
      if (activeCache || createInFlightByKey.size > 0) {
        await discardCurrentCaches('below-threshold');
      }
      if (!isGenerationCurrent(expectedGeneration)) {
        return staleGenerationResult();
      }
      return unavailableResult('below-threshold', {
        tokenEstimate,
        minCacheTokens
      });
    }

    expireActiveCacheIfNeeded();
    const existing = activeCache;
    if (
      existing &&
      !existing.stale &&
      existing.fingerprint === fingerprint &&
      existing.model === model
    ) {
      return cacheLease(existing, true);
    }

    const requestGeneration = expectedGeneration;
    const requestKey = creationKey(requestGeneration, fingerprint);
    const existingCreation = createInFlightByKey.get(requestKey);
    if (existingCreation) {
      return acquireFromRecord(existingCreation);
    }

    if (activeCache) {
      void markStale(activeCache, 'superseded');
    }

    let client;
    try {
      client = getClient(exactApiKey, clientContext);
    } catch (_) {
      console.warn('[cache-manager] Failed to initialize cache client.', {
        model,
        fingerprint
      });
      return unavailableResult('client-unavailable', {
        model,
        fingerprint,
        tokenEstimate
      });
    }
    if (!client?.caches?.create) {
      return unavailableResult('client-unavailable', {
        model,
        fingerprint,
        tokenEstimate
      });
    }

    const sequence = ++creationSequence;
    latestCreationByGeneration.set(requestGeneration, sequence);
    const record = {
      key: requestKey,
      generation: requestGeneration,
      sequence,
      model,
      fingerprint,
      tokenEstimate,
      prefix,
      ttl: Math.max(60, Number(ttlSeconds) || defaultTtlSeconds),
      client,
      clientContext,
      pendingAcquirers: 0,
      settled: false,
      entry: null,
      promise: null
    };
    record.promise = createEntry(record);
    createInFlightByKey.set(requestKey, record);
    return acquireFromRecord(record);
  }

  return {
    estimateTokens,
    buildFingerprint,
    acquireCache,
    ensureCache: acquireCache,
    getActiveCache,
    getDiagnostics() {
      const current = getActiveCache();
      return {
        enabled,
        activeCount: current ? 1 : 0,
        hasActiveName: Boolean(current?.name),
        hitCount: cacheHitCount
      };
    },
    getGeneration,
    isGenerationCurrent,
    invalidate,
    setApiKey,
    setEnabled,
    isExpired,
    MIN_CACHE_TOKENS: minCacheTokens
  };
}

module.exports = {
  MIN_CACHE_TOKENS,
  DEFAULT_TTL_SECONDS,
  estimateTokens,
  createCacheManager
};
