'use strict';

const { EventEmitter } = require('node:events');
const net = require('node:net');
const { performance } = require('node:perf_hooks');
const test = require('node:test');
const assert = require('node:assert/strict');

const PortkeyService = require('../src/services/ai/portkey-service');
const {
  createPortkeyVertexCacheClient
} = require('../src/services/ai/portkey-vertex-cache-client');
const {
  createBackgroundMemoryGenerator
} = require('../src/services/ai/background-memory-generator');
const {
  E2E_MODEL,
  E2E_MEMORY_MODEL,
  E2E_MEMORY_NOTE,
  E2E_MEMORY_TOPIC,
  E2E_PORTKEY_API_KEY,
  E2E_PORTKEY_PROVIDER,
  createFakePortkeyGateway
} = require('../scripts/e2e/fake-portkey-gateway');
const { connectCdp } = require('../scripts/e2e/cdp-client');

function createFakeWebSocketClass(onSend = () => {}, options = {}) {
  const autoOpen = options.autoOpen !== false;
  const emitCloseOnClose = options.emitCloseOnClose !== false;
  const emitCloseOnTerminate = options.emitCloseOnTerminate !== false;

  class FakeWebSocket extends EventEmitter {
    constructor(url) {
      super();
      this.url = url;
      this.readyState = FakeWebSocket.CONNECTING;
      this.sent = [];
      this.closeCalls = 0;
      this.terminateCalls = 0;
      FakeWebSocket.instances.push(this);

      if (autoOpen) {
        queueMicrotask(() => {
          if (this.readyState !== FakeWebSocket.CONNECTING) {
            return;
          }
          this.readyState = FakeWebSocket.OPEN;
          this.emit('open');
        });
      }
    }

    send(payload) {
      const message = JSON.parse(String(payload));
      this.sent.push(message);
      onSend(message, this);
    }

    close() {
      this.closeCalls += 1;
      if (this.readyState === FakeWebSocket.CLOSED) {
        return;
      }
      this.readyState = FakeWebSocket.CLOSING;
      if (emitCloseOnClose) {
        this.emitClose();
      }
    }

    terminate() {
      this.terminateCalls += 1;
      if (emitCloseOnTerminate) {
        this.emitClose();
      }
    }

    emitClose() {
      if (this.readyState === FakeWebSocket.CLOSED) {
        return;
      }
      this.readyState = FakeWebSocket.CLOSED;
      this.emit('close', 1000, Buffer.from('closed'));
    }
  }

  FakeWebSocket.CONNECTING = 0;
  FakeWebSocket.OPEN = 1;
  FakeWebSocket.CLOSING = 2;
  FakeWebSocket.CLOSED = 3;
  FakeWebSocket.instances = [];
  return FakeWebSocket;
}

async function withTestBound(promise, milliseconds = 250) {
  let timeout;
  try {
    return await Promise.race([
      promise,
      new Promise((resolve, reject) => {
        timeout = setTimeout(() => {
          reject(new Error(`test operation exceeded ${milliseconds}ms`));
        }, milliseconds);
      })
    ]);
  } finally {
    clearTimeout(timeout);
  }
}

function listen(server, port, host) {
  return new Promise((resolve, reject) => {
    const onError = (error) => {
      server.off('listening', onListening);
      reject(error);
    };
    const onListening = () => {
      server.off('error', onError);
      resolve();
    };

    server.once('error', onError);
    server.once('listening', onListening);
    server.listen(port, host);
  });
}

function closeServer(server) {
  return new Promise((resolve, reject) => {
    server.close((error) => {
      if (error) {
        reject(error);
        return;
      }
      resolve();
    });
  });
}

test('fake Portkey gateway streams ordered SSE through PortkeyService on loopback', async (t) => {
  const fake = await createFakePortkeyGateway({
    chunks: ['Stream', 'ing ', 'works'],
    chunkDelayMs: 20
  });
  t.after(() => fake.close());

  const endpoint = new URL(fake.baseUrl);
  assert.equal(endpoint.protocol, 'http:');
  assert.equal(endpoint.hostname, '127.0.0.1');
  assert.ok(Number(endpoint.port) > 0);
  assert.equal(endpoint.pathname, '/v1');

  const service = new PortkeyService({
    apiKey: E2E_PORTKEY_API_KEY,
    provider: E2E_PORTKEY_PROVIDER,
    baseUrl: fake.baseUrl,
    modelName: E2E_MODEL,
    minRequestInterval: 0
  });

  const startedAt = performance.now();
  const arrivals = [];
  let requestSettled = false;
  const resultPromise = service.generateText('test request', {
    onChunk(chunk) {
      arrivals.push({
        ...chunk,
        atMs: performance.now() - startedAt,
        requestSettled
      });
    }
  }).finally(() => {
    requestSettled = true;
  });

  assert.equal(await resultPromise, 'Streaming works');
  assert.deepEqual(
    arrivals.map(({ text, index }) => ({ text, index })),
    [
      { text: 'Stream', index: 1 },
      { text: 'ing ', index: 2 },
      { text: 'works', index: 3 }
    ]
  );
  assert.ok(arrivals.every(({ requestSettled: settled }) => settled === false));
  assert.ok(arrivals[1].atMs - arrivals[0].atMs >= 5);
  assert.ok(arrivals[2].atMs - arrivals[1].atMs >= 5);
  assert.deepEqual(fake.requests, [{
    model: E2E_MODEL,
    messages: [{ role: 'user', content: 'test request' }],
    stream: true
  }]);
});

test('fake Portkey gateway supports non-streaming PortkeyService responses', async (t) => {
  const fake = await createFakePortkeyGateway({
    chunks: ['complete ', 'answer'],
    chunkDelayMs: 0
  });
  t.after(() => fake.close());

  const service = new PortkeyService({
    apiKey: E2E_PORTKEY_API_KEY,
    provider: E2E_PORTKEY_PROVIDER,
    baseUrl: fake.baseUrl,
    modelName: E2E_MODEL,
    minRequestInterval: 0
  });

  assert.equal(await service.generateText('test request'), 'complete answer');
  assert.deepEqual(fake.requests, [{
    model: E2E_MODEL,
    messages: [{ role: 'user', content: 'test request' }],
    stream: false
  }]);
});

test('fake Portkey gateway exercises cached primary streaming and uncached fallback locally', async (t) => {
  const provider = '@vertex-e2e';
  const fake = await createFakePortkeyGateway({
    chunks: ['cached ', 'stream'],
    chunkDelayMs: 0,
    provider,
    enableVertexCache: true
  });
  t.after(() => fake.close());

  const cacheClient = createPortkeyVertexCacheClient({
    apiKey: E2E_PORTKEY_API_KEY,
    provider,
    baseUrl: fake.baseUrl,
    fetch
  });
  const created = await cacheClient.caches.create({
    model: E2E_MODEL,
    config: {
      displayName: 'e2e-cache',
      contents: [{
        role: 'user',
        parts: [{ text: 'E2E stable prefix'.repeat(400) }]
      }],
      ttl: '3600s'
    }
  });

  const service = new PortkeyService({
    apiKey: E2E_PORTKEY_API_KEY,
    provider,
    baseUrl: fake.baseUrl,
    modelName: E2E_MODEL,
    minRequestInterval: 0
  });
  const primary = await service.generateText('live primary turn', {
    cachedContentName: created.name,
    onChunk() {}
  });
  service.updateConfiguration({ modelName: 'gemini-3.7-flash' });
  const fallback = await service.generateText('full fallback prompt', {
    cacheSuppressed: true,
    cachedContentName: created.name,
    onChunk() {}
  });
  await cacheClient.caches.delete({ name: created.name });

  assert.equal(primary, 'cached stream');
  assert.equal(fallback, 'cached stream');
  assert.deepEqual(fake.cacheRequests.map(({ action }) => action), [
    'metadata',
    'create',
    'delete'
  ]);
  assert.deepEqual(fake.requests.map((request) => ({
    model: request.model,
    cached: request.cached
  })), [
    { model: E2E_MODEL, cached: true },
    { model: 'gemini-3.7-flash', cached: false }
  ]);
});

test('fake Portkey gateway recognizes isolated background memory requests', async (t) => {
  const fake = await createFakePortkeyGateway({
    chunks: ['foreground response'],
    chunkDelayMs: 0
  });
  t.after(() => fake.close());

  const generator = createBackgroundMemoryGenerator({
    provider: 'portkey',
    portkeyApiKey: E2E_PORTKEY_API_KEY,
    portkeyProvider: E2E_PORTKEY_PROVIDER,
    portkeyBaseUrl: fake.baseUrl
  });
  const summary = await generator.generateText([
    'You maintain structured interview/session memory for a live assistant.',
    'Return ONLY valid JSON with this exact shape:',
    '{"currentTopic":"string","proposedDurableNotes":[{"text":"string"}]}'
  ].join('\n'));

  assert.equal(summary.currentTopic, E2E_MEMORY_TOPIC);
  assert.equal(summary.proposedDurableNotes[0].text, E2E_MEMORY_NOTE);
  assert.deepEqual(fake.requests, [{
    model: E2E_MEMORY_MODEL,
    messages: [{
      role: 'user',
      content: [
        'You maintain structured interview/session memory for a live assistant.',
        'Return ONLY valid JSON with this exact shape:',
        '{"currentTopic":"string","proposedDurableNotes":[{"text":"string"}]}'
      ].join('\n')
    }],
    stream: false,
    memory: {
      temperature: 0.2,
      responseFormat: { type: 'json_object' },
      thinking: { type: 'enabled', budget_tokens: 256 },
      reasoning: { effort: 'none' }
    }
  }]);
});

test('fake Portkey gateway rejects invalid chat payloads without recording them', async (t) => {
  const fake = await createFakePortkeyGateway({
    chunks: ['unused'],
    chunkDelayMs: 0
  });
  t.after(() => fake.close());

  const validRequest = {
    model: E2E_MODEL,
    messages: [],
    stream: false
  };
  const invalidPayloads = [
    null,
    [],
    { ...validRequest, model: '' },
    { ...validRequest, model: '   ' },
    { ...validRequest, model: 42 },
    { ...validRequest, messages: null },
    { ...validRequest, messages: {} },
    { ...validRequest, stream: 'false' },
    { model: validRequest.model, messages: validRequest.messages }
  ];

  for (const payload of invalidPayloads) {
    const response = await fetch(`${fake.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-portkey-api-key': E2E_PORTKEY_API_KEY,
        'x-portkey-provider': E2E_PORTKEY_PROVIDER
      },
      body: JSON.stringify(payload)
    });

    assert.equal(response.status, 400);
    assert.match(response.headers.get('content-type') || '', /^application\/json\b/);
    assert.deepEqual(await response.json(), {
      error: {
        message: 'invalid chat payload',
        type: 'invalid_request_error'
      }
    });
    assert.deepEqual(fake.requests, []);
  }
});

test('fake Portkey gateway accepts only its configured synthetic credentials', async (t) => {
  const fake = await createFakePortkeyGateway({
    chunks: ['unused'],
    chunkDelayMs: 0
  });
  t.after(() => fake.close());

  const request = {
    model: E2E_MODEL,
    messages: [],
    stream: false
  };
  const response = await fetch(`${fake.baseUrl}/chat/completions`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-portkey-api-key': 'wrong-test-key',
      'x-portkey-provider': '@unsupported'
    },
    body: JSON.stringify(request)
  });

  assert.equal(response.status, 401);
  assert.deepEqual(await response.json(), {
    error: {
      message: 'unauthorized fake gateway request',
      type: 'authentication_error'
    }
  });
  assert.deepEqual(fake.requests, []);
});

test('fake Portkey gateway close is idempotent and releases its port', async () => {
  const fake = await createFakePortkeyGateway({
    chunks: [],
    chunkDelayMs: 0
  });
  const endpoint = new URL(fake.baseUrl);
  const port = Number(endpoint.port);

  await fake.close();
  await fake.close();

  const replacement = net.createServer();
  await listen(replacement, port, '127.0.0.1');
  await closeServer(replacement);
});

test('CDP connection attempts time out within a configured bound', {
  timeout: 1000
}, async () => {
  const FakeWebSocket = createFakeWebSocketClass(() => {}, {
    autoOpen: false
  });

  await assert.rejects(
    withTestBound(
      connectCdp(
        'ws://127.0.0.1:9222/devtools/page/never-opens',
        FakeWebSocket,
        { connectTimeoutMs: 20 }
      )
    ),
    /^Error: CDP WebSocket connection timed out after 20ms$/
  );

  const socket = FakeWebSocket.instances[0];
  assert.ok(socket.closeCalls + socket.terminateCalls >= 1);
});

test('CDP calls correlate out-of-order responses by numeric id', async (t) => {
  const queued = [];
  const FakeWebSocket = createFakeWebSocketClass((message, socket) => {
    queued.push(message);
    if (queued.length !== 2) {
      return;
    }

    queueMicrotask(() => {
      socket.emit('message', Buffer.from(JSON.stringify({
        id: queued[1].id,
        result: { value: 'second-result' }
      })));
      socket.emit('message', JSON.stringify({
        id: queued[0].id,
        result: { value: 'first-result' }
      }));
    });
  });

  const client = await connectCdp(
    'ws://127.0.0.1:9222/devtools/page/example',
    FakeWebSocket
  );
  t.after(() => client.close());

  const first = client.call('Example.first', { order: 1 });
  const second = client.call('Example.second', { order: 2 });

  assert.deepEqual(await first, { value: 'first-result' });
  assert.deepEqual(await second, { value: 'second-result' });

  const sent = FakeWebSocket.instances[0].sent;
  assert.equal(sent[0].id + 1, sent[1].id);
  assert.deepEqual(sent.map(({ method, params }) => ({ method, params })), [
    { method: 'Example.first', params: { order: 1 } },
    { method: 'Example.second', params: { order: 2 } }
  ]);
});

test('CDP commands time out within a bound and ignore late responses', {
  timeout: 1000
}, async (t) => {
  const FakeWebSocket = createFakeWebSocketClass();
  const client = await connectCdp(
    'ws://127.0.0.1/devtools/page/command-timeout',
    FakeWebSocket,
    { commandTimeoutMs: 20 }
  );
  t.after(() => client.close());

  const socket = FakeWebSocket.instances[0];
  await assert.rejects(
    withTestBound(client.call('Runtime.enable')),
    /^Error: CDP command timed out after 20ms$/
  );

  socket.emit('message', JSON.stringify({
    id: socket.sent[0].id,
    result: { late: true }
  }));
  await new Promise((resolve) => setImmediate(resolve));
});

test('CDP evaluate unwraps return-by-value results and waitFor polls truthy values', async (t) => {
  let evaluationCount = 0;
  const FakeWebSocket = createFakeWebSocketClass((message, socket) => {
    evaluationCount += 1;
    const value = evaluationCount < 3 ? false : { ready: true };
    queueMicrotask(() => {
      socket.emit('message', JSON.stringify({
        id: message.id,
        result: {
          result: {
            type: typeof value,
            value
          }
        }
      }));
    });
  });

  const client = await connectCdp('ws://127.0.0.1/devtools/page/example', FakeWebSocket);
  t.after(() => client.close());

  const result = await client.waitFor('globalThis.__e2eReady === true', {
    timeoutMs: 200,
    intervalMs: 1
  });

  assert.deepEqual(result, { ready: true });
  assert.equal(evaluationCount, 3);
  for (const message of FakeWebSocket.instances[0].sent) {
    assert.equal(message.method, 'Runtime.evaluate');
    assert.deepEqual(message.params, {
      expression: 'globalThis.__e2eReady === true',
      awaitPromise: true,
      returnByValue: true
    });
  }
});

test('CDP waitFor times out within a bound without exposing its expression', {
  timeout: 1000
}, async (t) => {
  let evaluationCount = 0;
  const FakeWebSocket = createFakeWebSocketClass((message, socket) => {
    evaluationCount += 1;
    queueMicrotask(() => {
      socket.emit('message', JSON.stringify({
        id: message.id,
        result: {
          result: { type: 'boolean', value: false }
        }
      }));
    });
  });

  const client = await connectCdp('ws://127.0.0.1/devtools/page/example', FakeWebSocket);
  t.after(() => client.close());

  const startedAt = Date.now();
  await assert.rejects(
    client.waitFor("document.body.textContent.includes('TOP_SECRET_VALUE')", {
      timeoutMs: 30,
      intervalMs: 2
    }),
    (error) => {
      assert.match(error.message, /^CDP wait timed out after 30ms$/);
      assert.doesNotMatch(error.message, /TOP_SECRET_VALUE/);
      return true;
    }
  );

  assert.ok(evaluationCount > 1);
  assert.ok(Date.now() - startedAt < 500);
});

test('CDP waitFor keeps polling when evaluate commands go unanswered', {
  timeout: 1000
}, async (t) => {
  const FakeWebSocket = createFakeWebSocketClass();
  const client = await connectCdp(
    'ws://127.0.0.1/devtools/page/unanswered-evaluate',
    FakeWebSocket,
    { commandTimeoutMs: 5 }
  );
  t.after(() => client.close());

  await assert.rejects(
    client.waitFor('globalThis.__neverReady', {
      timeoutMs: 35,
      intervalMs: 1
    }),
    /^Error: CDP wait timed out after 35ms$/
  );

  assert.ok(
    FakeWebSocket.instances[0].sent.length >= 2,
    'timed-out evaluate calls must not block later polls'
  );
});

test('CDP close waits for the socket close event before rejecting pending calls', async () => {
  const FakeWebSocket = createFakeWebSocketClass(() => {}, {
    emitCloseOnClose: false
  });
  const client = await connectCdp(
    'ws://127.0.0.1/devtools/page/delayed-close',
    FakeWebSocket,
    {
      commandTimeoutMs: 500,
      closeTimeoutMs: 200
    }
  );
  const socket = FakeWebSocket.instances[0];

  const pendingOutcome = client.call('Runtime.enable').then(
    () => ({ status: 'resolved' }),
    (error) => ({ status: 'rejected', error })
  );
  const firstClose = client.close();
  const secondClose = client.close();
  let closeSettled = false;
  firstClose.finally(() => {
    closeSettled = true;
  });

  const pendingBeforeClose = await Promise.race([
    pendingOutcome,
    new Promise((resolve) => {
      setImmediate(() => resolve({ status: 'pending' }));
    })
  ]);
  const closeSettledBeforeEvent = closeSettled;

  socket.emitClose();
  await firstClose;
  const pendingAfterClose = await pendingOutcome;

  assert.equal(secondClose, firstClose);
  assert.equal(closeSettledBeforeEvent, false);
  assert.deepEqual(pendingBeforeClose, { status: 'pending' });
  assert.equal(pendingAfterClose.status, 'rejected');
  assert.match(pendingAfterClose.error.message, /^CDP client closed$/);
});

test('CDP close force-terminates a socket that never emits close', {
  timeout: 1000
}, async () => {
  const FakeWebSocket = createFakeWebSocketClass(() => {}, {
    emitCloseOnClose: false,
    emitCloseOnTerminate: false
  });
  const client = await connectCdp(
    'ws://127.0.0.1/devtools/page/stuck-close',
    FakeWebSocket,
    { closeTimeoutMs: 20 }
  );
  const socket = FakeWebSocket.instances[0];

  const firstClose = client.close();
  const secondClose = client.close();
  await withTestBound(firstClose);

  assert.equal(secondClose, firstClose);
  assert.equal(socket.closeCalls, 1);
  assert.equal(socket.terminateCalls, 1);
});

test('CDP rejects pending calls when the socket errors or closes', async (t) => {
  await t.test('socket error', async () => {
    const FakeWebSocket = createFakeWebSocketClass();
    const client = await connectCdp('ws://127.0.0.1/devtools/page/error', FakeWebSocket);
    const socket = FakeWebSocket.instances[0];

    const rejection = assert.rejects(
      client.call('Runtime.enable'),
      (error) => {
        assert.match(error.message, /CDP WebSocket/i);
        assert.doesNotMatch(error.message, /unsafe socket detail/);
        return true;
      }
    );
    socket.emit('error', new Error('unsafe socket detail'));
    await rejection;
    await client.close();
  });

  await t.test('socket close', async () => {
    const FakeWebSocket = createFakeWebSocketClass();
    const client = await connectCdp('ws://127.0.0.1/devtools/page/close', FakeWebSocket);
    const socket = FakeWebSocket.instances[0];

    const rejection = assert.rejects(
      client.call('Runtime.enable'),
      /CDP WebSocket closed/i
    );
    socket.close();
    await rejection;
    await client.close();
  });
});
