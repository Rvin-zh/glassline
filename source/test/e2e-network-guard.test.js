'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  E2E_HOST_RESOLVER_RULES,
  applyE2EChromiumNetworkPolicy,
  installE2ENodeNetworkPolicy,
  installE2ESessionNetworkPolicy
} = require('../src/platform/e2e-network-guard');

const ENABLED_ENVIRONMENT = Object.freeze({
  OPEN_CLUELY_E2E_NETWORK_POLICY: 'loopback-only'
});

function createNodeGuardHarness() {
  const calls = [];
  const events = [];
  const globalObject = {
    fetch(input) {
      calls.push({ transport: 'fetch', input });
      return Promise.resolve({ ok: true });
    }
  };
  const httpModule = {
    request(...args) {
      calls.push({ transport: 'http', args });
      return { transport: 'http' };
    },
    get(...args) {
      calls.push({ transport: 'http-get', args });
      return { transport: 'http-get' };
    }
  };
  const httpsModule = {
    request(...args) {
      calls.push({ transport: 'https', args });
      return { transport: 'https' };
    },
    get(...args) {
      calls.push({ transport: 'https-get', args });
      return { transport: 'https-get' };
    }
  };
  const netModule = {
    connect(...args) {
      calls.push({ transport: 'net', args });
      return { transport: 'net' };
    },
    createConnection(...args) {
      calls.push({ transport: 'net-create', args });
      return { transport: 'net-create' };
    }
  };
  const tlsModule = {
    connect(...args) {
      calls.push({ transport: 'tls', args });
      return { transport: 'tls' };
    }
  };

  return {
    calls,
    events,
    globalObject,
    httpModule,
    httpsModule,
    netModule,
    tlsModule,
    install(environment = ENABLED_ENVIRONMENT) {
      return installE2ENodeNetworkPolicy({
        environment,
        globalObject,
        httpModule,
        httpsModule,
        netModule,
        tlsModule,
        onPolicyEvent: (event) => events.push(event)
      });
    }
  };
}

test('Node network policy is inert unless explicitly enabled', async () => {
  const harness = createNodeGuardHarness();
  const originalFetch = harness.globalObject.fetch;

  const installation = harness.install({});

  assert.equal(installation.enabled, false);
  assert.equal(harness.globalObject.fetch, originalFetch);
  assert.deepEqual(harness.events, []);
  assert.deepEqual(
    await harness.globalObject.fetch('https://example.invalid/private'),
    { ok: true }
  );
});

test('Node network policy permits loopback and blocks outbound fetch and sockets safely', async (t) => {
  const harness = createNodeGuardHarness();
  const installation = harness.install();
  t.after(() => installation.restore());

  await harness.globalObject.fetch('http://127.0.0.1:11434/api/chat');
  harness.httpModule.request(new URL('http://localhost:11434/api/tags'));
  harness.netModule.connect(11434, '::1');

  const sensitiveTarget = 'https://secret.example/private-payload-token';
  await assert.rejects(
    harness.globalObject.fetch(sensitiveTarget),
    (error) => {
      assert.equal(error.code, 'OPEN_CLUELY_E2E_NETWORK_BLOCKED');
      assert.doesNotMatch(error.message, /secret|payload|token|example/i);
      return true;
    }
  );
  assert.throws(
    () => harness.httpsModule.request(sensitiveTarget),
    (error) => {
      assert.equal(error.code, 'OPEN_CLUELY_E2E_NETWORK_BLOCKED');
      assert.doesNotMatch(error.message, /secret|payload|token|example/i);
      return true;
    }
  );
  assert.throws(
    () => harness.tlsModule.connect({ host: 'secret.example', port: 443 }),
    { code: 'OPEN_CLUELY_E2E_NETWORK_BLOCKED' }
  );

  assert.deepEqual(
    harness.calls.map(({ transport }) => transport),
    ['fetch', 'http', 'net']
  );
  assert.deepEqual(harness.events, [
    { type: 'policy-ready', transport: 'node' },
    { type: 'blocked-outbound', transport: 'fetch' },
    { type: 'blocked-outbound', transport: 'https' },
    { type: 'blocked-outbound', transport: 'tls' }
  ]);
});

test('renderer session policy allows local resources and cancels outbound requests', () => {
  const events = [];
  let listener = null;
  const session = {
    webRequest: {
      onBeforeRequest(filter, callback) {
        assert.deepEqual(filter, { urls: ['*://*/*'] });
        listener = callback;
      }
    }
  };

  const installation = installE2ESessionNetworkPolicy(session, {
    environment: ENABLED_ENVIRONMENT,
    onPolicyEvent: (event) => events.push(event)
  });

  assert.equal(installation.enabled, true);
  assert.equal(typeof listener, 'function');

  const decisions = [];
  for (const url of [
    'file:///tmp/renderer.html',
    'data:text/plain,local',
    'http://127.0.0.1:41234/api/tags',
    'ws://localhost:9222/devtools',
    'https://secret.example/private-payload-token'
  ]) {
    listener({ url }, (decision) => decisions.push(decision));
  }

  assert.deepEqual(decisions, [
    { cancel: false },
    { cancel: false },
    { cancel: false },
    { cancel: false },
    { cancel: true }
  ]);
  assert.deepEqual(events, [
    { type: 'policy-ready', transport: 'renderer' },
    { type: 'blocked-outbound', transport: 'renderer' }
  ]);
});

test('Chromium DNS isolation switches are opt-in and preserve existing disabled features', () => {
  const values = new Map([['disable-features', 'ExistingFeature']]);
  const commandLine = {
    appendSwitch(name, value = '') {
      values.set(name, value);
    },
    getSwitchValue(name) {
      return values.get(name) || '';
    }
  };
  const app = { commandLine };

  assert.equal(applyE2EChromiumNetworkPolicy(app, { environment: {} }), false);
  assert.deepEqual([...values], [['disable-features', 'ExistingFeature']]);

  assert.equal(
    applyE2EChromiumNetworkPolicy(app, { environment: ENABLED_ENVIRONMENT }),
    true
  );
  assert.equal(values.get('dns-prefetch-disable'), '');
  assert.equal(values.get('host-resolver-rules'), E2E_HOST_RESOLVER_RULES);
  assert.deepEqual(
    new Set(values.get('disable-features').split(',')),
    new Set(['ExistingFeature', 'AsyncDns', 'DnsOverHttps'])
  );
});
