const { createSearchResult } = require('./results');

const TAVILY_ENDPOINT = 'https://api.tavily.com/search';

function createTavilyAdapter(options = {}) {
  let apiKey = String(options.apiKey || '').trim();
  const fetchImpl = typeof options.fetch === 'function'
    ? options.fetch
    : (...args) => fetch(...args);
  const endpoint = String(options.endpoint || TAVILY_ENDPOINT);

  function setApiKey(nextKey) {
    apiKey = String(nextKey || '').trim();
  }

  async function search(query, requestOptions = {}) {
    if (!apiKey) {
      throw new Error('Tavily API key is not configured');
    }

    const maxResults = Number.isFinite(requestOptions.maxResults)
      ? requestOptions.maxResults
      : 5;

    const response = await fetchImpl(endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        api_key: apiKey,
        query: String(query || '').trim(),
        max_results: maxResults,
        include_answer: false,
        search_depth: 'basic'
      }),
      signal: requestOptions.signal
    });

    if (!response.ok) {
      const bodyText = typeof response.text === 'function'
        ? await response.text()
        : '';
      throw new Error(`Tavily request failed (${response.status}): ${bodyText.slice(0, 200)}`);
    }

    const payload = await response.json();
    const results = Array.isArray(payload?.results)
      ? payload.results.map((entry) => createSearchResult({
        title: entry.title,
        url: entry.url,
        snippet: entry.content || entry.snippet || '',
        source: 'tavily'
      }))
      : [];

    const citations = results
      .filter((entry) => entry.url)
      .map((entry) => ({ title: entry.title, url: entry.url }));

    return {
      results,
      citations,
      raw: payload
    };
  }

  return {
    name: 'tavily',
    setApiKey,
    search
  };
}

module.exports = {
  TAVILY_ENDPOINT,
  createTavilyAdapter
};
