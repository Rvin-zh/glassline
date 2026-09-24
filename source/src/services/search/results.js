function createSearchResult({ title, url, snippet, source } = {}) {
  return {
    title: String(title || '').trim(),
    url: String(url || '').trim(),
    snippet: String(snippet || '').trim(),
    source: String(source || '').trim() || 'search'
  };
}

module.exports = {
  createSearchResult
};
