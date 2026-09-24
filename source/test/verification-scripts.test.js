'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const util = require('node:util');
const { spawnSync } = require('node:child_process');
const test = require('node:test');
const assert = require('node:assert/strict');

const REPO_ROOT = path.resolve(__dirname, '..');

function createFedoraSmokeFixture(t, { includeEnv = false } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'open-cluely-fedora-smoke-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  for (const directory of [
    'scripts',
    'src/platform',
    'assets',
    'node_modules/electron',
    'node_modules/screenshot-desktop'
  ]) {
    fs.mkdirSync(path.join(root, directory), { recursive: true });
  }

  fs.copyFileSync(
    path.join(REPO_ROOT, 'scripts', 'smoke-fedora.js'),
    path.join(root, 'scripts', 'smoke-fedora.js')
  );
  fs.copyFileSync(
    path.join(REPO_ROOT, 'src', 'platform', 'capabilities.js'),
    path.join(root, 'src', 'platform', 'capabilities.js')
  );
  fs.writeFileSync(path.join(root, 'package.json'), '{}\n', 'utf8');
  fs.writeFileSync(path.join(root, '.env.example'), '# fixture\n', 'utf8');
  fs.writeFileSync(path.join(root, 'assets', 'open-cluely.png'), '', 'utf8');
  if (includeEnv) {
    fs.writeFileSync(path.join(root, '.env'), '# fixture\n', 'utf8');
  }

  return root;
}

function runFedoraSmoke(root, args = []) {
  return spawnSync(
    process.execPath,
    [path.join(root, 'scripts', 'smoke-fedora.js'), ...args],
    {
      cwd: root,
      encoding: 'utf8',
      env: {
        PATH: process.env.PATH || '',
        OPEN_CLUELY_SESSION_TYPE: 'x11'
      }
    }
  );
}

function createBenchmarkFixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'open-cluely-benchmark-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  fs.mkdirSync(path.join(root, 'scripts'), { recursive: true });
  fs.mkdirSync(path.join(root, 'node_modules', 'portkey-ai'), { recursive: true });
  fs.copyFileSync(
    path.join(REPO_ROOT, 'scripts', 'benchmark-models.js'),
    path.join(root, 'scripts', 'benchmark-models.js')
  );
  fs.writeFileSync(
    path.join(root, 'node_modules', 'portkey-ai', 'index.js'),
    `'use strict';
module.exports = class FakePortkey {
  constructor(options) {
    this.chat = {
      completions: {
        create: async () => {
          throw new Error(\`provider rejected api_key=\${options.apiKey}\`);
        }
      }
    };
  }
};
`,
    'utf8'
  );

  return root;
}

function createCapturedSmokeOutput() {
  const calls = [];
  const capture = (...args) => {
    calls.push(args);
  };

  return {
    io: {
      log: capture,
      error: capture,
      write: capture
    },
    calls,
    text() {
      return util.inspect(calls, { depth: 8 });
    }
  };
}

function installEmptyRealSttCredentials(t) {
  const previousOpenai = process.env.OPENAI_API_KEY;
  const previousPortkey = process.env.PORTKEY_API_KEY;
  process.env.OPENAI_API_KEY = '';
  process.env.PORTKEY_API_KEY = '';
  t.after(() => {
    if (previousOpenai === undefined) {
      delete process.env.OPENAI_API_KEY;
    } else {
      process.env.OPENAI_API_KEY = previousOpenai;
    }
    if (previousPortkey === undefined) {
      delete process.env.PORTKEY_API_KEY;
    } else {
      process.env.PORTKEY_API_KEY = previousPortkey;
    }
  });
}

function createSmokeOptions({
  captured,
  start,
  stop = async () => ({ success: true }),
  dispose = () => {},
  setExitCode = () => {}
}) {
  return {
    env: {
      OPENAI_API_KEY: 'configured-openai-marker',
      PORTKEY_API_KEY: 'configured-portkey-marker'
    },
    io: captured.io,
    sleep: async () => {},
    setExitCode,
    createService: ({ sendToRenderer }) => ({
      start: () => start(sendToRenderer),
      handleAudioChunk: () => {},
      stop: (payload) => stop(sendToRenderer, payload),
      dispose
    })
  };
}

const SECRET_BEARING_ERROR = [
  'configured-openai-marker',
  'configured-portkey-marker',
  'sk-unconfigured-marker',
  'Bearer bearer-unconfigured-marker',
  'x-portkey-api-key=xpk-unconfigured-marker'
].join(' ');

function assertSmokeOutputIsSanitized(captured) {
  const output = captured.text();
  for (const secret of [
    'configured-openai-marker',
    'configured-portkey-marker',
    'sk-unconfigured-marker',
    'bearer-unconfigured-marker',
    'xpk-unconfigured-marker',
    'private transcript words',
    'private-stack-marker'
  ]) {
    assert.equal(output.includes(secret), false, `printed secret: ${secret}`);
  }
  assert.match(output, /\[REDACTED\]/);
  assert.equal(
    captured.calls.flat().every((value) => typeof value === 'string'),
    true,
    'smoke output must contain strings only'
  );
}

test('package verify invokes Fedora smoke in no-write mode', () => {
  const packageJson = JSON.parse(
    fs.readFileSync(path.join(REPO_ROOT, 'package.json'), 'utf8')
  );

  assert.match(
    packageJson.scripts.verify,
    /npm run smoke:fedora -- --no-write/
  );
});

test('Fedora smoke no-write mode neither reads nor requires the normal .env', (t) => {
  const root = createFedoraSmokeFixture(t);
  const result = runFedoraSmoke(root, ['--no-write']);

  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.equal(fs.existsSync(path.join(root, 'cache')), false);
  assert.doesNotMatch(result.stdout, /envExists|generatedAt|fedora-smoke-\d+\.json/);
  assert.match(result.stdout, /no-write/i);
});

test('standalone Fedora smoke still writes a useful timestamped report', (t) => {
  const root = createFedoraSmokeFixture(t, { includeEnv: true });
  const result = runFedoraSmoke(root);

  assert.equal(result.status, 0, result.stderr || result.stdout);
  const diagnosticsDir = path.join(root, 'cache', 'diagnostics');
  const reports = fs.readdirSync(diagnosticsDir);
  assert.equal(reports.length, 1);
  assert.match(reports[0], /^fedora-smoke-\d+\.json$/);

  const report = JSON.parse(
    fs.readFileSync(path.join(diagnosticsDir, reports[0]), 'utf8')
  );
  assert.match(report.generatedAt, /^\d{4}-\d{2}-\d{2}T/);
  assert.equal(report.checks.envExists, true);
  assert.equal(report.checks.packageJsonExists, true);
  assert.equal(report.checks.electronInstalled, true);
});

test('benchmark success requires at least one non-empty successful run', () => {
  const benchmarkPath = path.join(REPO_ROOT, 'scripts', 'benchmark-models.js');
  const probe = spawnSync(
    process.execPath,
    ['-e', `
      const { didBenchmarkSucceed } = require(${JSON.stringify(benchmarkPath)});
      const outcomes = [
        didBenchmarkSucceed([{ ok: true, outputChars: 12 }]),
        didBenchmarkSucceed([]),
        didBenchmarkSucceed([{ ok: false, outputChars: 12 }]),
        didBenchmarkSucceed([{ ok: true, outputChars: 0 }]),
        didBenchmarkSucceed([
          { ok: true, outputChars: 12 },
          { ok: false, outputChars: 0 }
        ])
      ];
      process.stdout.write(JSON.stringify(outcomes));
    `],
    {
      cwd: REPO_ROOT,
      encoding: 'utf8',
      env: {
        ...process.env,
        PORTKEY_API_KEY: ''
      }
    }
  );

  assert.equal(probe.status, 0, probe.stderr);
  assert.deepEqual(JSON.parse(probe.stdout), [true, false, false, false, false]);
});

test('failed benchmark exits nonzero after writing and printing a sanitized report', (t) => {
  const root = createBenchmarkFixture(t);
  const sensitiveMarker = 'unit-test-sensitive-marker';
  const result = spawnSync(
    process.execPath,
    [path.join(root, 'scripts', 'benchmark-models.js')],
    {
      cwd: root,
      encoding: 'utf8',
      env: {
        PATH: process.env.PATH || '',
        PORTKEY_API_KEY: sensitiveMarker,
        BENCHMARK_RUNS: '1'
      }
    }
  );

  assert.equal(result.status, 1);
  const reports = fs.readdirSync(path.join(root, 'cache', 'benchmarks'));
  assert.equal(reports.length, 1);
  const reportText = fs.readFileSync(
    path.join(root, 'cache', 'benchmarks', reports[0]),
    'utf8'
  );

  assert.equal(reportText.includes(sensitiveMarker), false);
  assert.equal(result.stdout.includes(sensitiveMarker), false);
  assert.equal(result.stderr.includes(sensitiveMarker), false);
  assert.match(reportText, /\[REDACTED\]/);
  assert.match(result.stdout, /"successCount": 0/);
  assert.match(result.stdout, /Wrote .+portkey-flash-\d+\.json/);
});

test('STT smoke requires session.updated, rejects errors, and formats only transcript metrics', () => {
  const smokePath = path.join(REPO_ROOT, 'scripts', 'smoke-stt.js');
  const probe = spawnSync(
    process.execPath,
    ['-e', `
      const {
        evaluateSttSmokeEvents,
        formatFinalTranscriptMetric
      } = require(${JSON.stringify(smokePath)});
      const updated = {
        channel: 'stt-debug',
        data: { event: 'session.updated' }
      };
      const transcript = 'private transcript words';
      const success = evaluateSttSmokeEvents([
        updated,
        { channel: 'vosk-final', data: { text: transcript } }
      ]);
      const formatted = formatFinalTranscriptMetric({
        source: 'mic',
        text: transcript
      });
      process.stdout.write(JSON.stringify({
        outcomes: [
          evaluateSttSmokeEvents([
            { channel: 'vosk-status', data: { status: 'loading' } }
          ]).ok,
          evaluateSttSmokeEvents([
            { channel: 'stt-debug', data: { event: 'session.created' } }
          ]).ok,
          evaluateSttSmokeEvents([updated]).ok,
          evaluateSttSmokeEvents([
            updated,
            { channel: 'vosk-error', data: { error: 'provider failed' } }
          ]).ok,
          evaluateSttSmokeEvents([
            updated,
            {
              channel: 'stt-debug',
              data: { level: 'error', event: 'provider-error' }
            }
          ]).ok
        ],
        success,
        formatted,
        privacySafe: !formatted.includes(transcript)
      }));
    `],
    {
      cwd: REPO_ROOT,
      encoding: 'utf8',
      env: {
        ...process.env,
        OPENAI_API_KEY: '',
        PORTKEY_API_KEY: ''
      }
    }
  );

  assert.equal(probe.status, 0, probe.stderr);
  const result = JSON.parse(probe.stdout);
  assert.deepEqual(result.outcomes, [false, false, true, false, false]);
  assert.deepEqual(result.success, {
    ok: true,
    eventCount: 2,
    sessionUpdated: true,
    errorCount: 0,
    finalEventCount: 1,
    finalCharacterCount: 24
  });
  assert.equal(result.privacySafe, true);
  assert.equal(result.formatted, 'vosk-final: events=1 chars=24');
});

test('STT smoke sanitizes provider errors without printing raw event objects', async (t) => {
  installEmptyRealSttCredentials(t);
  const { main } = require('../scripts/smoke-stt');
  const captured = createCapturedSmokeOutput();

  await main(createSmokeOptions({
    captured,
    start(sendToRenderer) {
      sendToRenderer('stt-debug', {
        level: 'info',
        event: 'session.updated'
      });
      sendToRenderer('vosk-error', {
        message: SECRET_BEARING_ERROR,
        text: 'private transcript words'
      });
      return { success: true, sampleRate: 24000 };
    }
  }));

  assertSmokeOutputIsSanitized(captured);
});

test('STT smoke sanitizes structured start failures', async (t) => {
  installEmptyRealSttCredentials(t);
  const { main } = require('../scripts/smoke-stt');
  const captured = createCapturedSmokeOutput();

  await main(createSmokeOptions({
    captured,
    start() {
      return {
        success: false,
        error: {
          message: SECRET_BEARING_ERROR,
          text: 'private transcript words'
        }
      };
    }
  }));

  assertSmokeOutputIsSanitized(captured);
});

test('STT smoke sanitizes top-level errors without printing stacks', async (t) => {
  installEmptyRealSttCredentials(t);
  const { runCli } = require('../scripts/smoke-stt');
  assert.equal(typeof runCli, 'function');
  const captured = createCapturedSmokeOutput();
  const error = new Error(SECRET_BEARING_ERROR);
  error.stack = `Error: private-stack-marker ${SECRET_BEARING_ERROR}`;
  error.text = 'private transcript words';

  await runCli(createSmokeOptions({
    captured,
    start() {
      throw error;
    }
  }));

  assertSmokeOutputIsSanitized(captured);
});

test('STT smoke waits for provider drain before evaluating events', async (t) => {
  installEmptyRealSttCredentials(t);
  const { main } = require('../scripts/smoke-stt');
  const captured = createCapturedSmokeOutput();
  let releaseStop;
  let stopCalled = false;
  let disposed = false;

  const running = main(createSmokeOptions({
    captured,
    start(sendToRenderer) {
      sendToRenderer('stt-debug', {
        level: 'info',
        event: 'session.updated'
      });
      return { success: true, sampleRate: 24000 };
    },
    stop(sendToRenderer) {
      stopCalled = true;
      return new Promise((resolve) => {
        releaseStop = () => {
          sendToRenderer('vosk-final', {
            source: 'mic',
            text: 'private transcript words'
          });
          resolve({ success: true });
        };
      });
    },
    dispose() {
      disposed = true;
    }
  }));

  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(stopCalled, true);
  assert.equal(disposed, false);
  assert.equal(captured.text().includes('smoke-stt: events='), false);

  releaseStop();
  await running;
  assert.equal(disposed, true);
  assert.match(captured.text(), /finalEvents=1/);
  assert.equal(captured.text().includes('private transcript words'), false);
});

test('STT smoke fails when the provider drain times out', async (t) => {
  installEmptyRealSttCredentials(t);
  const { main } = require('../scripts/smoke-stt');
  const captured = createCapturedSmokeOutput();
  const exitCodes = [];
  let disposed = false;

  await main(createSmokeOptions({
    captured,
    start(sendToRenderer) {
      sendToRenderer('stt-debug', {
        level: 'info',
        event: 'session.updated'
      });
      return { success: true, sampleRate: 24000 };
    },
    async stop() {
      return {
        success: false,
        error: 'Timed out waiting for final transcription results'
      };
    },
    dispose() {
      disposed = true;
    },
    setExitCode(code) {
      exitCodes.push(code);
    }
  }));

  assert.equal(disposed, true);
  assert.deepEqual(exitCodes, [1]);
  assert.match(captured.text(), /smoke-stt: stop failed:/);
  assert.doesNotMatch(captured.text(), /smoke-stt: ok/);
});
