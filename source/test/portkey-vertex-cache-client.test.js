'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const {
  createPortkeyVertexCacheClient
} = require('../src/services/ai/portkey-vertex-cache-client');

const API_KEY = 'PORTKEY_VERTEX_CACHE_SECRET';
const PROVIDER = '@vertex';
const BASE_URL = 'https://gateway.portkey.invalid/v1';
const PROJECT = 'safe-project-123';
const LOCATION = 'us-central1';
const MODEL = 'gemini-3.8-flash';
const CACHE_NAME =
  `projects/${PROJECT}/locations/${LOCATION}/cachedContents/cache-123`;

function jsonResponse(status, payload) {
  return {
    ok: status >= 200 && status < 300,
    status,
    async json() {
      return payload;
    }
  };
}

function metadataResponse(overrides = {}) {
  return {
    ai_provider_name: 'vertex-ai',
    model_config: {
      vertexServiceAccountJson: {
        project_id: PROJECT
      },
      vertexRegion: LOCATION
    },
    ...overrides
  };
}

describe('Portkey Vertex explicit cache client', () => {
  it('discovers metadata lazily once and uses the Vertex create/delete wire contract', async () => {
    const calls = [];
    const fetch = async (url, options = {}) => {
      calls.push({
        url: String(url),
        method: options.method || 'GET',
        headers: { ...options.headers },
        body: options.body
      });

      if (String(url).endsWith('/providers/vertex')) {
        return jsonResponse(200, metadataResponse());
      }
      if (options.method === 'POST') {
        return jsonResponse(200, {
          name: CACHE_NAME,
          expireTime: '2026-09-10T04:00:00.000Z',
          usageMetadata: { totalTokenCount: 5000 }
        });
      }
      if (options.method === 'DELETE') {
        return jsonResponse(200, {});
      }
      throw new Error('unexpected fake request');
    };

    const client = createPortkeyVertexCacheClient({
      apiKey: API_KEY,
      provider: PROVIDER,
      baseUrl: BASE_URL,
      fetch
    });
    assert.deepEqual(calls, []);

    const created = await client.caches.create({
      model: MODEL,
      config: {
        displayName: 'open-cluely-safe-display',
        contents: [{
          role: 'user',
          parts: [{ text: 'stable prefix' }]
        }],
        ttl: '3600s'
      }
    });
    await client.caches.delete({ name: created.name });

    assert.equal(calls.length, 3);
    assert.deepEqual(calls[0], {
      url: `${BASE_URL}/providers/vertex`,
      method: 'GET',
      headers: {
        accept: 'application/json',
        'x-portkey-api-key': API_KEY
      },
      body: undefined
    });
    assert.equal(
      calls[1].url,
      `${BASE_URL}/projects/${PROJECT}/locations/${LOCATION}/cachedContents`
    );
    assert.equal(calls[1].method, 'POST');
    assert.deepEqual(calls[1].headers, {
      accept: 'application/json',
      'content-type': 'application/json',
      'x-portkey-api-key': API_KEY,
      'x-portkey-provider': PROVIDER,
      'x-portkey-custom-host': 'https://aiplatform.googleapis.com/v1'
    });
    assert.deepEqual(JSON.parse(calls[1].body), {
      model:
        `projects/${PROJECT}/locations/${LOCATION}/publishers/google/models/${MODEL}`,
      displayName: 'open-cluely-safe-display',
      contents: [{
        role: 'user',
        parts: [{ text: 'stable prefix' }]
      }],
      ttl: '3600s'
    });
    assert.equal(calls[2].url, `${BASE_URL}/${CACHE_NAME}`);
    assert.equal(calls[2].method, 'DELETE');
    assert.deepEqual(calls[2].headers, calls[1].headers);
  });

  it('deduplicates concurrent provider discovery while keeping creates distinct', async () => {
    let resolveMetadata;
    const metadata = new Promise((resolve) => {
      resolveMetadata = resolve;
    });
    let metadataCalls = 0;
    let createCalls = 0;
    const fetch = async (url, options = {}) => {
      if (String(url).endsWith('/providers/vertex')) {
        metadataCalls += 1;
        await metadata;
        return jsonResponse(200, metadataResponse());
      }
      if (options.method === 'POST') {
        createCalls += 1;
        return jsonResponse(200, {
          name:
            `projects/${PROJECT}/locations/${LOCATION}/cachedContents/cache-${createCalls}`
        });
      }
      throw new Error('unexpected fake request');
    };
    const client = createPortkeyVertexCacheClient({
      apiKey: API_KEY,
      provider: PROVIDER,
      baseUrl: BASE_URL,
      fetch
    });

    const first = client.caches.create({ model: MODEL, config: {} });
    const second = client.caches.create({ model: MODEL, config: {} });
    await Promise.resolve();
    assert.equal(metadataCalls, 1);

    resolveMetadata();
    const results = await Promise.all([first, second]);
    assert.equal(createCalls, 2);
    assert.equal(results.length, 2);
  });

  it('accepts Portkey safe project aliases in returned cache resource names', async () => {
    const aliasName =
      `projects/vertex-resource-alias/locations/${LOCATION}/cachedContents/cache-alias`;
    const calls = [];
    const client = createPortkeyVertexCacheClient({
      apiKey: API_KEY,
      provider: PROVIDER,
      baseUrl: BASE_URL,
      fetch: async (url, options = {}) => {
        calls.push({ url: String(url), method: options.method || 'GET' });
        if (String(url).endsWith('/providers/vertex')) {
          return jsonResponse(200, metadataResponse());
        }
        if (options.method === 'POST') {
          return jsonResponse(200, { name: aliasName });
        }
        if (options.method === 'DELETE') {
          return jsonResponse(200, {});
        }
        throw new Error('unexpected fake request');
      }
    });

    const created = await client.caches.create({ model: MODEL, config: {} });
    await client.caches.delete({ name: created.name });

    assert.equal(created.name, aliasName);
    assert.equal(calls.at(-1).url, `${BASE_URL}/${aliasName}`);
  });

  it('rejects non-Vertex and unsafe metadata without exposing sensitive values', async () => {
    const unsafeProject = 'project/../../SECRET_PROJECT';
    const responseBodySecret = 'RESPONSE_BODY_SECRET';
    const cases = [
      metadataResponse({ ai_provider_name: 'openai' }),
      metadataResponse({
        model_config: {
          vertexServiceAccountJson: { project_id: unsafeProject },
          vertexRegion: LOCATION
        }
      })
    ];

    for (const providerMetadata of cases) {
      const client = createPortkeyVertexCacheClient({
        apiKey: API_KEY,
        provider: PROVIDER,
        baseUrl: BASE_URL,
        fetch: async () => jsonResponse(200, {
          ...providerMetadata,
          responseBodySecret
        })
      });

      await assert.rejects(
        client.caches.create({
          model: 'unsafe/model',
          config: {
            contents: [{ parts: [{ text: 'PREFIX_SECRET' }] }]
          }
        }),
        (error) => {
          const serialized = JSON.stringify({
            message: error.message,
            code: error.code,
            category: error.category
          });
          assert.equal(error.category, 'configuration');
          for (const sensitive of [
            API_KEY,
            unsafeProject,
            responseBodySecret,
            'PREFIX_SECRET',
            'unsafe/model'
          ]) {
            assert.equal(serialized.includes(sensitive), false);
          }
          return true;
        }
      );
    }
  });

  it('categorizes HTTP failures and timeouts without response or resource details', async () => {
    const responseSecret = 'PRIVATE_RESPONSE_BODY';
    const cacheNameSecret =
      `projects/${PROJECT}/locations/${LOCATION}/cachedContents/private-cache`;
    const httpClient = createPortkeyVertexCacheClient({
      apiKey: API_KEY,
      provider: PROVIDER,
      baseUrl: BASE_URL,
      fetch: async (url, options = {}) => {
        if (String(url).endsWith('/providers/vertex')) {
          return jsonResponse(200, metadataResponse());
        }
        if (options.method === 'DELETE') {
          return jsonResponse(403, { error: responseSecret });
        }
        throw new Error('unexpected fake request');
      }
    });

    await assert.rejects(
      httpClient.caches.delete({ name: cacheNameSecret }),
      (error) => {
        assert.equal(error.category, 'authentication');
        assert.equal(error.status, 403);
        assert.doesNotMatch(error.message, new RegExp([
          API_KEY,
          responseSecret,
          PROJECT,
          'private-cache'
        ].join('|')));
        return true;
      }
    );

    const timeoutClient = createPortkeyVertexCacheClient({
      apiKey: API_KEY,
      provider: PROVIDER,
      baseUrl: BASE_URL,
      timeoutMs: 10,
      fetch: async (_url, options = {}) => new Promise((resolve, reject) => {
        void resolve;
        options.signal.addEventListener('abort', () => {
          reject(Object.assign(new Error('ABORT_SECRET'), {
            name: 'AbortError'
          }));
        }, { once: true });
      })
    });

    await assert.rejects(
      timeoutClient.caches.create({
        model: MODEL,
        config: {
          contents: [{ parts: [{ text: 'TIMEOUT_PREFIX_SECRET' }] }]
        }
      }),
      (error) => {
        assert.equal(error.category, 'timeout');
        assert.match(error.message, /timed out/i);
        assert.doesNotMatch(
          error.message,
          /ABORT_SECRET|TIMEOUT_PREFIX_SECRET|PORTKEY_VERTEX_CACHE_SECRET/
        );
        return true;
      }
    );
  });
});
