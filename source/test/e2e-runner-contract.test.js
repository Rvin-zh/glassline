'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter, once } = require('node:events');
const { PassThrough } = require('node:stream');
const { spawn } = require('node:child_process');
const test = require('node:test');
const assert = require('node:assert/strict');

const {
  assertBackgroundMemoryEvidence,
  assertRequestHasActiveOutputFormat,
  assertStreamingCompletionEvidence,
  collectStreamingSnapshots,
  runElectronE2E,
  sendTypedChatInput,
  terminateProcessTree
} = require('../scripts/e2e-electron');
const {
  E2E_MODEL,
  E2E_MEMORY_MODEL,
  E2E_MEMORY_NOTE,
  E2E_MEMORY_TOPIC,
  E2E_PORTKEY_API_KEY,
  E2E_PORTKEY_PROVIDER
} = require('../scripts/e2e/fake-portkey-gateway');

const REPO_ROOT = path.resolve(__dirname, '..');
const DEBUG_PORT = 43127;

async function withTestTimeout(promise, milliseconds) {
  let timeout;
  try {
    return await Promise.race([
      promise,
      new Promise((resolve, reject) => {
        timeout = setTimeout(() => {
          reject(new Error(`test operation exceeded ${milliseconds}ms`));
        }, milliseconds);
        void resolve;
      })
    ]);
  } finally {
    clearTimeout(timeout);
  }
}

function activeTimeoutCount() {
  return process.getActiveResourcesInfo()
    .filter((resourceName) => resourceName === 'Timeout')
    .length;
}

function isProcessAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error?.code === 'ESRCH') {
      return false;
    }
    throw error;
  }
}

async function waitForCondition(check, timeoutMs = 1000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (check()) {
      return true;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  return check();
}

function createHarness(overrides = {}) {
  const events = [];
  const removedDirectories = [];
  const logLines = [];
  const signalTarget = new EventEmitter();
  const child = new EventEmitter();
  child.pid = 42420;
  child.exitCode = null;
  child.signalCode = null;
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();

  const fakeServer = {
    baseUrl: 'http://127.0.0.1:41234/v1',
    requests: [],
    async close() {
      events.push('fake-close');
    }
  };
  const cdp = {
    async evaluate() {
      return {
        readyState: 'complete',
        rootClasses: ['platform-linux', 'reduced-effects'],
        settingsOpen: false,
        chatMessageCount: 0
      };
    },
    async close() {
      events.push('cdp-close');
    }
  };

  let spawnRecord = null;
  let fakeOptions = null;

  const dependencies = {
    electronBinary: '/opt/test/electron',
    repoRoot: REPO_ROOT,
    signalTarget,
    logger: {
      log(line) {
        logLines.push(String(line));
      },
      error(line) {
        logLines.push(String(line));
      }
    },
    async createFakePortkeyGateway(options) {
      events.push('fake-start');
      fakeOptions = options;
      return fakeServer;
    },
    async reserveDebugPort() {
      events.push('port-reserve');
      return {
        port: DEBUG_PORT,
        async release() {
          events.push('port-release');
        }
      };
    },
    spawn(binary, args, options) {
      assert.ok(
        events.includes('port-release'),
        'the reserved debugging port must be released immediately before spawn'
      );
      events.push('electron-spawn');
      spawnRecord = { binary, args, options };
      const reportPath = options.env.OPEN_CLUELY_E2E_NETWORK_REPORT_PATH;
      if (reportPath) {
        fs.writeFileSync(reportPath, [
          JSON.stringify({ type: 'policy-ready', transport: 'node' }),
          JSON.stringify({ type: 'policy-ready', transport: 'renderer' }),
          ''
        ].join('\n'), { encoding: 'utf8', mode: 0o600 });
      }
      return child;
    },
    async discoverPage({ port }) {
      events.push('page-discover');
      assert.equal(port, DEBUG_PORT);
      return {
        webSocketDebuggerUrl:
          `ws://127.0.0.1:${DEBUG_PORT}/devtools/page/e2e`
      };
    },
    async connectCdp(webSocketUrl) {
      events.push('cdp-connect');
      assert.match(webSocketUrl, /^ws:\/\/127\.0\.0\.1:/);
      return cdp;
    },
    async runScenarios({ reportPass }) {
      events.push('scenarios');
      assert.equal(signalTarget.listenerCount('SIGINT'), 1);
      assert.equal(signalTarget.listenerCount('SIGTERM'), 1);
      reportPass('contract scenario');
    },
    async terminateProcessTree(spawnedChild) {
      events.push('electron-stop');
      assert.equal(spawnedChild, child);
    },
    async removeDirectory(directory) {
      events.push('directory-remove');
      removedDirectories.push(directory);
      fs.rmSync(directory, { recursive: true, force: true });
    },
    ...overrides
  };

  return {
    cdp,
    child,
    dependencies,
    events,
    fakeServer,
    get fakeOptions() {
      return fakeOptions;
    },
    get spawnRecord() {
      return spawnRecord;
    },
    logLines,
    removedDirectories,
    signalTarget
  };
}

function assertCleanup(harness) {
  assert.ok(harness.events.includes('cdp-close'));
  assert.ok(harness.events.includes('electron-stop'));
  assert.ok(harness.events.includes('fake-close'));
  assert.equal(harness.removedDirectories.length, 2);
  assert.equal(harness.signalTarget.listenerCount('SIGINT'), 0);
  assert.equal(harness.signalTarget.listenerCount('SIGTERM'), 0);
}

function createValidStreamingEvidence() {
  return {
    events: [
      { type: 'start', actionId: 'askAi' },
      { type: 'chunk', actionId: 'askAi', text: 'Stream', index: 1 },
      { type: 'chunk', actionId: 'askAi', text: 'ing ', index: 2 },
      { type: 'chunk', actionId: 'askAi', text: 'works', index: 3 },
      { type: 'end', actionId: 'askAi' }
    ],
    domSnapshots: ['Stream', 'Streaming', 'Streaming works'],
    errorCount: 0,
    finalText: 'Streaming works',
    systemErrorCount: 0
  };
}

function createValidBackgroundMemoryEvidence() {
  return {
    result: {
      success: true,
      summary: {
        currentTopic: E2E_MEMORY_TOPIC,
        proposedDurableNotes: [{ text: E2E_MEMORY_NOTE }]
      },
      queue: [{ text: E2E_MEMORY_NOTE }],
      status: {
        provider: 'portkey',
        model: E2E_MEMORY_MODEL,
        ready: true,
        lastSuccessAt: '2026-09-10T00:00:00.000Z',
        lastErrorCategory: null,
        lastErrorAt: null
      }
    },
    request: {
      model: E2E_MEMORY_MODEL,
      messages: [{
        role: 'user',
        content: 'You maintain structured interview/session memory. Return ONLY valid JSON with proposedDurableNotes.'
      }],
      stream: false,
      memory: {
        temperature: 0.2,
        responseFormat: { type: 'json_object' },
        thinking: { type: 'enabled', budget_tokens: 256 },
        reasoning: { effort: 'none' }
      }
    },
    requestCountBefore: 0,
    requestCountAfter: 1,
    reviewCandidateVisible: true
  };
}

test('runner launches isolated Electron and cleans every resource on success', async () => {
  const harness = createHarness({
    async runScenarios(context) {
      harness.events.push('scenarios');
      assert.equal(harness.signalTarget.listenerCount('SIGINT'), 1);
      assert.equal(harness.signalTarget.listenerCount('SIGTERM'), 1);

      const stateDir = harness.spawnRecord.options.env.OPEN_CLUELY_STATE_DIR;
      const statePath = path.join(stateDir, 'cache', 'app-state.json');
      const state = JSON.parse(fs.readFileSync(statePath, 'utf8'));
      const envPath = harness.spawnRecord.options.env.OPEN_CLUELY_ENV_PATH;
      assert.equal(path.dirname(envPath), stateDir);
      assert.equal(fs.readFileSync(envPath, 'utf8'), '');
      assert.notEqual(envPath, path.join(REPO_ROOT, '.env'));
      const networkReportPath =
        harness.spawnRecord.options.env.OPEN_CLUELY_E2E_NETWORK_REPORT_PATH;
      assert.equal(path.dirname(networkReportPath), stateDir);
      assert.equal(state.aiProvider, 'portkey');
      assert.equal(state.portkeyApiKey, E2E_PORTKEY_API_KEY);
      assert.equal(state.portkeyProvider, E2E_PORTKEY_PROVIDER);
      assert.equal(state.portkeyBaseUrl, harness.fakeServer.baseUrl);
      assert.equal(state.geminiModel, E2E_MODEL);
      assert.equal(state.programmingLanguage, 'Python');
      assert.equal(state.promptCacheEnabled, false);
      assert.equal(state.webSearchEnabled, false);
      assert.equal(state.requestWebSearchEnabled, false);
      assert.equal(state.autoScreenIntervalSeconds, 10);
      assert.equal(state.defaultOutputFormat, 'quick');
      assert.equal(
        state.customOutputTemplate,
        'E2E custom: verdict, evidence, next step.'
      );
      assert.equal(state.documents.resume.text, '');
      assert.equal(state.durableNotes.length, 1);
      assert.equal(
        state.sessionMemory.currentTopic,
        'E2E_PREVIOUS_INTERVIEW_TOPIC'
      );
      assert.deepEqual(state.selectedInterviewSessionIds, [
        'stale-selection-must-reset'
      ]);

      context.reportPass('contract scenario');
    }
  });

  const result = await runElectronE2E(harness.dependencies);

  assert.deepEqual(result.scenarios, ['contract scenario']);
  assert.equal(harness.spawnRecord.binary, '/opt/test/electron');
  assert.ok(harness.spawnRecord.args.includes('--ozone-platform=x11'));
  assert.ok(
    harness.spawnRecord.args.includes(`--remote-debugging-port=${DEBUG_PORT}`)
  );
  assert.ok(harness.spawnRecord.args.includes('--no-sandbox'));
  assert.ok(harness.spawnRecord.args.includes('--dns-prefetch-disable'));
  assert.ok(
    harness.spawnRecord.args.some((argument) => (
      argument.startsWith('--disable-features=')
      && argument.includes('AsyncDns')
      && argument.includes('DnsOverHttps')
    ))
  );
  assert.ok(
    harness.spawnRecord.args.some((argument) => (
      argument.startsWith('--host-resolver-rules=')
      && argument.includes('MAP * ~NOTFOUND')
      && argument.includes('EXCLUDE 127.0.0.1')
      && argument.includes('EXCLUDE localhost')
    ))
  );
  assert.ok(harness.spawnRecord.args.includes(REPO_ROOT));
  assert.equal(harness.spawnRecord.options.detached, true);
  assert.deepEqual(harness.spawnRecord.options.stdio, ['ignore', 'pipe', 'pipe']);

  const launchEnv = harness.spawnRecord.options.env;
  const userDataArg = harness.spawnRecord.args.find((argument) => (
    argument.startsWith('--user-data-dir=')
  ));
  const userDataDir = userDataArg.slice('--user-data-dir='.length);
  assert.match(path.basename(launchEnv.OPEN_CLUELY_STATE_DIR), /^open-cluely-e2e-state-/);
  assert.match(path.basename(userDataDir), /^open-cluely-e2e-user-data-/);
  assert.notEqual(userDataDir, launchEnv.OPEN_CLUELY_STATE_DIR);
  assert.equal(launchEnv.OPEN_CLUELY_DISABLE_MOBILE, '1');
  assert.equal(launchEnv.OPEN_CLUELY_DISPLAY_PROFILE, 'xwayland');
  assert.equal(launchEnv.OPEN_CLUELY_E2E_NETWORK_POLICY, 'loopback-only');
  assert.equal(launchEnv.OPEN_CLUELY_E2E, '1');
  assert.equal(launchEnv.OPEN_CLUELY_E2E_SCREENSHOT_FIXTURE, '1');
  assert.equal(launchEnv.OPEN_CLUELY_E2E_AUTO_SCREEN_INTERVAL_MS, '250');
  assert.equal(launchEnv.OPEN_CLUELY_E2E_MEMORY_DEBOUNCE_MS, '60000');
  assert.equal(
    path.dirname(launchEnv.OPEN_CLUELY_E2E_NETWORK_REPORT_PATH),
    launchEnv.OPEN_CLUELY_STATE_DIR
  );
  assert.match(
    path.basename(launchEnv.OPEN_CLUELY_ENV_PATH),
    /^open-cluely-e2e-.*\.env$/
  );
  assert.equal(launchEnv.START_HIDDEN, 'false');
  assert.equal(launchEnv.ELECTRON_RUN_AS_NODE, undefined);

  assert.deepEqual(harness.fakeOptions.chunks, ['Stream', 'ing ', 'works']);
  assert.ok(harness.fakeOptions.chunkDelayMs >= 100);
  assert.deepEqual(harness.logLines, ['PASS: contract scenario']);
  assertCleanup(harness);
});

test('runner scrubs inherited Node preload injection from the Electron child', async () => {
  const harness = createHarness({
    environment: {
      ...process.env,
      NODE_OPTIONS: '--require=/tmp/malicious-parent-preload.cjs',
      NODE_PATH: '/tmp/malicious-parent-modules'
    }
  });

  await runElectronE2E(harness.dependencies);

  assert.equal(harness.spawnRecord.options.env.NODE_OPTIONS, undefined);
  assert.equal(harness.spawnRecord.options.env.NODE_PATH, undefined);
  assertCleanup(harness);
});

test('runner reports blocked outbound attempts without exposing target data', async () => {
  const sensitiveTarget = 'https://secret.example/private-payload-token';
  const harness = createHarness({
    async runScenarios({ reportPass }) {
      harness.events.push('scenarios');
      fs.appendFileSync(
        harness.spawnRecord.options.env.OPEN_CLUELY_E2E_NETWORK_REPORT_PATH,
        `${JSON.stringify({
          type: 'blocked-outbound',
          transport: 'fetch',
          target: sensitiveTarget
        })}\n`,
        'utf8'
      );
      reportPass('contract scenario');
    }
  });

  await assert.rejects(
    runElectronE2E(harness.dependencies),
    (error) => {
      assert.match(error.message, /blocked outbound network attempt/i);
      assert.doesNotMatch(error.message, /secret|payload|token|example/i);
      assert.doesNotMatch(error.message, new RegExp(sensitiveTarget));
      return true;
    }
  );

  assertCleanup(harness);
});

test('runner installs renderer stream listeners before clicking Send', async () => {
  const calls = [];
  const cdp = {
    async evaluate(expression) {
      calls.push({ type: 'evaluate', expression });
      if (expression.includes('__openCluelyE2EStreamProbe')) {
        return true;
      }
      return true;
    },
    async call(method, params) {
      calls.push({ type: 'call', method, params });
    },
    async waitFor(expression) {
      calls.push({ type: 'waitFor', expression });
      return true;
    }
  };

  await sendTypedChatInput(cdp);

  const probeIndex = calls.findIndex(({ expression = '' }) => (
    expression.includes('onAiStreamStart')
    && expression.includes('onAiStreamChunk')
    && expression.includes('onAiStreamEnd')
    && expression.includes('MutationObserver')
  ));
  const sendIndex = calls.findIndex(({ expression = '' }) => (
    expression.includes("getElementById('chat-manual-send')")
    && expression.includes('button.click()')
  ));
  assert.ok(probeIndex >= 0, 'the renderer stream probe was not installed');
  assert.ok(sendIndex > probeIndex, 'Send was clicked before stream listeners were installed');
});

test('streaming evidence requires one complete ordered terminal lifecycle', () => {
  assert.doesNotThrow(() => (
    assertStreamingCompletionEvidence(createValidStreamingEvidence())
  ));

  const invalidEvidence = [
    {
      ...createValidStreamingEvidence(),
      events: createValidStreamingEvidence().events.slice(1)
    },
    {
      ...createValidStreamingEvidence(),
      events: [
        { type: 'start', actionId: 'askAi' },
        { type: 'chunk', actionId: 'askAi', text: 'Streaming works', index: 1 },
        { type: 'end', actionId: 'askAi' }
      ]
    },
    {
      ...createValidStreamingEvidence(),
      events: [
        ...createValidStreamingEvidence().events,
        { type: 'end', actionId: 'askAi' }
      ]
    },
    {
      ...createValidStreamingEvidence(),
      finalText: 'Streaming work'
    },
    {
      ...createValidStreamingEvidence(),
      errorCount: 1
    },
    {
      ...createValidStreamingEvidence(),
      events: [
        ...createValidStreamingEvidence().events,
        { type: 'chunk', actionId: 'askAi', text: 'late', index: 4 }
      ]
    }
  ];

  for (const evidence of invalidEvidence) {
    assert.throws(
      () => assertStreamingCompletionEvidence(evidence),
      /Scenario failed: incremental chat streaming/
    );
  }
});

test('background memory evidence requires an isolated minimal Portkey JSON request', () => {
  const evidence = createValidBackgroundMemoryEvidence();
  assert.doesNotThrow(() => assertBackgroundMemoryEvidence(evidence));

  for (const invalid of [
    {
      ...evidence,
      request: { ...evidence.request, model: E2E_MODEL }
    },
    {
      ...evidence,
      request: {
        ...evidence.request,
        memory: {
          ...evidence.request.memory,
          reasoning: { effort: 'low' }
        }
      }
    },
    {
      ...evidence,
      requestCountAfter: 2
    },
    {
      ...evidence,
      reviewCandidateVisible: false
    }
  ]) {
    assert.throws(
      () => assertBackgroundMemoryEvidence(invalid),
      /Scenario failed: Portkey background memory/
    );
  }
});

test('streaming evidence requires mutation-time DOM prefixes before final text', () => {
  assert.doesNotThrow(() => (
    assertStreamingCompletionEvidence(createValidStreamingEvidence())
  ));

  for (const domSnapshots of [
    ['Streaming works'],
    ['Streaming works', 'Streaming works'],
    ['Streaming', 'Stream', 'Streaming works'],
    ['Stream', 'not-a-prefix', 'Streaming works']
  ]) {
    assert.throws(
      () => assertStreamingCompletionEvidence({
        ...createValidStreamingEvidence(),
        domSnapshots
      }),
      /Scenario failed: incremental chat streaming/
    );
  }
});

test('stream verification waits through a post-end quiet window before reading evidence', async () => {
  let quietWindowObserved = false;
  const cdp = {
    async waitFor() {
      return true;
    },
    async evaluate() {
      assert.equal(quietWindowObserved, true);
      return createValidStreamingEvidence();
    }
  };
  const fakeServer = {
    requests: [{
      model: E2E_MODEL,
      messages: [{
        role: 'user',
        content: 'Context containing the exact E2E stream request input.'
      }],
      stream: true
    }]
  };

  await collectStreamingSnapshots(cdp, fakeServer, {
    timeoutMs: 100,
    quietWindowMs: 25,
    delayImpl: async (milliseconds) => {
      assert.equal(milliseconds, 25);
      quietWindowObserved = true;
    }
  });
});

test('stream verification rejects a provider request that omits typed chat input', async () => {
  const cdp = {
    async waitFor() {
      return true;
    },
    async evaluate() {
      return createValidStreamingEvidence();
    }
  };
  const fakeServer = {
    requests: [{
      model: E2E_MODEL,
      messages: [{ role: 'user', content: 'Different request content' }],
      stream: true
    }]
  };

  await assert.rejects(
    collectStreamingSnapshots(cdp, fakeServer, {
      timeoutMs: 100,
      quietWindowMs: 1,
      delayImpl: async () => {}
    }),
    /Scenario failed: incremental chat streaming/
  );
});

test('provider prompt verification requires the exact active output-format marker', () => {
  const request = {
    messages: [{
      role: 'user',
      content: [
        '=== ACTIVE OUTPUT FORMAT: ADAPTIVE ===',
        'Apply the ADAPTIVE definition above.',
        'E2E stream request'
      ].join('\n')
    }]
  };

  assert.doesNotThrow(() => (
    assertRequestHasActiveOutputFormat(request, 'adaptive')
  ));
  assert.throws(
    () => assertRequestHasActiveOutputFormat(request, 'detailed'),
    /Scenario failed: detailed output format prompt/
  );
  assert.throws(
    () => assertRequestHasActiveOutputFormat({
      messages: [{
        role: 'user',
        content: `${request.messages[0].content}\n=== ACTIVE OUTPUT FORMAT: ADAPTIVE ===`
      }]
    }, 'adaptive'),
    /Scenario failed: adaptive output format prompt/
  );
});

test('custom provider prompt verification checks only the isolated seeded template', () => {
  const template = 'E2E custom: verdict, evidence, next step.';
  const request = {
    messages: [{
      role: 'user',
      content: [
        '=== ACTIVE OUTPUT FORMAT: CUSTOM ===',
        template
      ].join('\n')
    }]
  };

  assert.doesNotThrow(() => (
    assertRequestHasActiveOutputFormat(request, 'custom', template)
  ));
  assert.throws(
    () => assertRequestHasActiveOutputFormat(request, 'custom', 'different template'),
    /Scenario failed: custom output format prompt/
  );
});

test('runner sanitizes failures and still cleans every resource', async () => {
  const unsafeKey = 'sk-proj-1234567890abcdefghijklmnop';
  const harness = createHarness({
    async runScenarios() {
      harness.events.push('scenarios');
      throw new Error(`scenario failed using ${unsafeKey}`);
    }
  });

  await assert.rejects(
    runElectronE2E(harness.dependencies),
    (error) => {
      assert.match(error.message, /scenario failed/i);
      assert.doesNotMatch(error.message, new RegExp(unsafeKey));
      assert.match(error.message, /\[REDACTED\]/);
      return true;
    }
  );

  assertCleanup(harness);
});

test('process-tree cleanup kills an ignoring descendant after its leader exits', {
  skip: process.platform === 'win32',
  timeout: 8000
}, async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'open-cluely-pgroup-test-'));
  const readyPath = path.join(directory, 'descendant.pid');
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));

  const descendantSource = `
    const fs = require('node:fs');
    process.on('SIGTERM', () => {});
    fs.writeFileSync(process.argv[1], String(process.pid));
    setInterval(() => {}, 1000);
  `;
  const leaderSource = `
    const fs = require('node:fs');
    const { spawn } = require('node:child_process');
    const child = spawn(
      process.execPath,
      ['-e', ${JSON.stringify(descendantSource)}, process.argv[1]],
      { stdio: 'ignore' }
    );
    child.unref();
    const timer = setInterval(() => {
      if (fs.existsSync(process.argv[1])) {
        clearInterval(timer);
        process.exit(0);
      }
    }, 5);
  `;
  const leader = spawn(process.execPath, ['-e', leaderSource, readyPath], {
    detached: true,
    stdio: 'ignore'
  });
  let descendantPid = null;

  try {
    assert.equal(
      await waitForCondition(() => fs.existsSync(readyPath), 3000),
      true,
      'the ignoring descendant did not become ready'
    );
    descendantPid = Number(fs.readFileSync(readyPath, 'utf8'));
    if (leader.exitCode === null && leader.signalCode === null) {
      await once(leader, 'exit');
    }
    assert.equal(isProcessAlive(descendantPid), true);

    await terminateProcessTree(leader, {
      termTimeoutMs: 100,
      killTimeoutMs: 1000,
      pollIntervalMs: 10
    });

    assert.equal(
      await waitForCondition(() => !isProcessAlive(descendantPid), 1000),
      true,
      'process-tree cleanup returned while the descendant was alive'
    );
  } finally {
    if (Number.isInteger(descendantPid) && isProcessAlive(descendantPid)) {
      try {
        process.kill(descendantPid, 'SIGKILL');
      } catch (error) {
        if (error?.code !== 'ESRCH') {
          throw error;
        }
      }
    }
    try {
      process.kill(-leader.pid, 'SIGKILL');
    } catch (error) {
      if (error?.code !== 'ESRCH') {
        throw error;
      }
    }
  }
});

test('runner rejects a signal received while success cleanup is pending', {
  timeout: 2000
}, async () => {
  let markCleanupStarted;
  const cleanupStarted = new Promise((resolve) => {
    markCleanupStarted = resolve;
  });
  let releaseCleanup;
  const harness = createHarness({
    async terminateProcessTree(spawnedChild) {
      harness.events.push('electron-stop');
      assert.equal(spawnedChild, harness.child);
      markCleanupStarted();
      await new Promise((resolve) => {
        releaseCleanup = resolve;
      });
    }
  });

  const run = runElectronE2E(harness.dependencies);
  await withTestTimeout(cleanupStarted, 500);
  harness.signalTarget.emit('SIGTERM');
  releaseCleanup();

  await assert.rejects(
    withTestTimeout(run, 1000),
    /Electron E2E interrupted by SIGTERM/
  );
  assertCleanup(harness);
});

for (const signal of ['SIGINT', 'SIGTERM']) {
  test(`runner cleans every resource when interrupted by ${signal}`, {
    timeout: 2000
  }, async () => {
    const initialTimeoutCount = activeTimeoutCount();
    let markScenarioStarted;
    const scenarioStarted = new Promise((resolve) => {
      markScenarioStarted = resolve;
    });
    const harness = createHarness({
      async runScenarios() {
        harness.events.push('scenarios');
        markScenarioStarted();
        return new Promise(() => {});
      }
    });

    const run = runElectronE2E(harness.dependencies);
    await withTestTimeout(scenarioStarted, 500);
    harness.signalTarget.emit(signal);

    await assert.rejects(
      withTestTimeout(run, 1000),
      new RegExp(`interrupted by ${signal}`)
    );
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(
      activeTimeoutCount(),
      initialTimeoutCount,
      'signal cleanup must not leave the scenario timeout running'
    );
    assertCleanup(harness);
  });
}
