'use strict';

const DEFAULT_PORTKEY_GATEWAY = 'https://api.portkey.ai/v1';
const VERTEX_API_HOST = 'https://aiplatform.googleapis.com/v1';
const DEFAULT_TIMEOUT_MS = 10_000;
const MIN_TIMEOUT_MS = 10;
const MAX_TIMEOUT_MS = 30_000;
const SAFE_SEGMENT_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

function createCacheClientError(operation, category, options = {}) {
  const suffix = category === 'timeout'
    ? 'timed out'
    : category === 'authentication'
      ? 'was not authorized'
      : category === 'quota'
        ? 'was rate limited'
        : category === 'configuration'
          ? 'has invalid configuration'
          : category === 'invalid-response'
            ? 'returned an invalid response'
            : category === 'transient'
              ? 'is temporarily unavailable'
              : 'failed';
  const error = new Error(`Portkey Vertex cache ${operation} ${suffix}.`);
  error.name = 'PortkeyVertexCacheError';
  error.code = `PORTKEY_VERTEX_CACHE_${category
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, '_')}`;
  error.category = category;
  if (Number.isInteger(options.status)) {
    error.status = options.status;
  }
  error.retryable = category === 'timeout' ||
    category === 'transient' ||
    category === 'quota';
  return error;
}

function categoryForStatus(status) {
  if (status === 401 || status === 403) {
    return 'authentication';
  }
  if (status === 408 || status === 429) {
    return 'quota';
  }
  if (status >= 500) {
    return 'transient';
  }
  if (status >= 400) {
    return 'configuration';
  }
  return 'invalid-response';
}

function normalizeTimeout(value) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    return DEFAULT_TIMEOUT_MS;
  }
  return Math.min(MAX_TIMEOUT_MS, Math.max(MIN_TIMEOUT_MS, Math.floor(parsed)));
}

function normalizeProvider(provider) {
  const normalized = String(provider || '').trim();
  const slug = normalized.startsWith('@') ? normalized.slice(1) : normalized;
  if (!SAFE_SEGMENT_PATTERN.test(slug)) {
    throw createCacheClientError('configuration', 'configuration');
  }
  return Object.freeze({
    header: normalized,
    slug
  });
}

function normalizeGateway(baseUrl) {
  const candidate = String(baseUrl || DEFAULT_PORTKEY_GATEWAY)
    .trim()
    .replace(/\/+$/, '');
  let url;
  try {
    url = new URL(candidate);
  } catch {
    throw createCacheClientError('configuration', 'configuration');
  }

  const isLoopbackHttp =
    url.protocol === 'http:' &&
    (url.hostname === '127.0.0.1' || url.hostname === 'localhost');
  if (
    (url.protocol !== 'https:' && !isLoopbackHttp) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  ) {
    throw createCacheClientError('configuration', 'configuration');
  }
  return url.toString().replace(/\/+$/, '');
}

function requireSafeSegment(value, operation = 'configuration') {
  const normalized = String(value || '').trim();
  if (!SAFE_SEGMENT_PATTERN.test(normalized)) {
    throw createCacheClientError(operation, 'configuration');
  }
  return normalized;
}

function parseCacheName(name, expectedMetadata) {
  const segments = String(name || '').trim().split('/');
  if (
    segments.length !== 6 ||
    segments[0] !== 'projects' ||
    segments[2] !== 'locations' ||
    segments[4] !== 'cachedContents'
  ) {
    throw createCacheClientError('delete', 'configuration');
  }

  const project = requireSafeSegment(segments[1], 'delete');
  const location = requireSafeSegment(segments[3], 'delete');
  const id = requireSafeSegment(segments[5], 'delete');
  // Portkey may return a safe Vertex resource-project alias rather than the
  // service-account project used in the create URL. The location must remain
  // bound; every path segment is still strictly validated above.
  if (location !== expectedMetadata.location) {
    throw createCacheClientError('delete', 'configuration');
  }
  return `projects/${project}/locations/${location}/cachedContents/${id}`;
}

function createPortkeyVertexCacheClient(options = {}) {
  const apiKey = String(options.apiKey || '').trim();
  if (!apiKey || typeof options.fetch !== 'function' && typeof globalThis.fetch !== 'function') {
    throw createCacheClientError('configuration', 'configuration');
  }

  const provider = normalizeProvider(options.provider);
  const gateway = normalizeGateway(options.baseUrl);
  const fetchImpl = options.fetch || globalThis.fetch.bind(globalThis);
  const timeoutMs = normalizeTimeout(options.timeoutMs);
  const commonHeaders = Object.freeze({
    accept: 'application/json',
    'x-portkey-api-key': apiKey
  });
  const vertexHeaders = Object.freeze({
    ...commonHeaders,
    'content-type': 'application/json',
    'x-portkey-provider': provider.header,
    'x-portkey-custom-host': VERTEX_API_HOST
  });
  let metadataPromise = null;

  async function requestJson(operation, url, requestOptions = {}) {
    const controller = new AbortController();
    let timeout;
    let timedOut = false;
    const timeoutPromise = new Promise((resolve, reject) => {
      void resolve;
      timeout = setTimeout(() => {
        timedOut = true;
        controller.abort();
        reject(createCacheClientError(operation, 'timeout'));
      }, timeoutMs);
    });

    const fetchPromise = Promise.resolve()
      .then(() => fetchImpl(url, {
        ...requestOptions,
        signal: controller.signal
      }))
      .then(async (response) => {
        if (!response || typeof response.status !== 'number') {
          throw createCacheClientError(operation, 'invalid-response');
        }
        if (!response.ok) {
          throw createCacheClientError(
            operation,
            categoryForStatus(response.status),
            { status: response.status }
          );
        }
        try {
          return await response.json();
        } catch {
          throw createCacheClientError(operation, 'invalid-response', {
            status: response.status
          });
        }
      })
      .catch((error) => {
        if (error?.name === 'PortkeyVertexCacheError') {
          throw error;
        }
        if (timedOut || error?.name === 'AbortError') {
          throw createCacheClientError(operation, 'timeout');
        }
        throw createCacheClientError(operation, 'transient');
      });

    try {
      return await Promise.race([fetchPromise, timeoutPromise]);
    } finally {
      clearTimeout(timeout);
    }
  }

  async function discoverMetadata() {
    const metadata = await requestJson(
      'metadata discovery',
      `${gateway}/providers/${encodeURIComponent(provider.slug)}`,
      {
        method: 'GET',
        headers: commonHeaders
      }
    );
    if (
      !metadata ||
      Array.isArray(metadata) ||
      metadata.ai_provider_name !== 'vertex-ai'
    ) {
      throw createCacheClientError('metadata discovery', 'configuration');
    }

    const project = requireSafeSegment(
      metadata.model_config?.vertexServiceAccountJson?.project_id,
      'metadata discovery'
    );
    const location = requireSafeSegment(
      metadata.model_config?.vertexRegion,
      'metadata discovery'
    );
    return Object.freeze({ project, location });
  }

  function getMetadata() {
    if (!metadataPromise) {
      metadataPromise = discoverMetadata().catch((error) => {
        metadataPromise = null;
        throw error;
      });
    }
    return metadataPromise;
  }

  async function create({ model, config } = {}) {
    const metadata = await getMetadata();
    const modelSegment = requireSafeSegment(model, 'create');
    const safeConfig =
      config && typeof config === 'object' && !Array.isArray(config)
        ? config
        : {};
    const cacheConfiguration = {
      ...(typeof safeConfig.displayName === 'string'
        ? { displayName: safeConfig.displayName }
        : {}),
      ...(Array.isArray(safeConfig.contents)
        ? { contents: safeConfig.contents }
        : {}),
      ...(typeof safeConfig.ttl === 'string'
        ? { ttl: safeConfig.ttl }
        : {})
    };
    const created = await requestJson(
      'create',
      `${gateway}/projects/${metadata.project}/locations/${metadata.location}/cachedContents`,
      {
        method: 'POST',
        headers: vertexHeaders,
        body: JSON.stringify({
          ...cacheConfiguration,
          model:
            `projects/${metadata.project}/locations/${metadata.location}` +
            `/publishers/google/models/${modelSegment}`
        })
      }
    );
    if (!created || typeof created.name !== 'string') {
      throw createCacheClientError('create', 'invalid-response');
    }
    parseCacheName(created.name, metadata);
    return created;
  }

  async function remove({ name } = {}) {
    const metadata = await getMetadata();
    const safeName = parseCacheName(name, metadata);
    await requestJson('delete', `${gateway}/${safeName}`, {
      method: 'DELETE',
      headers: vertexHeaders
    });
  }

  return Object.freeze({
    caches: Object.freeze({
      create,
      delete: remove
    })
  });
}

module.exports = {
  DEFAULT_PORTKEY_GATEWAY,
  VERTEX_API_HOST,
  createPortkeyVertexCacheClient
};
