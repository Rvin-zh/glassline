const { GoogleGenAI } = require('@google/genai');
const { createSearchResult } = require('./results');

function createGeminiGroundingAdapter(options = {}) {
  let apiKey = String(options.apiKey || '').trim();
  let client = options.client || null;
  const model = String(options.model || 'gemini-2.5-flash-lite').trim();
  const fetchImpl = typeof options.fetch === 'function' ? options.fetch : null;

  function setApiKey(nextKey) {
    apiKey = String(nextKey || '').trim();
    client = null;
  }

  function getClient() {
    if (client) {
      return client;
    }
    if (!apiKey) {
      return null;
    }
    client = new GoogleGenAI({ apiKey });
    return client;
  }

  async function search(query, requestOptions = {}) {
    // Optional injectable fetch path for tests; production uses @google/genai grounding.
    if (fetchImpl) {
      return fetchImpl(query, requestOptions);
    }

    const ai = getClient();
    if (!ai) {
      throw new Error('Gemini grounding adapter has no API key');
    }

    const response = await ai.models.generateContent({
      model,
      contents: `Find concise, high-signal web facts for this query and cite sources:\n${query}`,
      config: {
        tools: [{ googleSearch: {} }],
        temperature: 0.2
      }
    });

    const text = typeof response?.text === 'string'
      ? response.text
      : (typeof response?.response?.text === 'function' ? response.response.text() : '');

    const grounding = response?.candidates?.[0]?.groundingMetadata
      || response?.response?.candidates?.[0]?.groundingMetadata
      || null;

    const chunks = Array.isArray(grounding?.groundingChunks)
      ? grounding.groundingChunks
      : [];

    const results = chunks
      .map((chunk) => {
        const web = chunk?.web || chunk?.retrievedContext || {};
        return createSearchResult({
          title: web.title || web.uri || 'Source',
          url: web.uri || web.url || '',
          snippet: web.snippet || text.slice(0, 240),
          source: 'gemini-grounding'
        });
      })
      .filter((entry) => entry.title || entry.url);

    const citations = results
      .filter((entry) => entry.url)
      .map((entry) => ({ title: entry.title, url: entry.url }));

    if (results.length === 0 && text) {
      results.push(createSearchResult({
        title: 'Gemini grounded answer',
        url: '',
        snippet: text.slice(0, 500),
        source: 'gemini-grounding'
      }));
    }

    return {
      results,
      citations,
      raw: {
        text,
        groundingMetadata: grounding
      }
    };
  }

  return {
    name: 'gemini-grounding',
    setApiKey,
    search
  };
}

module.exports = {
  createGeminiGroundingAdapter
};
