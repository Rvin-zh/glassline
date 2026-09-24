'use strict';

const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const assert = require('node:assert/strict');

const {
  getEnvPath,
  loadApplicationEnvironment
} = require('../src/bootstrap/environment');
const appState = require('../src/services/state/app-state');
const { createMobileServer } = require('../src/main-process/features/mobile-server/server');

function restoreEnvironmentVariable(t, name) {
  const previousValue = process.env[name];
  t.after(() => {
    if (previousValue === undefined) {
      delete process.env[name];
    } else {
      process.env[name] = previousValue;
    }
  });
}

function replaceHttpServerWithFake(t) {
  const originalCreateServer = http.createServer;
  let listenCalls = 0;

  http.createServer = () => {
    const server = new EventEmitter();
    server.listen = () => {
      listenCalls += 1;
    };
    server.close = () => {};
    return server;
  };

  t.after(() => {
    http.createServer = originalCreateServer;
  });

  return {
    get listenCalls() {
      return listenCalls;
    }
  };
}

function createMobileServerDependencies(overrides = {}) {
  return {
    getGeminiRuntime: () => null,
    getScreenshotManager: () => null,
    notifyDesktop: () => {},
    ...overrides
  };
}

test('OPEN_CLUELY_STATE_DIR overrides the app state base directory', (t) => {
  restoreEnvironmentVariable(t, 'OPEN_CLUELY_STATE_DIR');
  process.env.OPEN_CLUELY_STATE_DIR = '/tmp/example';

  const expectedBaseDir = path.resolve('/tmp/example');
  const expectedStatePath = path.join(expectedBaseDir, 'cache', 'app-state.json');
  const packagedApp = {
    isPackaged: true,
    getPath: () => '/normal/user-data'
  };

  assert.equal(appState.getAppStatePath(packagedApp), expectedStatePath);
  assert.equal(appState.getAppStateBaseDir(packagedApp), expectedBaseDir);
});

test('OPEN_CLUELY_ENV_PATH makes environment loading use only the explicit file', (t) => {
  const environmentNames = [
    'OPEN_CLUELY_ENV_PATH',
    'GEMINI_API_KEY',
    'ASSEMBLY_AI_API_KEY',
    'HIDE_FROM_SCREEN_CAPTURE',
    'START_HIDDEN',
    'MAX_SCREENSHOTS',
    'SCREENSHOT_DELAY',
    'NODE_ENV',
    'NODE_OPTIONS'
  ];
  for (const name of environmentNames) {
    restoreEnvironmentVariable(t, name);
    delete process.env[name];
  }

  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'open-cluely-env-test-'));
  const explicitEnvPath = path.join(directory, 'empty.env');
  fs.writeFileSync(explicitEnvPath, '', { encoding: 'utf8', mode: 0o600 });
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  process.env.OPEN_CLUELY_ENV_PATH = explicitEnvPath;

  const app = { isPackaged: false };
  const loaded = loadApplicationEnvironment(app);

  assert.equal(getEnvPath(app), explicitEnvPath);
  assert.equal(loaded.envPath, explicitEnvPath);
  assert.equal(loaded.startHidden, false);
  assert.equal(loaded.geminiApiKey, '');
  assert.equal(loaded.assemblyAiApiKey, '');
});

test('an explicitly disabled mobile server never listens and keeps its public interface', (t) => {
  const fakeHttpServer = replaceHttpServerWithFake(t);
  const notifications = [];
  const mobileServer = createMobileServer(createMobileServerDependencies({
    disabled: true,
    notifyDesktop: (channel, payload) => notifications.push({ channel, payload })
  }));

  assert.equal(fakeHttpServer.listenCalls, 0);
  assert.equal(typeof mobileServer.broadcast, 'function');
  assert.equal(typeof mobileServer.getStatus, 'function');
  assert.equal(typeof mobileServer.emitStatus, 'function');
  assert.equal(typeof mobileServer.close, 'function');

  const status = mobileServer.getStatus();
  assert.equal(status.listening, false);
  assert.equal(status.error, null);
  assert.equal(status.reason, 'disabled-for-e2e');

  assert.doesNotThrow(() => mobileServer.broadcast('example', { ok: true }));
  mobileServer.emitStatus();
  assert.deepEqual(notifications, [{
    channel: 'mobile-server-status',
    payload: status
  }]);
  assert.doesNotThrow(() => mobileServer.close());
});

test('OPEN_CLUELY_DISABLE_MOBILE supplies the default but explicit false enables listening', (t) => {
  restoreEnvironmentVariable(t, 'OPEN_CLUELY_DISABLE_MOBILE');
  process.env.OPEN_CLUELY_DISABLE_MOBILE = '1';
  const fakeHttpServer = replaceHttpServerWithFake(t);

  const disabledServer = createMobileServer(createMobileServerDependencies());
  assert.equal(fakeHttpServer.listenCalls, 0);
  assert.equal(disabledServer.getStatus().listening, false);
  assert.equal(disabledServer.getStatus().error, null);
  disabledServer.close();

  const enabledServer = createMobileServer(createMobileServerDependencies({
    disabled: false
  }));
  assert.equal(fakeHttpServer.listenCalls, 1);
  enabledServer.close();
});
