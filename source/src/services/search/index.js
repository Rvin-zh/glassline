const { createSearchResult } = require('./results');

const DEFAULT_TIMEOUT_MS = 8000;
const DEFAULT_MAX_RESULTS = 5;

function createSearchService(options = {}) {
  const adapters = {
    'gemini-grounding': options.geminiGroundingAdapter || null,
    tavily: options.tavilyAdapter || null
  };

  let globalEnabled = options.globalEnabled === true;
  let provider = options.provider === 'tavily' ? 'tavily' : 'gemini-grounding';
  let timeoutMs = Number.isFinite(options.timeoutMs) ? options.timeoutMs : DEFAULT_TIMEOUT_MS;
  let maxResults = Number.isFinite(options.maxResults) ? options.maxResults : DEFAULT_MAX_RESULTS;

  function setGlobalEnabled(enabled) {
    globalEnabled = enabled === true;
  }

  function isGlobalEnabled() {
    return globalEnabled === true;
  }

  function setProvider(nextProvider) {
    const normalized = String(nextProvider || '').trim().toLowerCase();
    if (normalized === 'tavily') {
      provider = 'tavily';
      return;
    }
    // Accept Phase 2 config alias "gemini" as grounding.
    provider = 'gemini-grounding';
  }

  function getProvider() {
    return provider;
  }

  function setAdapter(name, adapter) {
    if (name === 'tavily' || name === 'gemini-grounding') {
      adapters[name] = adapter;
    }
  }

  /**
   * Search is OFF by default. Requires globalEnabled AND per-request enableSearch.
   * When disabled, no adapter/network call is made.
   */
  async function search(query, requestOptions = {}) {
    const enableSearch = requestOptions.enableSearch === true;
    if (!globalEnabled || !enableSearch) {
      return {
        enabled: false,
        skipped: true,
        reason: !globalEnabled ? 'global-disabled' : 'request-disabled',
        results: [],
        citations: [],
        provider
      };
    }

    const normalizedQuery = String(query || '').trim();
    if (!normalizedQuery) {
      return {
        enabled: true,
        skipped: true,
        reason: 'empty-query',
        results: [],
        citations: [],
        provider
      };
    }

    const selectedProvider = (() => {
      const requested = requestOptions.provider || provider;
      const normalized = String(requested || '').trim().toLowerCase();
      if (normalized === 'tavily') {
        return 'tavily';
      }
      return 'gemini-grounding';
    })();
    const adapter = adapters[selectedProvider];
    if (!adapter || typeof adapter.search !== 'function') {
      return {
        enabled: true,
        skipped: true,
        reason: 'adapter-unavailable',
        results: [],
        citations: [],
        provider: selectedProvider
      };
    }

    const requestTimeout = Number.isFinite(requestOptions.timeoutMs)
      ? requestOptions.timeoutMs
      : timeoutMs;
    const limit = Number.isFinite(requestOptions.maxResults)
      ? requestOptions.maxResults
      : maxResults;

    try {
      const result = await Promise.race([
        adapter.search(normalizedQuery, {
          maxResults: limit,
          signal: requestOptions.signal
        }),
        new Promise((_, reject) => {
          setTimeout(() => reject(new Error('Search timed out')), requestTimeout);
        })
      ]);

      const results = Array.isArray(result?.results)
        ? result.results.slice(0, limit).map((entry) => createSearchResult({
          ...entry,
          source: entry.source || selectedProvider
        }))
        : [];

      const citations = Array.isArray(result?.citations)
        ? result.citations
        : results
          .filter((entry) => entry.url)
          .map((entry) => ({
            title: entry.title,
            url: entry.url
          }));

      return {
        enabled: true,
        skipped: false,
        provider: selectedProvider,
        results,
        citations,
        raw: result?.raw || null
      };
    } catch (error) {
      console.warn('[search] Request failed:', error.message);
      return {
        enabled: true,
        skipped: false,
        error: error.message,
        provider: selectedProvider,
        results: [],
        citations: []
      };
    }
  }

  return {
    search,
    setGlobalEnabled,
    isGlobalEnabled,
    setProvider,
    getProvider,
    setAdapter,
    createSearchResult,
    DEFAULT_TIMEOUT_MS,
    DEFAULT_MAX_RESULTS
  };
}

module.exports = {
  DEFAULT_TIMEOUT_MS,
  DEFAULT_MAX_RESULTS,
  createSearchResult,
  createSearchService
};
