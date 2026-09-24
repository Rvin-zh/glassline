'use strict';

const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const assert = require('node:assert/strict');

const config = require('../src/config');
const {
  createInvokeActions
} = require('../src/windows/assistant/preload/actions');
const {
  createEventActions
} = require('../src/windows/assistant/preload/listeners');
const {
  getDefaultAppState,
  sanitizeAppState
} = require('../src/services/state/app-state');
const screenshotManagerModule =
  require('../src/main-process/features/assistant/screenshot-manager');

const AUTO_SCREEN_CONTROLLER_PATH = path.join(
  __dirname,
  '..',
  'src',
  'windows',
  'assistant',
  'renderer',
  'features',
  'auto-screen',
  'auto-screen-controller.js'
);
const MESSAGE_STORE_PATH = path.join(
  __dirname,
  '..',
  'src',
  'windows',
  'assistant',
  'renderer',
  'features',
  'ai-context',
  'message-store.js'
);
const RENDERER_HTML_PATH = path.join(
  __dirname,
  '..',
  'src',
  'windows',
  'assistant',
  'renderer.html'
);
const START_APPLICATION_PATH = path.join(
  __dirname,
  '..',
  'src',
  'main-process',
  'start-application.js'
);

function createDeferred() {
  let resolve;
  let reject;
  const promise = new Promise((promiseResolve, promiseReject) => {
    resolve = promiseResolve;
    reject = promiseReject;
  });
  return { promise, resolve, reject };
}

function createFakeTimers() {
  let sequence = 0;
  const tasks = new Map();

  return {
    setTimeoutFn(callback, delay) {
      sequence += 1;
      tasks.set(sequence, { callback, delay });
      return sequence;
    },
    clearTimeoutFn(timerId) {
      tasks.delete(timerId);
    },
    get size() {
      return tasks.size;
    },
    delays() {
      return [...tasks.values()].map(({ delay }) => delay);
    },
    async runNext() {
      const next = tasks.entries().next().value;
      assert.ok(next, 'expected a pending timer');
      const [timerId, task] = next;
      tasks.delete(timerId);
      return task.callback();
    }
  };
}

async function loadAutoScreenModule() {
  assert.equal(
    fs.existsSync(AUTO_SCREEN_CONTROLLER_PATH),
    true,
    'expected the Auto Screen controller module to exist'
  );
  const source = fs.readFileSync(AUTO_SCREEN_CONTROLLER_PATH, 'utf8');
  const encoded = Buffer.from(source, 'utf8').toString('base64');
  return import(`data:text/javascript;base64,${encoded}`);
}

async function loadMessageStoreModule() {
  const source = fs.readFileSync(MESSAGE_STORE_PATH, 'utf8');
  const importPattern =
    /import\s*\{[\s\S]*?\}\s*from\s*'\.\/message-types\.js';/;
  const testableSource = source.replace(
    importPattern,
    `
const canToggleAiForMessageType = (type) => type !== 'system' && type !== 'ai-response';
const defaultIncludeInAiForMessageType = (type) => type !== 'system' && type !== 'ai-response';
const isSystemMessageType = (type) => type === 'system';
`
  );
  assert.notEqual(testableSource, source, 'expected message-store imports to be replaced');
  const encoded = Buffer.from(testableSource, 'utf8').toString('base64');
  return import(`data:text/javascript;base64,${encoded}`);
}

test('Auto Screen interval config exposes only production values and safe fallback', () => {
  assert.deepEqual(config.getAutoScreenIntervalSeconds(), [5, 10, 15, 30]);
  assert.equal(config.getDefaultAutoScreenIntervalSeconds(), 10);
  for (const value of [5, 10, 15, 30]) {
    assert.equal(config.resolveAutoScreenIntervalSeconds(value), value);
    assert.equal(config.resolveAutoScreenIntervalSeconds(String(value)), value);
  }
  for (const value of [undefined, null, '', 0, 1, 6, 60, '10.5', 'invalid']) {
    assert.equal(config.resolveAutoScreenIntervalSeconds(value), 10);
  }
});

test('short Auto Screen milliseconds are available only to the doubly gated E2E fixture', () => {
  const override = {
    OPEN_CLUELY_E2E_AUTO_SCREEN_INTERVAL_MS: '125'
  };
  assert.equal(
    config.resolveAutoScreenIntervalMilliseconds(5, override),
    5_000
  );
  assert.equal(
    config.resolveAutoScreenIntervalMilliseconds(5, {
      ...override,
      OPEN_CLUELY_E2E: '1'
    }),
    5_000
  );
  assert.equal(
    config.resolveAutoScreenIntervalMilliseconds(5, {
      ...override,
      OPEN_CLUELY_E2E_SCREENSHOT_FIXTURE: '1'
    }),
    5_000
  );
  assert.equal(
    config.resolveAutoScreenIntervalMilliseconds(5, {
      ...override,
      OPEN_CLUELY_E2E: '1',
      OPEN_CLUELY_E2E_SCREENSHOT_FIXTURE: '1'
    }),
    125
  );
});

test('Auto Screen interval persists in sanitized app state but enabled state does not', () => {
  const defaults = getDefaultAppState();
  assert.equal(defaults.autoScreenIntervalSeconds, 10);
  assert.equal(Object.hasOwn(defaults, 'autoScreenEnabled'), false);

  for (const value of [5, 10, 15, 30]) {
    assert.equal(
      sanitizeAppState({ autoScreenIntervalSeconds: value }).autoScreenIntervalSeconds,
      value
    );
  }
  assert.equal(
    sanitizeAppState({ autoScreenIntervalSeconds: 12 }).autoScreenIntervalSeconds,
    10
  );
  assert.equal(
    sanitizeAppState({
      autoScreenIntervalSeconds: 15,
      autoScreenEnabled: true
    }).autoScreenEnabled,
    undefined
  );
});

test('E2E screenshot fixture requires both dedicated gates', () => {
  assert.equal(
    typeof screenshotManagerModule.isE2EScreenshotFixtureEnabled,
    'function'
  );
  const { isE2EScreenshotFixtureEnabled } = screenshotManagerModule;
  assert.equal(isE2EScreenshotFixtureEnabled({}), false);
  assert.equal(
    isE2EScreenshotFixtureEnabled({ OPEN_CLUELY_E2E: '1' }),
    false
  );
  assert.equal(
    isE2EScreenshotFixtureEnabled({
      OPEN_CLUELY_E2E_SCREENSHOT_FIXTURE: '1'
    }),
    false
  );
  assert.equal(
    isE2EScreenshotFixtureEnabled({
      OPEN_CLUELY_E2E: '1',
      OPEN_CLUELY_E2E_SCREENSHOT_FIXTURE: '1'
    }),
    true
  );
});

test('preload sends a sanitized screenshot origin payload', async () => {
  const calls = [];
  const actions = createInvokeActions({
    invoke(channel, ...args) {
      calls.push({ channel, args });
      return Promise.resolve({ success: true });
    }
  });

  await actions.takeStealthScreenshot('auto');
  await actions.takeStealthScreenshot('unexpected');

  assert.deepEqual(calls, [
    {
      channel: 'take-stealth-screenshot',
      args: [{ origin: 'auto' }]
    },
    {
      channel: 'take-stealth-screenshot',
      args: [{ origin: 'manual' }]
    }
  ]);
});

test('global screenshot shortcut routes through the renderer one-shot action', () => {
  const subscribedChannels = [];
  const eventActions = createEventActions({
    on(channel) {
      subscribedChannels.push(channel);
    },
    removeListener() {}
  });
  const startupSource = fs.readFileSync(START_APPLICATION_PATH, 'utf8');

  assert.equal(typeof eventActions.onTriggerScreenshot, 'function');
  eventActions.onTriggerScreenshot(() => {});
  assert.ok(subscribedChannels.includes('trigger-screenshot'));
  assert.match(
    startupSource,
    /onTakeStealthScreenshot:\s*(?:async\s*)?\(\)\s*=>\s*\{\s*sendToRenderer\('trigger-screenshot'\)/
  );
});

test('Auto Screen UI starts off and exposes interval cost and privacy guidance', () => {
  const html = fs.readFileSync(RENDERER_HTML_PATH, 'utf8');

  assert.match(
    html,
    /id="auto-screen-toggle"[^>]*aria-pressed="false"/
  );
  assert.match(
    html,
    /id="setting-auto-screen-interval"/
  );
  for (const seconds of [5, 10, 15, 30]) {
    assert.match(
      html,
      new RegExp(`<option value="${seconds}"`)
    );
  }
  assert.match(html, /cost/i);
  assert.match(html, /privacy/i);
});

test('message store removes records by replaced screenshot IDs', async () => {
  const { createMessageStore } = await loadMessageStoreModule();
  const store = createMessageStore();
  const first = store.add('screenshot', 'first', { screenshotId: 'ss-auto-old' });
  const second = store.add('screenshot', 'second', { screenshotId: 'ss-manual' });
  const response = store.add('ai-response', 'answer');

  const removed = store.removeByScreenshotIds([
    'ss-auto-old',
    'ss-auto-old',
    '',
    null
  ]);

  assert.deepEqual(removed.map(({ id }) => id), [first.id]);
  assert.deepEqual(
    store.getMessages().map(({ id }) => id),
    [second.id, response.id]
  );
  assert.deepEqual(store.removeByScreenshotIds([]), []);
});

test('Auto Screen scheduler runs immediately and schedules only after completion', async () => {
  const { createAutoScreenScheduler } = await loadAutoScreenModule();
  const timers = createFakeTimers();
  const firstCycle = createDeferred();
  let calls = 0;
  const scheduler = createAutoScreenScheduler({
    runCycle() {
      calls += 1;
      return firstCycle.promise;
    },
    isBusy: () => false,
    getIntervalMs: () => 10_000,
    setTimeoutFn: timers.setTimeoutFn,
    clearTimeoutFn: timers.clearTimeoutFn
  });

  const enabled = scheduler.enable();
  assert.equal(calls, 1);
  assert.equal(timers.size, 0);
  assert.equal(scheduler.getState().running, true);

  firstCycle.resolve({ success: true });
  await enabled;

  assert.equal(timers.size, 1);
  assert.deepEqual(timers.delays(), [10_000]);
  assert.equal(scheduler.getState().running, false);
});

test('Auto Screen scheduler never overlaps a running cycle', async () => {
  const { createAutoScreenScheduler } = await loadAutoScreenModule();
  const timers = createFakeTimers();
  const cycle = createDeferred();
  let calls = 0;
  const scheduler = createAutoScreenScheduler({
    runCycle() {
      calls += 1;
      return cycle.promise;
    },
    isBusy: () => false,
    getIntervalMs: () => 5_000,
    setTimeoutFn: timers.setTimeoutFn,
    clearTimeoutFn: timers.clearTimeoutFn
  });

  const first = scheduler.enable();
  const skipped = await scheduler.runNow();

  assert.equal(calls, 1);
  assert.equal(skipped.skipped, true);
  assert.equal(skipped.reason, 'running');
  assert.equal(timers.size, 0);

  cycle.resolve({ success: true });
  await first;
  assert.equal(timers.size, 1);
});

test('turning Auto Screen off cancels a pending timer without aborting in-flight work', async () => {
  const { createAutoScreenScheduler } = await loadAutoScreenModule();
  const timers = createFakeTimers();
  const scheduler = createAutoScreenScheduler({
    runCycle: async () => ({ success: true }),
    isBusy: () => false,
    getIntervalMs: () => 5_000,
    setTimeoutFn: timers.setTimeoutFn,
    clearTimeoutFn: timers.clearTimeoutFn
  });

  await scheduler.enable();
  assert.equal(timers.size, 1);
  scheduler.disable('user');
  assert.equal(timers.size, 0);
  assert.equal(scheduler.getState().enabled, false);

  const inFlight = createDeferred();
  const inFlightScheduler = createAutoScreenScheduler({
    runCycle: () => inFlight.promise,
    isBusy: () => false,
    getIntervalMs: () => 5_000,
    setTimeoutFn: timers.setTimeoutFn,
    clearTimeoutFn: timers.clearTimeoutFn
  });
  const running = inFlightScheduler.enable();
  inFlightScheduler.disable('user');
  inFlight.resolve({ success: true });
  await running;
  assert.equal(timers.size, 0);
});

test('Auto Screen busy ticks skip cleanly and reschedule', async () => {
  const { createAutoScreenScheduler } = await loadAutoScreenModule();
  const timers = createFakeTimers();
  let calls = 0;
  const scheduler = createAutoScreenScheduler({
    runCycle: async () => {
      calls += 1;
      return { success: true };
    },
    isBusy: () => true,
    getIntervalMs: () => 15_000,
    setTimeoutFn: timers.setTimeoutFn,
    clearTimeoutFn: timers.clearTimeoutFn
  });

  const result = await scheduler.enable();

  assert.equal(result.skipped, true);
  assert.equal(result.reason, 'busy');
  assert.equal(calls, 0);
  assert.equal(scheduler.getState().consecutiveFailures, 0);
  assert.deepEqual(timers.delays(), [15_000]);
});

test('Auto Screen disables after three consecutive capture or analysis failures', async () => {
  const { createAutoScreenScheduler } = await loadAutoScreenModule();
  const timers = createFakeTimers();
  const shutdowns = [];
  let calls = 0;
  const scheduler = createAutoScreenScheduler({
    runCycle: async () => {
      calls += 1;
      return { success: false, error: `failure ${calls}` };
    },
    isBusy: () => false,
    getIntervalMs: () => 5_000,
    setTimeoutFn: timers.setTimeoutFn,
    clearTimeoutFn: timers.clearTimeoutFn,
    onAutoDisabled(details) {
      shutdowns.push(details);
    }
  });

  await scheduler.enable();
  assert.equal(scheduler.getState().consecutiveFailures, 1);
  await timers.runNext();
  assert.equal(scheduler.getState().consecutiveFailures, 2);
  await timers.runNext();

  assert.equal(calls, 3);
  assert.equal(scheduler.getState().enabled, false);
  assert.equal(scheduler.getState().consecutiveFailures, 3);
  assert.equal(timers.size, 0);
  assert.deepEqual(shutdowns, [{
    reason: 'failure-limit',
    consecutiveFailures: 3,
    error: 'failure 3'
  }]);
});

test('Auto Screen interval updates a live pending schedule', async () => {
  const { createAutoScreenScheduler } = await loadAutoScreenModule();
  const timers = createFakeTimers();
  let intervalMs = 10_000;
  const scheduler = createAutoScreenScheduler({
    runCycle: async () => ({ success: true }),
    isBusy: () => false,
    getIntervalMs: () => intervalMs,
    setTimeoutFn: timers.setTimeoutFn,
    clearTimeoutFn: timers.clearTimeoutFn
  });

  await scheduler.enable();
  assert.deepEqual(timers.delays(), [10_000]);
  intervalMs = 30_000;
  scheduler.refreshInterval();
  assert.equal(timers.size, 1);
  assert.deepEqual(timers.delays(), [30_000]);
});

test('manual Screenshot performs one capture then one Screen AI call for the exact new ID', async () => {
  const { createAutoScreenController } = await loadAutoScreenModule();
  const calls = [];
  const timers = createFakeTimers();
  const controller = createAutoScreenController({
    captureScreenshot: async (origin) => {
      calls.push({ type: 'capture', origin });
      return {
        success: true,
        screenshotId: 'ss-new-manual',
        count: 1,
        backend: 'fixture',
        replacedScreenshotIds: []
      };
    },
    analyzeScreenshot: async ({ screenshotIds, origin }) => {
      calls.push({ type: 'analyze', screenshotIds, origin });
      return { success: true, text: 'answer' };
    },
    isAiAvailable: () => true,
    isBusy: () => false,
    runExclusive: async (_actionId, action) => ({
      acquired: true,
      value: await action()
    }),
    getIntervalMs: () => 10_000,
    setTimeoutFn: timers.setTimeoutFn,
    clearTimeoutFn: timers.clearTimeoutFn
  });

  const result = await controller.captureManualScreenshot();

  assert.equal(result.success, true);
  assert.deepEqual(calls, [
    { type: 'capture', origin: 'manual' },
    {
      type: 'analyze',
      screenshotIds: ['ss-new-manual'],
      origin: 'manual'
    }
  ]);
});

test('Auto Screen disables before capture when AI is unavailable', async () => {
  const { createAutoScreenController } = await loadAutoScreenModule();
  const timers = createFakeTimers();
  let captureCalls = 0;
  const shutdowns = [];
  const controller = createAutoScreenController({
    captureScreenshot: async () => {
      captureCalls += 1;
      return { success: true, screenshotId: 'must-not-exist' };
    },
    analyzeScreenshot: async () => ({ success: true }),
    isAiAvailable: () => false,
    isBusy: () => false,
    runExclusive: async (_actionId, action) => ({
      acquired: true,
      value: await action()
    }),
    getIntervalMs: () => 10_000,
    setTimeoutFn: timers.setTimeoutFn,
    clearTimeoutFn: timers.clearTimeoutFn,
    onAutoDisabled(details) {
      shutdowns.push(details);
    }
  });

  const result = await controller.enableAutoScreen();

  assert.equal(result.success, false);
  assert.equal(result.fatal, true);
  assert.equal(captureCalls, 0);
  assert.equal(controller.getState().enabled, false);
  assert.equal(timers.size, 0);
  assert.equal(shutdowns[0].reason, 'fatal');
  assert.match(shutdowns[0].error, /configure.*settings/i);
});
