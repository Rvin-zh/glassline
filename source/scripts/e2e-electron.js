#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const http = require('node:http');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const { spawn: defaultSpawn } = require('node:child_process');

const {
  E2E_MODEL: FAKE_MODEL,
  E2E_MEMORY_MODEL,
  E2E_MEMORY_NOTE,
  E2E_MEMORY_TOPIC,
  E2E_PORTKEY_API_KEY,
  E2E_PORTKEY_PROVIDER,
  createFakePortkeyGateway: defaultCreateFakePortkeyGateway
} = require('./e2e/fake-portkey-gateway');
const { connectCdp: defaultConnectCdp } = require('./e2e/cdp-client');
const {
  E2E_HOST_RESOLVER_RULES,
  E2E_NETWORK_POLICY_VALUE
} = require('../src/platform/e2e-network-guard');

const LOOPBACK_HOST = '127.0.0.1';
const FAKE_CHUNKS = Object.freeze(['Stream', 'ing ', 'works']);
const FINAL_FAKE_TEXT = FAKE_CHUNKS.join('');
const CHAT_INPUT = 'E2E stream request';
const RESUME_FIXTURE = 'E2E resume fixture for document paste verification.';
const PREVIOUS_INTERVIEW_TOPIC_FIXTURE = 'E2E_PREVIOUS_INTERVIEW_TOPIC';
const DURABLE_NOTE_FIXTURE = 'E2E durable note fixture.';
const CUSTOM_OUTPUT_TEMPLATE_FIXTURE =
  'E2E custom: verdict, evidence, next step.';

const DEFAULT_STARTUP_TIMEOUT_MS = 20000;
const DEFAULT_SCENARIO_TIMEOUT_MS = 30000;
const DEFAULT_CLEANUP_TIMEOUT_MS = 5000;
const DEFAULT_FAKE_CHUNK_DELAY_MS = 300;
const DEFAULT_POST_END_QUIET_MS = 300;
const MAX_NETWORK_REPORT_BYTES = 64 * 1024;

const SECRET_ENVIRONMENT_NAMES = Object.freeze([
  'GEMINI_API_KEY',
  'GEMINI_API_KEYS',
  'GOOGLE_API_KEY',
  'ASSEMBLY_AI_API_KEY',
  'OPENAI_API_KEY',
  'PORTKEY_API_KEY',
  'TAVILY_API_KEY',
  'ANTHROPIC_API_KEY',
  'AZURE_OPENAI_API_KEY',
  'AWS_ACCESS_KEY_ID',
  'AWS_SECRET_ACCESS_KEY',
  'AWS_SESSION_TOKEN'
]);
const NODE_INJECTION_ENVIRONMENT_NAMES = new Set([
  'ELECTRON_RUN_AS_NODE',
  'NODE_OPTIONS',
  'NODE_PATH',
  'NODE_REPL_EXTERNAL_MODULE'
]);

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function normalizeDuration(value, fallback, minimum = 1) {
  const number = Number(value);
  if (!Number.isFinite(number) || number < minimum) {
    return fallback;
  }
  return Math.floor(number);
}

function withTimeout(promise, timeoutMs, timeoutMessage) {
  let timeout;
  return Promise.race([
    Promise.resolve(promise),
    new Promise((resolve, reject) => {
      timeout = setTimeout(() => reject(new Error(timeoutMessage)), timeoutMs);
      void resolve;
    })
  ]).finally(() => clearTimeout(timeout));
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function sanitizeDiagnosticText(value, sensitiveValues = []) {
  let text = String(value || 'Electron E2E failed');

  for (const sensitiveValue of sensitiveValues) {
    const secret = String(sensitiveValue || '');
    if (!secret) {
      continue;
    }
    text = text.replace(new RegExp(escapeRegExp(secret), 'g'), '[REDACTED]');
  }

  text = text
    .replace(/\bAIza[0-9A-Za-z_-]{16,}\b/g, '[REDACTED]')
    .replace(/\bsk-(?:proj-)?[0-9A-Za-z_-]{12,}\b/g, '[REDACTED]')
    .replace(/\b(?:pk|pkey)[-_][0-9A-Za-z_-]{12,}\b/gi, '[REDACTED]')
    .replace(/\bBearer\s+[0-9A-Za-z._~+/-]{8,}=*\b/gi, 'Bearer [REDACTED]')
    .replace(
      /((?:api[-_\s]?key|access[-_\s]?token|secret)\s*[:=]\s*)(?:"[^"]*"|'[^']*'|\S+)/gi,
      '$1[REDACTED]'
    );

  const maximumLength = 12000;
  if (text.length > maximumLength) {
    return `${text.slice(0, maximumLength)}\n[diagnostics truncated]`;
  }
  return text;
}

function createSeedState(fakeBaseUrl) {
  return {
    aiProvider: 'portkey',
    portkeyApiKey: E2E_PORTKEY_API_KEY,
    portkeyProvider: E2E_PORTKEY_PROVIDER,
    portkeyBaseUrl: fakeBaseUrl,
    geminiModel: FAKE_MODEL,
    programmingLanguage: 'Python',
    promptCacheEnabled: false,
    webSearchEnabled: false,
    requestWebSearchEnabled: false,
    defaultOutputFormat: 'quick',
    customOutputTemplate: CUSTOM_OUTPUT_TEMPLATE_FIXTURE,
    autoScreenIntervalSeconds: 10,
    themePreference: 'light',
    documents: {
      resume: {
        text: '',
        enabled: true,
        source: null,
        hash: null,
        updatedAt: null
      },
      jobDescription: {
        text: '',
        enabled: true,
        source: null,
        hash: null,
        updatedAt: null
      }
    },
    durableNotes: [{
      id: 'e2e-durable-note',
      text: DURABLE_NOTE_FIXTURE,
      status: 'approved',
      updatedAt: 1
    }],
    sessionMemory: {
      currentTopic: PREVIOUS_INTERVIEW_TOPIC_FIXTURE,
      questions: ['E2E previous interview question'],
      facts: [],
      candidateExamples: [],
      strengthsGaps: [],
      commitments: [],
      updatedAt: 1
    },
    sessionMemorySummary: null,
    interviewSessions: [],
    selectedInterviewSessionIds: ['stale-selection-must-reset'],
    sttProvider: 'assemblyai',
    windowOpacityLevel: 10
  };
}

function seedAppState(stateDirectory, fakeBaseUrl) {
  const cacheDirectory = path.join(stateDirectory, 'cache');
  const statePath = path.join(cacheDirectory, 'app-state.json');
  fs.mkdirSync(cacheDirectory, { recursive: true, mode: 0o700 });
  fs.writeFileSync(
    statePath,
    `${JSON.stringify(createSeedState(fakeBaseUrl), null, 2)}\n`,
    { encoding: 'utf8', mode: 0o600 }
  );
  return statePath;
}

function createIsolatedEnvironmentFile(stateDirectory) {
  const envPath = path.join(stateDirectory, 'open-cluely-e2e-empty.env');
  fs.writeFileSync(envPath, '', { encoding: 'utf8', mode: 0o600 });
  return envPath;
}

function createNetworkPolicyReportFile(stateDirectory) {
  const reportPath = path.join(stateDirectory, 'open-cluely-e2e-network.jsonl');
  fs.writeFileSync(reportPath, '', { encoding: 'utf8', mode: 0o600 });
  return reportPath;
}

function verifyNetworkPolicyReport(reportPath) {
  let contents;
  try {
    const stats = fs.statSync(reportPath);
    if (stats.size > MAX_NETWORK_REPORT_BYTES) {
      throw new Error('oversized');
    }
    contents = fs.readFileSync(reportPath, 'utf8');
  } catch {
    const error = new Error('E2E network policy report was unavailable');
    error.code = 'OPEN_CLUELY_E2E_NETWORK_POLICY_INACTIVE';
    throw error;
  }

  const readyTransports = new Set();
  let blockedAttemptCount = 0;
  try {
    for (const line of contents.split('\n')) {
      if (!line.trim()) {
        continue;
      }
      const event = JSON.parse(line);
      if (event?.type === 'policy-ready') {
        if (event.transport === 'node' || event.transport === 'renderer') {
          readyTransports.add(event.transport);
        }
      } else if (event?.type === 'blocked-outbound') {
        blockedAttemptCount += 1;
      } else {
        throw new Error('invalid event');
      }
    }
  } catch {
    const error = new Error('E2E network policy report was invalid');
    error.code = 'OPEN_CLUELY_E2E_NETWORK_POLICY_INACTIVE';
    throw error;
  }

  if (blockedAttemptCount > 0) {
    const error = new Error(
      `Blocked outbound network attempt detected by E2E policy (count: ${blockedAttemptCount})`
    );
    error.code = 'OPEN_CLUELY_E2E_NETWORK_BLOCKED';
    throw error;
  }
  if (!readyTransports.has('node') || !readyTransports.has('renderer')) {
    const error = new Error(
      'E2E network policy did not activate for both application and renderer'
    );
    error.code = 'OPEN_CLUELY_E2E_NETWORK_POLICY_INACTIVE';
    throw error;
  }
}

function makeTempDirectory(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

async function reserveDebugPort() {
  const server = net.createServer();
  server.unref();

  await new Promise((resolve, reject) => {
    const onError = () => {
      server.off('listening', onListening);
      reject(new Error('Could not reserve a loopback debugging port'));
    };
    const onListening = () => {
      server.off('error', onError);
      resolve();
    };

    server.once('error', onError);
    server.once('listening', onListening);
    server.listen({
      host: LOOPBACK_HOST,
      port: 0,
      exclusive: true
    });
  });

  const address = server.address();
  if (!address || typeof address === 'string' || !Number.isInteger(address.port)) {
    server.close();
    throw new Error('Could not determine the loopback debugging port');
  }

  let releasePromise = null;
  return {
    port: address.port,
    release() {
      if (releasePromise) {
        return releasePromise;
      }
      releasePromise = new Promise((resolve, reject) => {
        if (!server.listening) {
          resolve();
          return;
        }
        server.close((error) => {
          if (error) {
            reject(new Error('Could not release the loopback debugging port'));
            return;
          }
          resolve();
        });
      });
      return releasePromise;
    }
  };
}

function requestDebugTargets(port, timeoutMs = 1000) {
  return new Promise((resolve, reject) => {
    const request = http.get({
      hostname: LOOPBACK_HOST,
      port,
      path: '/json',
      agent: false,
      headers: {
        accept: 'application/json'
      }
    }, (response) => {
      if (response.statusCode !== 200) {
        response.resume();
        reject(new Error('DevTools target discovery returned a non-success status'));
        return;
      }

      response.setEncoding('utf8');
      let body = '';
      response.on('data', (chunk) => {
        body += chunk;
        if (body.length > 1024 * 1024) {
          request.destroy(new Error('DevTools target response exceeded its size bound'));
        }
      });
      response.on('end', () => {
        try {
          const targets = JSON.parse(body);
          if (!Array.isArray(targets)) {
            throw new Error('not an array');
          }
          resolve(targets);
        } catch {
          reject(new Error('DevTools target discovery returned invalid JSON'));
        }
      });
    });

    request.setTimeout(timeoutMs, () => {
      request.destroy(new Error('DevTools target request timed out'));
    });
    request.on('error', () => {
      reject(new Error('DevTools target discovery is not ready'));
    });
  });
}

async function discoverPage({
  port,
  timeoutMs = DEFAULT_STARTUP_TIMEOUT_MS,
  intervalMs = 100,
  getTargets = requestDebugTargets,
  signal
}) {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    if (signal?.aborted) {
      throw new Error('Renderer discovery interrupted');
    }
    try {
      const targets = await getTargets(port);
      const page = targets.find((target) => (
        target
        && target.type === 'page'
        && typeof target.webSocketDebuggerUrl === 'string'
        && target.webSocketDebuggerUrl.startsWith('ws://127.0.0.1:')
      ));
      if (page) {
        return page;
      }
    } catch {
      // Electron may not have opened the renderer target yet.
    }
    if (signal?.aborted) {
      throw new Error('Renderer discovery interrupted');
    }
    await delay(intervalMs);
  }

  throw new Error(`Renderer discovery timed out after ${timeoutMs}ms`);
}

function buildElectronArgs({ debuggingPort, userDataDirectory, repoRoot }) {
  return [
    '--ozone-platform=x11',
    `--remote-debugging-address=${LOOPBACK_HOST}`,
    `--remote-debugging-port=${debuggingPort}`,
    `--user-data-dir=${userDataDirectory}`,
    '--no-sandbox',
    '--no-first-run',
    '--no-default-browser-check',
    '--password-store=basic',
    '--disable-background-networking',
    '--disable-component-update',
    '--disable-domain-reliability',
    '--disable-sync',
    '--disable-breakpad',
    '--disable-async-dns',
    '--dns-over-https-mode=off',
    '--dns-prefetch-disable',
    '--metrics-recording-only',
    '--disable-features=AsyncDns,AutofillServerCommunication,DnsOverHttps,MediaRouter,OptimizationHints,Translate',
    `--host-resolver-rules=${E2E_HOST_RESOLVER_RULES}`,
    repoRoot
  ];
}

function buildLaunchEnvironment(
  sourceEnvironment,
  stateDirectory,
  envPath,
  networkReportPath
) {
  const environment = {
    ...sourceEnvironment,
    OPEN_CLUELY_STATE_DIR: stateDirectory,
    OPEN_CLUELY_ENV_PATH: envPath,
    OPEN_CLUELY_E2E_NETWORK_POLICY: E2E_NETWORK_POLICY_VALUE,
    OPEN_CLUELY_E2E_NETWORK_REPORT_PATH: networkReportPath,
    OPEN_CLUELY_E2E: '1',
    OPEN_CLUELY_E2E_SCREENSHOT_FIXTURE: '1',
    OPEN_CLUELY_E2E_AUTO_SCREEN_INTERVAL_MS: '250',
    OPEN_CLUELY_E2E_MEMORY_DEBOUNCE_MS: '60000',
    OPEN_CLUELY_DISABLE_MOBILE: '1',
    OPEN_CLUELY_DISPLAY_PROFILE: 'xwayland',
    OPEN_CLUELY_FULL_EFFECTS: '0',
    OPEN_CLUELY_ENABLE_GPU: '0',
    GDK_BACKEND: 'x11',
    START_HIDDEN: 'false',
    NODE_ENV: 'production',
    HTTP_PROXY: '',
    HTTPS_PROXY: '',
    ALL_PROXY: '',
    http_proxy: '',
    https_proxy: '',
    all_proxy: '',
    NO_PROXY: '127.0.0.1,localhost',
    no_proxy: '127.0.0.1,localhost'
  };

  for (const name of SECRET_ENVIRONMENT_NAMES) {
    environment[name] = '';
  }
  for (const name of Object.keys(environment)) {
    if (NODE_INJECTION_ENVIRONMENT_NAMES.has(name.toUpperCase())) {
      delete environment[name];
    }
  }

  return environment;
}

function createChildOutputCapture(child, maximumCharacters = 16000) {
  let output = '';
  const append = (chunk) => {
    output += String(chunk || '');
    if (output.length > maximumCharacters) {
      output = output.slice(-maximumCharacters);
    }
  };

  child.stdout?.on?.('data', append);
  child.stderr?.on?.('data', append);

  return {
    read: () => output,
    stop() {
      child.stdout?.off?.('data', append);
      child.stderr?.off?.('data', append);
    }
  };
}

function monitorUnexpectedChildExit(child) {
  let onError;
  let onExit;

  const promise = new Promise((resolve, reject) => {
    onError = () => reject(new Error('Electron process failed to start'));
    onExit = (code, signal) => {
      const outcome = signal
        ? `signal ${String(signal)}`
        : `code ${Number.isInteger(code) ? code : 'unknown'}`;
      reject(new Error(`Electron exited before E2E completion (${outcome})`));
    };
    child.once('error', onError);
    child.once('exit', onExit);
    void resolve;
  });

  return {
    promise,
    stop() {
      child.off('error', onError);
      child.off('exit', onExit);
    }
  };
}

function hasChildExited(child) {
  return child.exitCode !== null || child.signalCode !== null;
}

function waitForChildExit(child, timeoutMs) {
  if (hasChildExited(child)) {
    return Promise.resolve(true);
  }

  return new Promise((resolve) => {
    let settled = false;
    const finish = (exited) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timeout);
      child.off('exit', onExit);
      resolve(exited);
    };
    const onExit = () => finish(true);
    const timeout = setTimeout(() => finish(false), timeoutMs);
    child.once('exit', onExit);
  });
}

function isProcessGroupAlive(processGroupId, processKill = process.kill) {
  try {
    processKill(-processGroupId, 0);
    return true;
  } catch (error) {
    if (error?.code === 'ESRCH') {
      return false;
    }
    if (error?.code === 'EPERM') {
      return true;
    }
    throw new Error('Could not inspect the spawned Electron process group');
  }
}

async function waitForProcessGroupExit(
  processGroupId,
  timeoutMs,
  processKill = process.kill,
  pollIntervalMs = 25
) {
  const deadline = Date.now() + timeoutMs;
  while (isProcessGroupAlive(processGroupId, processKill)) {
    if (Date.now() >= deadline) {
      return false;
    }
    await delay(Math.min(pollIntervalMs, Math.max(1, deadline - Date.now())));
  }
  return true;
}

function signalSpawnedProcessTree(child, signal, processKill = process.kill) {
  if (!child || !Number.isInteger(child.pid) || child.pid <= 0) {
    return;
  }

  if (process.platform !== 'win32') {
    try {
      processKill(-child.pid, signal);
      return;
    } catch (error) {
      if (error?.code === 'ESRCH') {
        return;
      }
      throw new Error('Could not signal the spawned Electron process group');
    }
  }

  if (hasChildExited(child)) {
    return;
  }
  try {
    child.kill(signal);
  } catch (error) {
    if (error?.code !== 'ESRCH') {
      throw new Error('Could not signal the spawned Electron process');
    }
  }
}

async function terminateProcessTree(child, options = {}) {
  if (!child || !Number.isInteger(child.pid) || child.pid <= 0) {
    return;
  }

  const termTimeoutMs = normalizeDuration(options.termTimeoutMs, 3000);
  const killTimeoutMs = normalizeDuration(options.killTimeoutMs, 1000);
  const pollIntervalMs = normalizeDuration(options.pollIntervalMs, 25);
  const processKill = options.processKill || process.kill;

  if (process.platform !== 'win32') {
    if (!isProcessGroupAlive(child.pid, processKill)) {
      return;
    }

    signalSpawnedProcessTree(child, 'SIGTERM', processKill);
    if (await waitForProcessGroupExit(
      child.pid,
      termTimeoutMs,
      processKill,
      pollIntervalMs
    )) {
      return;
    }

    signalSpawnedProcessTree(child, 'SIGKILL', processKill);
    if (!await waitForProcessGroupExit(
      child.pid,
      killTimeoutMs,
      processKill,
      pollIntervalMs
    )) {
      throw new Error('Spawned Electron process group did not terminate');
    }
    return;
  }

  if (hasChildExited(child)) {
    return;
  }
  signalSpawnedProcessTree(child, 'SIGTERM', processKill);
  if (await waitForChildExit(child, termTimeoutMs)) {
    return;
  }

  signalSpawnedProcessTree(child, 'SIGKILL', processKill);
  if (!await waitForChildExit(child, killTimeoutMs)) {
    throw new Error('Spawned Electron process did not terminate');
  }
}

function removeDirectory(directory) {
  fs.rmSync(directory, { recursive: true, force: true });
}

function addSignalListener(target, signal, listener) {
  if (typeof target?.on !== 'function') {
    throw new Error('Signal target does not support listeners');
  }
  target.on(signal, listener);
}

function removeSignalListener(target, signal, listener) {
  if (typeof target?.off === 'function') {
    target.off(signal, listener);
  } else if (typeof target?.removeListener === 'function') {
    target.removeListener(signal, listener);
  }
}

async function collectSafeDomDiagnostics(cdp) {
  if (!cdp || typeof cdp.evaluate !== 'function') {
    return null;
  }

  try {
    return await withTimeout(cdp.evaluate(`(() => ({
      readyState: document.readyState,
      rootClasses: Array.from(document.documentElement?.classList || [])
        .filter((name) => name === 'reduced-effects' || name.startsWith('platform-')),
      settingsOpen: Boolean(
        document.getElementById('settings-panel')
        && !document.getElementById('settings-panel').classList.contains('hidden')
      ),
      chatMessageCount: document.querySelectorAll('#chat-messages .chat-message').length,
      hasElectronApi: typeof window.electronAPI === 'object'
    }))()`), 750, 'DOM diagnostics timed out');
  } catch {
    return null;
  }
}

function scenarioError(name) {
  return new Error(`Scenario failed: ${name}`);
}

function getProviderRequestPrompt(request) {
  return (Array.isArray(request?.messages) ? request.messages : [])
    .flatMap((message) => {
      if (typeof message?.content === 'string') {
        return [message.content];
      }
      if (Array.isArray(message?.content)) {
        return message.content
          .map((part) => (typeof part?.text === 'string' ? part.text : ''));
      }
      return [];
    })
    .filter(Boolean)
    .join('\n');
}

function assertRequestHasActiveOutputFormat(
  request,
  outputFormat,
  customOutputTemplate = ''
) {
  const normalizedFormat = String(outputFormat || '').trim().toLowerCase();
  const normalizedTemplate = String(customOutputTemplate || '');
  const marker =
    `=== ACTIVE OUTPUT FORMAT: ${normalizedFormat.toUpperCase()} ===`;
  const prompt = getProviderRequestPrompt(request);
  if (
    !normalizedFormat ||
    prompt.split(marker).length - 1 !== 1 ||
    prompt.split('=== ACTIVE OUTPUT FORMAT:').length - 1 !== 1 ||
    (
      normalizedFormat === 'custom' &&
      (!normalizedTemplate || !prompt.includes(normalizedTemplate))
    )
  ) {
    throw scenarioError(`${normalizedFormat || 'unknown'} output format prompt`);
  }
}

function assertBackgroundMemoryEvidence(evidence) {
  const fail = () => {
    throw scenarioError('Portkey background memory');
  };
  const result = evidence?.result;
  const request = evidence?.request;
  const prompt = getProviderRequestPrompt(request);

  if (
    result?.success !== true
    || result?.summary?.currentTopic !== E2E_MEMORY_TOPIC
    || !result?.summary?.proposedDurableNotes?.some(
      (note) => note?.text === E2E_MEMORY_NOTE
    )
    || !result?.queue?.some((note) => note?.text === E2E_MEMORY_NOTE)
    || result?.status?.provider !== 'portkey'
    || result?.status?.model !== E2E_MEMORY_MODEL
    || result?.status?.ready !== true
    || typeof result?.status?.lastSuccessAt !== 'string'
    || result?.status?.lastErrorCategory !== null
    || result?.status?.lastErrorAt !== null
    || evidence?.requestCountAfter !== evidence?.requestCountBefore + 1
    || evidence?.reviewCandidateVisible !== true
    || request?.model !== E2E_MEMORY_MODEL
    || request?.stream !== false
    || !prompt.includes('You maintain structured interview/session memory')
    || !prompt.includes('Return ONLY valid JSON')
    || request?.memory?.temperature !== 0.2
    || request?.memory?.responseFormat?.type !== 'json_object'
    || request?.memory?.thinking?.type !== 'enabled'
    || request?.memory?.thinking?.budget_tokens !== 256
    || request?.memory?.reasoning?.effort !== 'none'
  ) {
    fail();
  }
}

async function runNamedScenario(name, action, reportPass, timeoutMs = 8000) {
  await withTimeout(
    Promise.resolve().then(action),
    timeoutMs,
    `Scenario timed out: ${name}`
  );
  reportPass(name);
}

async function focusTextControl(cdp, selector) {
  const focused = await cdp.evaluate(`(() => {
    const element = document.querySelector(${JSON.stringify(selector)});
    if (!element) return false;
    element.focus();
    element.value = '';
    element.dispatchEvent(new Event('input', { bubbles: true }));
    return document.activeElement === element;
  })()`);
  if (!focused) {
    throw new Error('Could not focus the requested E2E text control');
  }
}

async function installRendererStreamingProbe(cdp) {
  const installed = await cdp.evaluate(`(() => {
    const api = window.electronAPI;
    const chatMessages = document.getElementById('chat-messages');
    if (
      typeof api?.onAiStreamStart !== 'function'
      || typeof api?.onAiStreamChunk !== 'function'
      || typeof api?.onAiStreamEnd !== 'function'
      || typeof api?.onError !== 'function'
      || !chatMessages
    ) {
      return false;
    }

    window.__openCluelyE2EStreamProbe?.dispose?.();
    const state = {
      events: [],
      domSnapshots: [],
      errorCount: 0
    };
    const readLatestAssistantText = () => {
      const messages = Array.from(
        document.querySelectorAll('#chat-messages .ai-response-message .message-content')
      );
      const element = messages[messages.length - 1];
      if (!element) return '';
      return String(element.innerText || '')
        .replace(/\\r/g, '')
        .trim()
        .replace(/^Best Next Answer(?: \\(Transcript(?: \\+ Screen)?\\))?:\\s*/, '')
        .trim();
    };
    const observer = new MutationObserver(() => {
      state.domSnapshots.push(readLatestAssistantText());
    });
    observer.observe(chatMessages, {
      childList: true,
      characterData: true,
      subtree: true
    });
    const record = (type, payload = {}) => {
      const event = {
        type,
        actionId: String(payload?.actionId || '')
      };
      if (type === 'chunk') {
        event.text = String(payload?.text || '');
        event.index = Number(payload?.index);
      }
      state.events.push(event);
    };
    const removers = [
      api.onAiStreamStart((payload) => record('start', payload)),
      api.onAiStreamChunk((payload) => record('chunk', payload)),
      api.onAiStreamEnd((payload) => record('end', payload)),
      api.onError(() => {
        state.errorCount += 1;
        state.events.push({ type: 'error', actionId: '' });
      })
    ];

    window.__openCluelyE2EStreamProbe = {
      state,
      dispose() {
        observer.disconnect();
        for (const remove of removers) {
          if (typeof remove === 'function') {
            remove();
          }
        }
      }
    };
    return true;
  })()`);
  if (!installed) {
    throw scenarioError('incremental chat streaming');
  }
}

async function sendTypedChatInput(cdp) {
  await installRendererStreamingProbe(cdp);
  await focusTextControl(cdp, '#chat-manual-input');
  await cdp.call('Input.insertText', { text: CHAT_INPUT });

  const readyToSend = await cdp.evaluate(
    `document.getElementById('chat-manual-input')?.value === ${JSON.stringify(CHAT_INPUT)}
      && document.getElementById('chat-manual-send')?.disabled === false`
  );
  if (!readyToSend) {
    throw scenarioError('typed chat input sent via Send');
  }

  const clicked = await cdp.evaluate(`(() => {
    const button = document.getElementById('chat-manual-send');
    if (!button || button.disabled) return false;
    button.click();
    return true;
  })()`);
  if (!clicked) {
    throw scenarioError('typed chat input sent via Send');
  }

  await cdp.waitFor(
    `Array.from(document.querySelectorAll('#chat-messages .voice-mic-message .message-content'))
      .some((element) => element.innerText === ${JSON.stringify(CHAT_INPUT)})`,
    {
      timeoutMs: 5000,
      intervalMs: 25
    }
  );
}

async function selectToolbarOutputFormat(cdp, outputFormat) {
  const selected = await cdp.evaluate(`(() => {
    const select = document.getElementById('output-format-select');
    if (!select) return '';
    select.value = ${JSON.stringify(outputFormat)};
    select.dispatchEvent(new Event('change', { bubbles: true }));
    return select.value;
  })()`);
  if (selected !== outputFormat) {
    throw scenarioError(`${outputFormat} output format prompt`);
  }
}

const LATEST_ASSISTANT_ANSWER_EXPRESSION = `(() => {
  const messages = Array.from(
    document.querySelectorAll('#chat-messages .ai-response-message .message-content')
  );
  const element = messages[messages.length - 1];
  if (!element) return '';
  const text = String(element.innerText || '').replace(/\\r/g, '').trim();
  return text
    .replace(/^Best Next Answer(?: \\(Transcript(?: \\+ Screen)?\\))?:\\s*/, '')
    .trim();
})()`;

function assertStreamingCompletionEvidence(evidence) {
  const fail = () => {
    throw scenarioError('incremental chat streaming');
  };
  if (!evidence || !Array.isArray(evidence.events)) {
    fail();
  }

  const matchingEvents = evidence.events.filter(
    (event) => event?.actionId === 'askAi'
  );
  const starts = matchingEvents.filter((event) => event.type === 'start');
  const chunks = matchingEvents.filter((event) => event.type === 'chunk');
  const ends = matchingEvents.filter((event) => event.type === 'end');
  if (starts.length !== 1 || chunks.length < 2 || ends.length !== 1) {
    fail();
  }

  const startIndex = matchingEvents.indexOf(starts[0]);
  const endIndex = matchingEvents.indexOf(ends[0]);
  const chunkIndexes = chunks.map((chunk) => matchingEvents.indexOf(chunk));
  if (
    startIndex !== 0
    || chunkIndexes.some((index) => index <= startIndex || index >= endIndex)
    || endIndex !== matchingEvents.length - 1
  ) {
    fail();
  }

  let accumulatedText = '';
  const prefixSnapshots = [];
  let previousChunkIndex = 0;
  for (const chunk of chunks) {
    if (
      typeof chunk.text !== 'string'
      || chunk.text.length === 0
      || !Number.isInteger(chunk.index)
      || chunk.index <= previousChunkIndex
    ) {
      fail();
    }
    previousChunkIndex = chunk.index;
    accumulatedText += chunk.text;
    if (!FINAL_FAKE_TEXT.startsWith(accumulatedText)) {
      fail();
    }
    prefixSnapshots.push(accumulatedText);
  }

  if (
    new Set(prefixSnapshots).size < 2
    || accumulatedText !== FINAL_FAKE_TEXT
    || evidence.finalText !== FINAL_FAKE_TEXT
    || evidence.errorCount !== 0
    || evidence.systemErrorCount !== 0
  ) {
    fail();
  }

  if (!Array.isArray(evidence.domSnapshots)) {
    fail();
  }
  let previousDomPrefix = '';
  const distinctDomPrefixes = [];
  let sawExactDomFinal = false;
  for (const snapshot of evidence.domSnapshots) {
    const text = String(snapshot || '');
    if (!text) {
      continue;
    }
    if (text === FINAL_FAKE_TEXT) {
      sawExactDomFinal = true;
      break;
    }
    if (
      !FINAL_FAKE_TEXT.startsWith(text)
      || (previousDomPrefix && !text.startsWith(previousDomPrefix))
    ) {
      fail();
    }
    if (text !== previousDomPrefix) {
      distinctDomPrefixes.push(text);
      previousDomPrefix = text;
    }
  }
  if (!sawExactDomFinal || distinctDomPrefixes.length < 2) {
    fail();
  }
}

async function readStreamingCompletionEvidence(cdp) {
  return cdp.evaluate(`(() => {
    const state = window.__openCluelyE2EStreamProbe?.state;
    if (!state) return null;
    return {
      events: state.events.slice(0, 100).map((event) => ({
        type: String(event?.type || ''),
        actionId: String(event?.actionId || ''),
        text: event?.type === 'chunk' ? String(event?.text || '') : undefined,
        index: event?.type === 'chunk' ? Number(event?.index) : undefined
      })),
      domSnapshots: Array.isArray(state.domSnapshots)
        ? state.domSnapshots.slice(0, 100).map((snapshot) => String(snapshot || ''))
        : [],
      errorCount: Number(state.errorCount || 0),
      finalText: ${LATEST_ASSISTANT_ANSWER_EXPRESSION},
      systemErrorCount:
        document.querySelectorAll('#chat-messages .chat-message.system-message').length
    };
  })()`);
}

async function collectStreamingSnapshots(cdp, fakeServer, options = {}) {
  const normalizedOptions = typeof options === 'number'
    ? { timeoutMs: options }
    : options;
  const timeoutMs = normalizeDuration(normalizedOptions.timeoutMs, 10000);
  const quietWindowMs = normalizeDuration(
    normalizedOptions.quietWindowMs,
    DEFAULT_POST_END_QUIET_MS
  );
  const delayImpl = normalizedOptions.delayImpl || delay;

  await cdp.waitFor(`(() => {
    const events = window.__openCluelyE2EStreamProbe?.state?.events || [];
    const matchingEnds = events.filter(
      (event) => event?.type === 'end' && event?.actionId === 'askAi'
    );
    return matchingEnds.length >= 1
      && ${LATEST_ASSISTANT_ANSWER_EXPRESSION} === ${JSON.stringify(FINAL_FAKE_TEXT)};
  })()`, {
    timeoutMs,
    intervalMs: 25
  });

  await delayImpl(quietWindowMs);
  const evidence = await readStreamingCompletionEvidence(cdp);
  assertStreamingCompletionEvidence(evidence);

  const request = fakeServer.requests[0];
  if (
    fakeServer.requests.length !== 1
    || request?.model !== FAKE_MODEL
    || request?.stream !== true
    || !request?.messages?.some((message) => (
      message?.role === 'user'
      && typeof message.content === 'string'
      && message.content.includes(CHAT_INPUT)
    ))
  ) {
    throw scenarioError('incremental chat streaming');
  }
}

async function waitForLatestTypedRequest(cdp, fakeServer, requestIndex) {
  await cdp.waitFor(`(() => {
    const events = window.__openCluelyE2EStreamProbe?.state?.events || [];
    return events.some(
      (event) => event?.type === 'end' && event?.actionId === 'askAi'
    ) && ${LATEST_ASSISTANT_ANSWER_EXPRESSION} === ${JSON.stringify(FINAL_FAKE_TEXT)};
  })()`, {
    timeoutMs: 10000,
    intervalMs: 25
  });
  await delay(DEFAULT_POST_END_QUIET_MS);
  if (fakeServer.requests.length !== requestIndex + 1) {
    throw new Error('Typed output-format request count did not advance exactly once');
  }
  return fakeServer.requests[requestIndex];
}

async function invokeLiveToolbarAction(cdp, fakeServer, {
  buttonId,
  actionId
}) {
  await installRendererStreamingProbe(cdp);
  const requestIndex = fakeServer.requests.length;
  const clicked = await cdp.evaluate(`(() => {
    const button = document.getElementById(${JSON.stringify(buttonId)});
    if (!button || button.disabled) return false;
    button.click();
    return true;
  })()`);
  if (!clicked) {
    throw new Error(`Could not click ${buttonId}`);
  }
  await cdp.waitFor(`(() => {
    const events = window.__openCluelyE2EStreamProbe?.state?.events || [];
    return events.some(
      (event) => event?.type === 'end'
        && event?.actionId === ${JSON.stringify(actionId)}
    );
  })()`, {
    timeoutMs: 10000,
    intervalMs: 25
  });
  await delay(DEFAULT_POST_END_QUIET_MS);
  if (fakeServer.requests.length !== requestIndex + 1) {
    throw new Error(`${actionId} request count did not advance exactly once`);
  }
  return fakeServer.requests[requestIndex];
}

function hasSanitizedImagePart(request) {
  return request?.messages?.some((message) => (
    Array.isArray(message?.content) &&
    message.content.some((part) => part?.type === 'image_url')
  ));
}

function assertSingleScreenStreamingEvidence(evidence) {
  const screenEvents = Array.isArray(evidence?.events)
    ? evidence.events
        .filter((event) => event?.actionId === 'screenAi')
        .map((event) => ({ ...event, actionId: 'askAi' }))
    : [];
  const incrementalDomSnapshots = Array.isArray(evidence?.domSnapshots)
    ? evidence.domSnapshots.filter((snapshot) => {
        const text = String(snapshot || '');
        return text === FINAL_FAKE_TEXT || FINAL_FAKE_TEXT.startsWith(text);
      })
    : [];

  assertStreamingCompletionEvidence({
    ...evidence,
    events: screenEvents,
    domSnapshots: incrementalDomSnapshots
  });
}

function assertNonOverlappingScreenCycles(events, minimumCycles) {
  const screenEvents = (Array.isArray(events) ? events : [])
    .filter((event) => event?.actionId === 'screenAi');
  let activeCycles = 0;
  let completedCycles = 0;
  let chunksInCurrentCycle = 0;

  for (const event of screenEvents) {
    if (event.type === 'start') {
      if (activeCycles !== 0) {
        throw scenarioError('Auto Screen latest-capture retention');
      }
      activeCycles = 1;
      chunksInCurrentCycle = 0;
    } else if (event.type === 'chunk') {
      if (activeCycles !== 1 || !String(event.text || '')) {
        throw scenarioError('Auto Screen latest-capture retention');
      }
      chunksInCurrentCycle += 1;
    } else if (event.type === 'end') {
      if (activeCycles !== 1 || chunksInCurrentCycle < 2) {
        throw scenarioError('Auto Screen latest-capture retention');
      }
      activeCycles = 0;
      completedCycles += 1;
    }
  }

  if (activeCycles !== 0 || completedCycles < minimumCycles) {
    throw scenarioError('Auto Screen latest-capture retention');
  }
}

async function runDefaultScenarios({
  cdp,
  fakeServer,
  reportPass,
  startupTimeoutMs = DEFAULT_STARTUP_TIMEOUT_MS
}) {
  await runNamedScenario('renderer ready', async () => {
    await cdp.waitFor(`(() => (
      document.readyState === 'complete'
      && typeof window.electronAPI?.getSettings === 'function'
      && document.body?.style.visibility === 'visible'
      && document.getElementById('chat-manual-send')?.disabled === true
    ))()`, {
      timeoutMs: startupTimeoutMs,
      intervalMs: 50
    });
  }, reportPass, startupTimeoutMs);

  await runNamedScenario('reduced effects active', async () => {
    const active = await cdp.evaluate(`(() => {
      const root = document.documentElement;
      const app = document.getElementById('app');
      const animatedElement = document.querySelector('.status-dot');
      if (!root || !app || !animatedElement) return false;
      const appStyle = getComputedStyle(app);
      return root.classList.contains('platform-linux')
        && root.classList.contains('reduced-effects')
        && appStyle.backdropFilter === 'none'
        && getComputedStyle(animatedElement).animationName === 'none';
    })()`);
    if (!active) {
      throw scenarioError('reduced effects active');
    }
  }, reportPass);

  await runNamedScenario('controls below drag region', async () => {
    const controlsAreClear = await cdp.evaluate(`(() => {
      const drag = document.querySelector('.drag-handle')?.getBoundingClientRect();
      const toolbar = document.querySelector('.main-interface')?.getBoundingClientRect();
      const controls = Array.from(
        document.querySelectorAll('.main-interface button, .main-interface select')
      )
        .filter((control) => {
          const rect = control.getBoundingClientRect();
          return rect.width > 0 && rect.height > 0 && getComputedStyle(control).display !== 'none';
        });
      return Boolean(drag && toolbar)
        && controls.length > 0
        && controls.every((control) => (
          control.getBoundingClientRect().top + 0.5 >= drag.bottom
          && control.getBoundingClientRect().left + 0.5 >= toolbar.left
          && control.getBoundingClientRect().right - 0.5 <= toolbar.right
        ));
    })()`);
    if (!controlsAreClear) {
      throw scenarioError('controls below drag region');
    }
  }, reportPass);

  await runNamedScenario('Settings opens with seeded Portkey selected', async () => {
    const clicked = await cdp.evaluate(`(() => {
      const button = document.getElementById('settings-btn');
      if (!button) return false;
      button.click();
      return true;
    })()`);
    if (!clicked) {
      throw scenarioError('Settings opens with seeded Portkey selected');
    }

    await cdp.waitFor(`(async () => {
      const panel = document.getElementById('settings-panel');
      const settings = await window.electronAPI.getSettings();
      return Boolean(panel)
        && !panel.classList.contains('hidden')
        && document.getElementById('setting-ai-provider')?.value === 'portkey'
        && document.getElementById('setting-portkey-base-url')?.value
          === ${JSON.stringify(fakeServer.baseUrl)}
        && document.getElementById('setting-portkey-provider')?.value
          === ${JSON.stringify(E2E_PORTKEY_PROVIDER)}
        && document.getElementById('setting-portkey-model')?.value
          === ${JSON.stringify(FAKE_MODEL)}
        && settings?.hasPortkeyApiKey === true
        && settings?.hasGeminiApiKeys === false
        && settings?.backgroundMemory?.provider === 'portkey'
        && settings?.backgroundMemory?.model === ${JSON.stringify(E2E_MEMORY_MODEL)}
        && settings?.backgroundMemory?.ready === true
        && (document.getElementById('settings-diagnostics')?.textContent || '')
          .includes('"backgroundMemory"')
        && (document.getElementById('settings-diagnostics')?.textContent || '')
          .includes(${JSON.stringify(E2E_MEMORY_MODEL)})
        && document.getElementById('setting-programming-language')?.value === 'Python'
        && document.getElementById('setting-web-search-enabled')?.value === 'false'
        && document.getElementById('setting-request-web-search-enabled')?.value === 'false'
        && document.getElementById('setting-prompt-cache-enabled')?.value === 'false'
        && document.getElementById('setting-default-output-format')?.value === 'quick'
        && document.getElementById('setting-custom-output-template')?.value
          === ${JSON.stringify(CUSTOM_OUTPUT_TEMPLATE_FIXTURE)}
        && document.getElementById('output-format-select')?.value === 'quick'
        && settings?.durableNotesCount === 0
        && document.querySelectorAll('[data-interview-session-select]').length === 1
        && document.querySelector('[data-interview-session-select]')?.checked === false
        && (document.querySelector('.previous-interview-title')?.textContent || '')
          .includes(${JSON.stringify(PREVIOUS_INTERVIEW_TOPIC_FIXTURE)})
        && (document.querySelector('.previous-interview-meta')?.textContent || '')
          .includes('1 note');
    })()`, {
      timeoutMs: 8000,
      intervalMs: 50
    });
  }, reportPass);

  await runNamedScenario('previous interview excluded by default', async () => {
    const excluded = await cdp.evaluate(`(async () => {
      const sessions = await window.electronAPI.interviewSessionsList();
      const desktop = await window.electronAPI.contextAssemblePreview({
        audience: 'desktop'
      });
      const mobile = await window.electronAPI.contextAssemblePreview({
        audience: 'mobile'
      });
      const desktopText = JSON.stringify(desktop?.assembled || {});
      const mobileText = JSON.stringify(mobile?.assembled || {});
      return sessions?.success === true
        && sessions.sessions?.length === 1
        && sessions.selectedIds?.length === 0
        && sessions.sessions[0]?.selected === false
        && !desktopText.includes(${JSON.stringify(PREVIOUS_INTERVIEW_TOPIC_FIXTURE)})
        && !desktopText.includes(${JSON.stringify(DURABLE_NOTE_FIXTURE)})
        && !mobileText.includes(${JSON.stringify(PREVIOUS_INTERVIEW_TOPIC_FIXTURE)})
        && !mobileText.includes(${JSON.stringify(DURABLE_NOTE_FIXTURE)});
    })()`);
    if (!excluded || fakeServer.requests.length !== 0) {
      throw scenarioError('previous interview excluded by default');
    }
  }, reportPass);

  await runNamedScenario('previous interview selected through Settings', async () => {
    const clicked = await cdp.evaluate(`(() => {
      const checkbox = document.querySelector('[data-interview-session-select]');
      if (!checkbox || checkbox.checked) return false;
      checkbox.click();
      return true;
    })()`);
    if (!clicked) {
      throw scenarioError('previous interview selected through Settings');
    }

    await cdp.waitFor(`(async () => {
      const sessions = await window.electronAPI.interviewSessionsList();
      const checkbox = document.querySelector('[data-interview-session-select]');
      return sessions?.selectedIds?.length === 1
        && sessions.sessions?.length === 1
        && sessions.sessions[0]?.selected === true
        && checkbox?.checked === true;
    })()`, {
      timeoutMs: 8000,
      intervalMs: 50
    });
  }, reportPass);

  await runNamedScenario('selected interview enters desktop context only', async () => {
    const isolated = await cdp.evaluate(`(async () => {
      const desktop = await window.electronAPI.contextAssemblePreview({
        audience: 'desktop'
      });
      const mobile = await window.electronAPI.contextAssemblePreview({
        audience: 'mobile'
      });
      const desktopText = JSON.stringify(desktop?.assembled || {});
      const mobileText = JSON.stringify(mobile?.assembled || {});
      return desktop?.success === true
        && mobile?.success === true
        && desktopText.includes(${JSON.stringify(PREVIOUS_INTERVIEW_TOPIC_FIXTURE)})
        && desktopText.includes(${JSON.stringify(DURABLE_NOTE_FIXTURE)})
        && !mobileText.includes(${JSON.stringify(PREVIOUS_INTERVIEW_TOPIC_FIXTURE)})
        && !mobileText.includes(${JSON.stringify(DURABLE_NOTE_FIXTURE)});
    })()`);
    if (!isolated || fakeServer.requests.length !== 0) {
      throw scenarioError('selected interview enters desktop context only');
    }
  }, reportPass);

  await runNamedScenario('resume paste through Settings', async () => {
    await focusTextControl(cdp, '#setting-resume-paste');
    await cdp.call('Input.insertText', { text: RESUME_FIXTURE });

    const inserted = await cdp.evaluate(
      `document.getElementById('setting-resume-paste')?.value.length === ${RESUME_FIXTURE.length}`
    );
    if (!inserted) {
      throw scenarioError('resume paste through Settings');
    }

    const clicked = await cdp.evaluate(`(() => {
      const button = document.getElementById('save-resume-paste-btn');
      if (!button) return false;
      button.click();
      return true;
    })()`);
    if (!clicked) {
      throw scenarioError('resume paste through Settings');
    }

    await cdp.waitFor(`(async () => {
      const settings = await window.electronAPI.getSettings();
      const status = document.getElementById('resume-doc-status')?.textContent || '';
      return settings?.documents?.resume?.charCount === ${RESUME_FIXTURE.length}
        && settings?.documents?.resume?.hasText === true
        && status.includes('Resume stored')
        && status.includes('${RESUME_FIXTURE.length} chars');
    })()`, {
      timeoutMs: 8000,
      intervalMs: 50
    });
  }, reportPass);

  await runNamedScenario('Portkey background memory summary and review candidate', async () => {
    const requestCountBefore = fakeServer.requests.length;
    const result = await cdp.evaluate(`(async () => {
      const trigger = await window.electronAPI.memoryTriggerUpdate({
        transcript: 'E2E background memory transcript',
        recentAnswers: 'E2E background memory answer'
      });
      if (trigger?.success !== true) {
        return trigger;
      }
      return window.electronAPI.memoryFlush();
    })()`);

    await cdp.waitFor(`(() => (
      Array.from(
        document.querySelectorAll('#durable-notes-review-list .settings-review-item-text')
      ).some((element) => (
        (element.textContent || '').includes(${JSON.stringify(E2E_MEMORY_NOTE)})
      ))
    ))()`, {
      timeoutMs: 8000,
      intervalMs: 25
    });

    const reviewCandidateVisible = await cdp.evaluate(`(() => (
      Array.from(
        document.querySelectorAll('#durable-notes-review-list .settings-review-item-text')
      ).some((element) => (
        (element.textContent || '').includes(${JSON.stringify(E2E_MEMORY_NOTE)})
      ))
    ))()`);
    const requestCountAfter = fakeServer.requests.length;
    assertBackgroundMemoryEvidence({
      result,
      request: fakeServer.requests[requestCountBefore],
      requestCountBefore,
      requestCountAfter,
      reviewCandidateVisible
    });

    fakeServer.requests.splice(0, fakeServer.requests.length);
  }, reportPass, 12000);

  const settingsClosed = await cdp.evaluate(`(() => {
    const button = document.getElementById('close-settings');
    if (!button) return false;
    button.click();
    return document.getElementById('settings-panel')?.classList.contains('hidden') === true;
  })()`);
  if (!settingsClosed) {
    throw new Error('Could not close Settings before chat verification');
  }

  await runNamedScenario('manual screenshot streams Screen AI automatically', async () => {
    await installRendererStreamingProbe(cdp);
    const requestCountBefore = fakeServer.requests.length;
    const clicked = await cdp.evaluate(`(() => {
      const button = document.getElementById('screenshot-btn');
      if (!button || button.disabled) return false;
      button.click();
      return true;
    })()`);
    if (!clicked) {
      throw scenarioError('manual screenshot streams Screen AI automatically');
    }

    await cdp.waitFor(`(() => {
      const events = window.__openCluelyE2EStreamProbe?.state?.events || [];
      const ends = events.filter(
        (event) => event?.type === 'end' && event?.actionId === 'screenAi'
      );
      return ends.length === 1
        && ${LATEST_ASSISTANT_ANSWER_EXPRESSION} === ${JSON.stringify(FINAL_FAKE_TEXT)};
    })()`, {
      timeoutMs: 12000,
      intervalMs: 25
    });
    await delay(DEFAULT_POST_END_QUIET_MS);

    const evidence = await readStreamingCompletionEvidence(cdp);
    assertSingleScreenStreamingEvidence(evidence);
    const domEvidence = await cdp.evaluate(`(() => {
      const screenshots = Array.from(
        document.querySelectorAll('#chat-messages .screenshot-message')
      );
      return {
        count: screenshots.length,
        ids: screenshots.map((element) => element.dataset.screenshotId || ''),
        text: screenshots.map((element) => element.innerText || '')
      };
    })()`);
    const request = fakeServer.requests[requestCountBefore];
    if (
      fakeServer.requests.length !== requestCountBefore + 1 ||
      !hasSanitizedImagePart(request) ||
      domEvidence?.count !== 1 ||
      !domEvidence.ids?.[0] ||
      !domEvidence.text?.[0]?.includes('Screenshot captured')
    ) {
      throw scenarioError('manual screenshot streams Screen AI automatically');
    }
  }, reportPass, 15000);

  await runNamedScenario('Auto Screen latest-capture retention', async () => {
    await installRendererStreamingProbe(cdp);
    const requestCountBefore = fakeServer.requests.length;
    const clicked = await cdp.evaluate(`(() => {
      const button = document.getElementById('auto-screen-toggle');
      if (!button || button.getAttribute('aria-pressed') !== 'false') return false;
      button.click();
      return true;
    })()`);
    if (!clicked) {
      throw scenarioError('Auto Screen latest-capture retention');
    }

    await cdp.waitFor(`(() => {
      const events = window.__openCluelyE2EStreamProbe?.state?.events || [];
      const completed = events.filter(
        (event) => event?.type === 'end' && event?.actionId === 'screenAi'
      ).length;
      return completed >= 2
        && document.getElementById('auto-screen-toggle')
          ?.getAttribute('aria-pressed') === 'true'
        && document.querySelectorAll(
          '#chat-messages .screenshot-message'
        ).length === 2
        && Array.from(
          document.querySelectorAll('#chat-messages .screenshot-message')
        ).filter((element) => (
          (element.innerText || '').includes('Auto screenshot captured')
        )).length === 1
        && document.getElementById('screenshot-count')?.textContent === '2';
    })()`, {
      timeoutMs: 15000,
      intervalMs: 25
    });

    const evidence = await readStreamingCompletionEvidence(cdp);
    assertNonOverlappingScreenCycles(evidence?.events, 2);
    const autoRequests = fakeServer.requests.slice(requestCountBefore);
    if (
      autoRequests.length < 2 ||
      autoRequests.some((request) => !hasSanitizedImagePart(request))
    ) {
      throw scenarioError('Auto Screen latest-capture retention');
    }

    const clearClicked = await cdp.evaluate(`(() => {
      const button = document.getElementById('clear-btn');
      if (!button) return false;
      button.click();
      return true;
    })()`);
    if (!clearClicked) {
      throw scenarioError('Auto Screen latest-capture retention');
    }
    await cdp.waitFor(`(() => (
      document.getElementById('auto-screen-toggle')
        ?.getAttribute('aria-pressed') === 'false'
      && document.querySelectorAll('#chat-messages .chat-message').length === 0
    ))()`, {
      timeoutMs: 5000,
      intervalMs: 25
    });

    fakeServer.requests.splice(0, fakeServer.requests.length);
  }, reportPass, 20000);

  await runNamedScenario('typed chat input sent via Send', async () => {
    await sendTypedChatInput(cdp);
  }, reportPass);

  await runNamedScenario('incremental chat streaming', async () => {
    await collectStreamingSnapshots(cdp, fakeServer);
  }, reportPass, 12000);

  await runNamedScenario('foreground stream remains independent of memory', async () => {
    const request = fakeServer.requests[0];
    const memoryStatus = await cdp.evaluate(
      'window.electronAPI.memoryGetSummary()'
    );
    if (
      request?.model !== FAKE_MODEL
      || request?.stream !== true
      || request?.memory
      || memoryStatus?.status?.provider !== 'portkey'
      || memoryStatus?.status?.model !== E2E_MEMORY_MODEL
      || memoryStatus?.status?.ready !== true
    ) {
      throw scenarioError('foreground stream remains independent of memory');
    }
  }, reportPass);

  await runNamedScenario('quick output format prompt', async () => {
    assertRequestHasActiveOutputFormat(fakeServer.requests[0], 'quick');
  }, reportPass);

  for (const outputFormat of ['adaptive', 'detailed', 'custom']) {
    await runNamedScenario(`${outputFormat} output format prompt`, async () => {
      await selectToolbarOutputFormat(cdp, outputFormat);
      const requestIndex = fakeServer.requests.length;
      await sendTypedChatInput(cdp);
      const request = await waitForLatestTypedRequest(
        cdp,
        fakeServer,
        requestIndex
      );
      assertRequestHasActiveOutputFormat(
        request,
        outputFormat,
        outputFormat === 'custom' ? CUSTOM_OUTPUT_TEMPLATE_FIXTURE : ''
      );
    }, reportPass, 12000);
  }

  await runNamedScenario('Notes and Insights output format exemption', async () => {
    const notesRequest = await invokeLiveToolbarAction(cdp, fakeServer, {
      buttonId: 'notes-btn',
      actionId: 'notes'
    });
    const insightsRequest = await invokeLiveToolbarAction(cdp, fakeServer, {
      buttonId: 'insights-btn',
      actionId: 'insights'
    });
    for (const request of [notesRequest, insightsRequest]) {
      const prompt = getProviderRequestPrompt(request);
      if (
        prompt.includes('=== ACTIVE OUTPUT FORMAT:') ||
        prompt.includes(CUSTOM_OUTPUT_TEMPLATE_FIXTURE)
      ) {
        throw scenarioError('Notes and Insights output format exemption');
      }
    }
  }, reportPass, 24000);

  await runNamedScenario('theme toggles', async () => {
    const initialTheme = await cdp.evaluate(
      "document.documentElement.getAttribute('data-theme')"
    );
    const clicked = await cdp.evaluate(`(() => {
      const button = document.getElementById('theme-toggle-btn');
      if (!button) return false;
      button.click();
      return true;
    })()`);
    if (!clicked) {
      throw scenarioError('theme toggles');
    }

    await cdp.waitFor(`(() => {
      const theme = document.documentElement.getAttribute('data-theme');
      const button = document.getElementById('theme-toggle-btn');
      return theme !== ${JSON.stringify(initialTheme)}
        && document.body.classList.contains('theme-dark') === (theme === 'dark')
        && button?.getAttribute('aria-pressed') === (theme === 'dark' ? 'true' : 'false');
    })()`, {
      timeoutMs: 5000,
      intervalMs: 25
    });
  }, reportPass);

  await runNamedScenario('clear chat', async () => {
    const clicked = await cdp.evaluate(`(() => {
      const button = document.getElementById('clear-btn');
      if (!button) return false;
      button.click();
      return true;
    })()`);
    if (!clicked) {
      throw scenarioError('clear chat');
    }

    await cdp.waitFor(
      "document.querySelectorAll('#chat-messages .chat-message').length === 0",
      {
        timeoutMs: 5000,
        intervalMs: 25
      }
    );
  }, reportPass);
}

function assertLoopbackFakeServer(fakeServer) {
  try {
    const endpoint = new URL(fakeServer?.baseUrl);
    if (endpoint.protocol !== 'http:' || endpoint.hostname !== LOOPBACK_HOST) {
      throw new Error('not loopback');
    }
  } catch {
    throw new Error('Fake Portkey gateway did not bind to loopback');
  }
}

function buildPublicFailure({
  error,
  childOutput,
  domDiagnostics,
  cleanupErrors,
  sensitiveValues,
  suppressChildOutput = false
}) {
  const parts = [
    sanitizeDiagnosticText(error?.message || error, sensitiveValues)
  ];
  if (domDiagnostics) {
    parts.push(`DOM diagnostics: ${JSON.stringify(domDiagnostics)}`);
  }
  if (childOutput && !suppressChildOutput) {
    parts.push(
      `Electron diagnostics:\n${sanitizeDiagnosticText(childOutput, sensitiveValues)}`
    );
  }
  if (cleanupErrors.length > 0) {
    parts.push(`Cleanup diagnostics: ${cleanupErrors.join('; ')}`);
  }
  return new Error(parts.join('\n'));
}

async function runElectronE2E(options = {}) {
  const electronBinary = options.electronBinary || require('electron');
  const spawn = options.spawn || defaultSpawn;
  const createFakePortkeyGateway = options.createFakePortkeyGateway
    || defaultCreateFakePortkeyGateway;
  const connectCdp = options.connectCdp || defaultConnectCdp;
  const reservePort = options.reserveDebugPort || reserveDebugPort;
  const discoverRenderer = options.discoverPage || discoverPage;
  const executeScenarios = options.runScenarios || runDefaultScenarios;
  const stopProcessTree = options.terminateProcessTree || terminateProcessTree;
  const deleteDirectory = options.removeDirectory || removeDirectory;
  const createTempDirectory = options.makeTempDirectory || makeTempDirectory;
  const signalTarget = options.signalTarget || process;
  const logger = options.logger || console;
  const repoRoot = path.resolve(options.repoRoot || path.join(__dirname, '..'));
  const sourceEnvironment = options.environment || process.env;
  const startupTimeoutMs = normalizeDuration(
    options.startupTimeoutMs,
    DEFAULT_STARTUP_TIMEOUT_MS
  );
  const scenarioTimeoutMs = normalizeDuration(
    options.scenarioTimeoutMs,
    DEFAULT_SCENARIO_TIMEOUT_MS
  );
  const cleanupTimeoutMs = normalizeDuration(
    options.cleanupTimeoutMs,
    DEFAULT_CLEANUP_TIMEOUT_MS
  );

  const inheritedSecrets = SECRET_ENVIRONMENT_NAMES
    .map((name) => sourceEnvironment[name])
    .filter(Boolean);
  const sensitiveValues = [
    RESUME_FIXTURE,
    PREVIOUS_INTERVIEW_TOPIC_FIXTURE,
    DURABLE_NOTE_FIXTURE,
    CHAT_INPUT,
    ...inheritedSecrets,
    ...(Array.isArray(options.sensitiveValues) ? options.sensitiveValues : [])
  ];
  const scenarios = [];
  const cleanupErrors = [];

  let stateDirectory = null;
  let userDataDirectory = null;
  let fakeServer = null;
  let portReservation = null;
  let child = null;
  let childMonitor = null;
  let childOutputCapture = null;
  let cdp = null;
  let cleanupPromise = null;
  let interruptedError = null;
  let networkPolicyError = null;
  let networkReportPath = null;
  const abortController = new AbortController();

  let rejectInterruption;
  const interruption = new Promise((resolve, reject) => {
    rejectInterruption = reject;
    void resolve;
  });
  const signalListeners = new Map();

  function throwIfInterrupted() {
    if (interruptedError) {
      throw interruptedError;
    }
  }

  function reportPass(name) {
    const scenarioName = String(name);
    scenarios.push(scenarioName);
    logger.log(`PASS: ${scenarioName}`);
  }

  async function acquireResource(resourcePromise, releaseLate, timeoutMs, timeoutMessage) {
    try {
      return await withTimeout(
        Promise.race([resourcePromise, interruption]),
        timeoutMs,
        timeoutMessage
      );
    } catch (error) {
      Promise.resolve(resourcePromise)
        .then((resource) => releaseLate(resource))
        .catch(() => {});
      throw error;
    }
  }

  async function cleanupStep(label, action) {
    if (typeof action !== 'function') {
      return;
    }
    try {
      await withTimeout(
        Promise.resolve().then(action),
        cleanupTimeoutMs,
        `${label} cleanup timed out`
      );
    } catch (error) {
      cleanupErrors.push(
        sanitizeDiagnosticText(`${label}: ${error?.message || 'cleanup failed'}`, sensitiveValues)
      );
    }
  }

  function cleanup() {
    if (cleanupPromise) {
      return cleanupPromise;
    }

    cleanupPromise = (async () => {
      childMonitor?.stop();
      await cleanupStep('debugging port', () => portReservation?.release());
      portReservation = null;
      await cleanupStep('CDP', () => cdp?.close());
      cdp = null;
      await cleanupStep('Electron process', () => stopProcessTree(child));
      childOutputCapture?.stop();
      if (child && networkReportPath) {
        try {
          verifyNetworkPolicyReport(networkReportPath);
        } catch (error) {
          networkPolicyError = error;
        }
      }
      await cleanupStep('fake Portkey gateway', () => fakeServer?.close());
      fakeServer = null;
      await cleanupStep(
        'temporary user data',
        () => userDataDirectory && deleteDirectory(userDataDirectory)
      );
      userDataDirectory = null;
      await cleanupStep(
        'temporary app state',
        () => stateDirectory && deleteDirectory(stateDirectory)
      );
      stateDirectory = null;
    })();
    return cleanupPromise;
  }

  for (const signal of ['SIGINT', 'SIGTERM']) {
    const listener = () => {
      if (interruptedError) {
        return;
      }
      interruptedError = new Error(`Electron E2E interrupted by ${signal}`);
      abortController.abort();
      rejectInterruption(interruptedError);
    };
    signalListeners.set(signal, listener);
    addSignalListener(signalTarget, signal, listener);
  }

  let result = null;
  let failure = null;
  let domDiagnostics = null;

  try {
    const lifecycle = (async () => {
      stateDirectory = createTempDirectory('open-cluely-e2e-state-');
      userDataDirectory = createTempDirectory('open-cluely-e2e-user-data-');
      const envPath = createIsolatedEnvironmentFile(stateDirectory);
      networkReportPath = createNetworkPolicyReportFile(stateDirectory);
      throwIfInterrupted();

      const fakeServerPromise = Promise.resolve().then(() => (
        createFakePortkeyGateway({
          chunks: [...FAKE_CHUNKS],
          chunkDelayMs: normalizeDuration(
            options.fakeChunkDelayMs,
            DEFAULT_FAKE_CHUNK_DELAY_MS
          )
        })
      ));
      const startedFakeServer = await acquireResource(
        fakeServerPromise,
        (server) => server?.close?.(),
        startupTimeoutMs,
        `Fake Portkey gateway startup timed out after ${startupTimeoutMs}ms`
      );
      if (interruptedError) {
        await startedFakeServer.close().catch(() => {});
        throw interruptedError;
      }
      fakeServer = startedFakeServer;
      assertLoopbackFakeServer(fakeServer);
      seedAppState(stateDirectory, fakeServer.baseUrl);

      const reservePortPromise = Promise.resolve().then(() => reservePort());
      const reservedPort = await acquireResource(
        reservePortPromise,
        (reservation) => reservation?.release?.(),
        startupTimeoutMs,
        `Debugging port reservation timed out after ${startupTimeoutMs}ms`
      );
      if (interruptedError) {
        await reservedPort.release().catch(() => {});
        throw interruptedError;
      }
      portReservation = reservedPort;

      const launchEnvironment = buildLaunchEnvironment(
        sourceEnvironment,
        stateDirectory,
        envPath,
        networkReportPath
      );
      const electronArgs = buildElectronArgs({
        debuggingPort: portReservation.port,
        userDataDirectory,
        repoRoot
      });

      await portReservation.release();
      portReservation = null;
      throwIfInterrupted();

      child = spawn(electronBinary, electronArgs, {
        cwd: repoRoot,
        detached: process.platform !== 'win32',
        env: launchEnvironment,
        stdio: ['ignore', 'pipe', 'pipe']
      });
      if (!child || typeof child.once !== 'function') {
        throw new Error('Electron spawn did not return a child process');
      }
      childOutputCapture = createChildOutputCapture(child);
      childMonitor = monitorUnexpectedChildExit(child);

      const afterSpawn = (async () => {
        const page = await withTimeout(
          Promise.race([
            discoverRenderer({
              port: reservedPort.port,
              timeoutMs: startupTimeoutMs,
              signal: abortController.signal
            }),
            interruption
          ]),
          startupTimeoutMs + 1000,
          `Renderer discovery timed out after ${startupTimeoutMs}ms`
        );
        throwIfInterrupted();
        if (
          !page
          || typeof page.webSocketDebuggerUrl !== 'string'
          || !page.webSocketDebuggerUrl.startsWith('ws://127.0.0.1:')
        ) {
          throw new Error('Renderer discovery returned an invalid target');
        }

        const connectCdpPromise = Promise.resolve().then(() => (
          connectCdp(page.webSocketDebuggerUrl, {
            connectTimeoutMs: 5000,
            commandTimeoutMs: 5000,
            closeTimeoutMs: 1000
          })
        ));
        const connectedCdp = await acquireResource(
          connectCdpPromise,
          (client) => client?.close?.(),
          6000,
          'CDP connection timed out'
        );
        if (interruptedError) {
          await connectedCdp.close().catch(() => {});
          throw interruptedError;
        }
        cdp = connectedCdp;

        const scenariosPromise = Promise.resolve().then(() => executeScenarios({
          cdp,
          fakeServer,
          reportPass,
          startupTimeoutMs
        }));
        await withTimeout(
          Promise.race([scenariosPromise, interruption]),
          scenarioTimeoutMs,
          `E2E scenarios timed out after ${scenarioTimeoutMs}ms`
        );
        throwIfInterrupted();
        return { scenarios: [...scenarios] };
      })();

      return Promise.race([afterSpawn, childMonitor.promise]);
    })();

    result = await Promise.race([lifecycle, interruption]);
  } catch (error) {
    failure = error;
    if (!interruptedError) {
      domDiagnostics = await collectSafeDomDiagnostics(cdp);
    }
  } finally {
    await cleanup();
    for (const [signal, listener] of signalListeners) {
      removeSignalListener(signalTarget, signal, listener);
    }
  }

  if (interruptedError) {
    failure = interruptedError;
  } else if (!failure && cleanupErrors.length > 0) {
    failure = new Error('Electron E2E cleanup failed');
  } else if (networkPolicyError) {
    failure = networkPolicyError;
  }

  if (failure) {
    throw buildPublicFailure({
      error: failure,
      childOutput: childOutputCapture?.read() || '',
      domDiagnostics,
      cleanupErrors,
      sensitiveValues,
      suppressChildOutput: networkPolicyError?.code === 'OPEN_CLUELY_E2E_NETWORK_BLOCKED'
    });
  }

  return result;
}

if (require.main === module) {
  runElectronE2E().catch((error) => {
    console.error(`FAIL: ${sanitizeDiagnosticText(error?.message || error)}`);
    process.exitCode = 1;
  });
}

module.exports = {
  assertBackgroundMemoryEvidence,
  assertRequestHasActiveOutputFormat,
  assertStreamingCompletionEvidence,
  collectStreamingSnapshots,
  runElectronE2E,
  sendTypedChatInput,
  terminateProcessTree
};
