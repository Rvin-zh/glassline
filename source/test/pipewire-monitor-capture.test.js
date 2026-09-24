'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const {
  createPipeWireMonitorCapture,
  isValidMonitorSource,
  resolveMonitorSource
} = require('../src/services/stt/pipewire-monitor-capture');
const { registerSttIpc } = require('../src/services/stt/ipc');
const { createInvokeActions } = require('../src/windows/assistant/preload/actions');

const DEFAULT_SINK = 'alsa_output.pci-0000_00_1f.3.analog-stereo';
const DEFAULT_MONITOR = `${DEFAULT_SINK}.monitor`;
const FALLBACK_MONITOR = 'bluez_output.00_11_22_33_44_55.1.monitor';

function nextTurn() {
  return new Promise((resolve) => setImmediate(resolve));
}

function createPactlExecFile({
  defaultSink = DEFAULT_SINK,
  sources = [
    `41\tunrelated_input\tPipeWire\ts16le 1ch 48000Hz\tRUNNING`,
    `42\t${DEFAULT_MONITOR}\tPipeWire\ts16le 2ch 48000Hz\tIDLE`,
    `43\t${FALLBACK_MONITOR}\tPipeWire\ts16le 2ch 48000Hz\tSUSPENDED`
  ].join('\n'),
  errorFor = null
} = {}) {
  const calls = [];
  const execFile = (file, args, options, callback) => {
    calls.push({ file, args, options });
    queueMicrotask(() => {
      if (typeof errorFor === 'function' && errorFor(args)) {
        callback(Object.assign(new Error('private pactl failure details'), {
          code: 'ENOENT'
        }), '', '');
        return;
      }
      const stdout = args[0] === 'get-default-sink'
        ? `${defaultSink}\n`
        : `${sources}\n`;
      callback(null, stdout, '');
    });
    return { kill() {} };
  };
  return { calls, execFile };
}

class FakeStdout extends EventEmitter {
  constructor() {
    super();
    this.pauseCalls = 0;
    this.resumeCalls = 0;
  }

  pause() {
    this.pauseCalls += 1;
  }

  resume() {
    this.resumeCalls += 1;
  }
}

class FakeChild extends EventEmitter {
  constructor({ exitOnTerm = true } = {}) {
    super();
    this.stdout = new FakeStdout();
    this.exitCode = null;
    this.signalCode = null;
    this.killSignals = [];
    this.exitOnTerm = exitOnTerm;
  }

  kill(signal) {
    this.killSignals.push(signal);
    if (signal === 'SIGTERM' && this.exitOnTerm) {
      queueMicrotask(() => this.emitExit(null, 'SIGTERM'));
    }
    return true;
  }

  emitExit(code = 0, signal = null) {
    this.exitCode = code;
    this.signalCode = signal;
    this.emit('exit', code, signal);
  }
}

function createSpawn(child, {
  earlyError = null,
  earlyExit = false
} = {}) {
  const calls = [];
  const spawn = (file, args, options) => {
    calls.push({ file, args, options });
    queueMicrotask(() => {
      if (earlyError) {
        child.emit('error', earlyError);
      } else if (earlyExit) {
        child.emitExit(1, null);
      } else {
        child.emit('spawn');
      }
    });
    return child;
  };
  return { calls, spawn };
}

function createCapture({
  child = new FakeChild(),
  execFile,
  spawn,
  sttService = { handleAudioChunk() {} },
  setTimeout: setTimer,
  clearTimeout: clearTimer,
  startupGraceMs = 0
} = {}) {
  const pactl = execFile
    ? { execFile, calls: [] }
    : createPactlExecFile();
  const parec = spawn
    ? { spawn, calls: [] }
    : createSpawn(child);

  const capture = createPipeWireMonitorCapture({
    sttService,
    execFile: pactl.execFile,
    spawn: parec.spawn,
    setTimeout: setTimer,
    clearTimeout: clearTimer,
    startupGraceMs,
    stopTimeoutMs: 25,
    killTimeoutMs: 10
  });

  return {
    capture,
    child,
    execFileCalls: pactl.calls,
    spawnCalls: parec.calls
  };
}

describe('PipeWire monitor source resolution', () => {
  it('prefers the default sink monitor and invokes pactl without a shell', async () => {
    const pactl = createPactlExecFile();

    const selected = await resolveMonitorSource({
      execFile: pactl.execFile,
      timeoutMs: 25
    });

    assert.equal(selected, DEFAULT_MONITOR);
    assert.deepEqual(
      pactl.calls.map(({ file, args }) => ({ file, args })),
      [
        { file: 'pactl', args: ['get-default-sink'] },
        { file: 'pactl', args: ['list', 'short', 'sources'] }
      ]
    );
    assert.equal(pactl.calls.every(({ options }) => options.shell === false), true);
  });

  it('falls back to the first valid monitor source when the default is absent', async () => {
    const pactl = createPactlExecFile({
      defaultSink: 'missing.default.sink',
      sources: [
        '11\tordinary_input\tPipeWire\ts16le 1ch 48000Hz\tRUNNING',
        `12\t${FALLBACK_MONITOR}\tPipeWire\ts16le 2ch 48000Hz\tIDLE`,
        `13\t${DEFAULT_MONITOR}\tPipeWire\ts16le 2ch 48000Hz\tSUSPENDED`
      ].join('\n')
    });

    assert.equal(
      await resolveMonitorSource({ execFile: pactl.execFile }),
      FALLBACK_MONITOR
    );
  });

  it('rejects malformed and non-monitor source names', () => {
    assert.equal(isValidMonitorSource(DEFAULT_MONITOR), true);
    assert.equal(isValidMonitorSource('ordinary_input'), false);
    assert.equal(isValidMonitorSource('valid.monitor;touch /tmp/private'), false);
    assert.equal(isValidMonitorSource('valid.monitor\nother.monitor'), false);
  });
});

describe('PipeWire monitor capture process', () => {
  for (const sampleRate of [16000, 24000]) {
    it(`spawns parec safely with dynamic ${sampleRate} Hz PCM arguments`, async () => {
      const { capture, child, spawnCalls } = createCapture();

      const result = await capture.start(sampleRate);

      assert.deepEqual(result, {
        success: true,
        backend: 'pipewire-monitor',
        sampleRate,
        sourceConfigured: true
      });
      assert.equal(spawnCalls.length, 1);
      assert.equal(spawnCalls[0].file, 'parec');
      assert.deepEqual(spawnCalls[0].args, [
        `--device=${DEFAULT_MONITOR}`,
        '--format=s16le',
        `--rate=${sampleRate}`,
        '--channels=1',
        '--raw'
      ]);
      assert.equal(spawnCalls[0].options.shell, false);
      assert.deepEqual(spawnCalls[0].options.stdio, ['ignore', 'pipe', 'ignore']);
      assert.equal(JSON.stringify(result).includes(DEFAULT_MONITOR), false);

      await capture.stop();
      assert.deepEqual(child.killSignals, ['SIGTERM']);
    });
  }

  it('forwards one Buffer at a time and pauses stdout for async backpressure', async () => {
    let releaseForward;
    const pendingForward = new Promise((resolve) => {
      releaseForward = resolve;
    });
    const forwarded = [];
    const { capture, child } = createCapture({
      sttService: {
        handleAudioChunk(payload) {
          forwarded.push(payload);
          return pendingForward;
        }
      }
    });
    await capture.start(24000);
    const audio = Buffer.from([0x01, 0x02, 0x03, 0x04]);

    child.stdout.emit('data', audio);

    assert.equal(child.stdout.pauseCalls, 1);
    assert.equal(child.stdout.resumeCalls, 0);
    assert.equal(forwarded.length, 1);
    assert.equal(forwarded[0].source, 'system');
    assert.equal(forwarded[0].data, audio);
    assert.deepEqual(capture.getDiagnostics(), {
      backend: 'pipewire-monitor',
      status: 'listening',
      chunkCount: 1,
      sampleRate: 24000,
      sourceConfigured: true,
      processActive: true,
      lastError: null
    });
    assert.equal(JSON.stringify(capture.getDiagnostics()).includes(DEFAULT_MONITOR), false);
    assert.equal(Object.hasOwn(capture.getDiagnostics(), 'data'), false);

    releaseForward();
    await nextTurn();
    assert.equal(child.stdout.resumeCalls, 1);
    await capture.stop();
  });

  it('coalesces concurrent and repeated starts onto one owned process', async () => {
    const { capture, spawnCalls } = createCapture();

    const [first, second, third] = await Promise.all([
      capture.start(16000),
      capture.start(16000),
      capture.start(16000)
    ]);

    assert.equal(first.success, true);
    assert.deepEqual(second, first);
    assert.deepEqual(third, first);
    assert.equal(spawnCalls.length, 1);
    assert.deepEqual(await capture.start(16000), first);
    assert.equal(spawnCalls.length, 1);
    await capture.stop();
  });

  it('returns a sanitized failure when parec fails before startup', async () => {
    const child = new FakeChild();
    const privateMarker = `${DEFAULT_MONITOR}/private-user-path`;
    const parec = createSpawn(child, {
      earlyError: Object.assign(new Error(privateMarker), { code: 'ENOENT' })
    });
    const { capture } = createCapture({
      child,
      spawn: parec.spawn
    });

    const result = await capture.start(16000);

    assert.equal(result.success, false);
    assert.equal(result.backend, 'pipewire-monitor');
    assert.equal(result.sourceConfigured, true);
    assert.match(result.error, /capture.*unavailable/i);
    assert.doesNotMatch(JSON.stringify(result), /private-user-path|alsa_output/);
    assert.equal(capture.getDiagnostics().status, 'error');
    assert.equal(capture.getDiagnostics().processActive, false);
    await capture.stop();
  });

  it('treats a spawned process that exits during readiness as an early failure', async () => {
    const child = new FakeChild();
    const calls = [];
    const spawn = (file, args, options) => {
      calls.push({ file, args, options });
      queueMicrotask(() => {
        child.emit('spawn');
        queueMicrotask(() => child.emitExit(1));
      });
      return child;
    };
    const { capture } = createCapture({
      child,
      spawn,
      startupGraceMs: 20
    });

    const result = await capture.start(16000);

    assert.equal(calls.length, 1);
    assert.equal(result.success, false);
    assert.equal(result.code, 'CAPTURE_EARLY_EXIT');
    assert.match(result.error, /stopped before it became ready/i);
    assert.equal(capture.getDiagnostics().status, 'error');
    assert.equal(capture.getDiagnostics().processActive, false);
  });

  it('handles an exit before startup without leaving a duplicate-process guard', async () => {
    const firstChild = new FakeChild();
    const secondChild = new FakeChild();
    const spawnCalls = [];
    let nextChild = firstChild;
    const spawn = (file, args, options) => {
      const child = nextChild;
      spawnCalls.push({ file, args, options, child });
      queueMicrotask(() => {
        if (child === firstChild) {
          child.emitExit(1);
        } else {
          child.emit('spawn');
        }
      });
      return child;
    };
    const { capture } = createCapture({ child: firstChild, spawn });

    const failed = await capture.start(16000);
    nextChild = secondChild;
    const recovered = await capture.start(16000);

    assert.equal(failed.success, false);
    assert.equal(recovered.success, true);
    assert.equal(spawnCalls.length, 2);
    await capture.stop();
  });

  it('does not report readiness after stop begins during startup', async () => {
    const timers = [];
    const setTimer = (callback, delay) => {
      const timer = { callback, delay, cleared: false };
      timers.push(timer);
      return timer;
    };
    const clearTimer = (timer) => {
      timer.cleared = true;
    };
    const child = new FakeChild({ exitOnTerm: false });
    const { capture } = createCapture({
      child,
      setTimeout: setTimer,
      clearTimeout: clearTimer,
      startupGraceMs: 20
    });

    const starting = capture.start(16000);
    await nextTurn();
    assert.equal(timers[0].delay, 20);

    const stopping = capture.stop();
    assert.deepEqual(child.killSignals, ['SIGTERM']);
    assert.equal(timers[1].delay, 25);

    timers[0].callback();
    timers[1].callback();
    assert.deepEqual(child.killSignals, ['SIGTERM', 'SIGKILL']);
    child.emitExit(null, 'SIGKILL');

    assert.equal((await starting).success, false);
    assert.deepEqual(await stopping, {
      success: true,
      backend: 'pipewire-monitor'
    });
  });

  it('makes stop/dispose idempotent and TERM/KILLs only its owned child', async () => {
    const timers = [];
    const setTimer = (callback, delay) => {
      const timer = { callback, delay, cleared: false };
      timers.push(timer);
      return timer;
    };
    const clearTimer = (timer) => {
      timer.cleared = true;
    };
    const child = new FakeChild({ exitOnTerm: false });
    const unrelatedChild = new FakeChild({ exitOnTerm: false });
    const { capture } = createCapture({
      child,
      setTimeout: setTimer,
      clearTimeout: clearTimer
    });
    await capture.start(16000);

    const firstStop = capture.stop();
    const secondStop = capture.stop();
    assert.deepEqual(child.killSignals, ['SIGTERM']);
    assert.deepEqual(unrelatedChild.killSignals, []);
    assert.equal(timers[0].delay, 25);

    timers[0].callback();
    assert.deepEqual(child.killSignals, ['SIGTERM', 'SIGKILL']);
    assert.deepEqual(unrelatedChild.killSignals, []);
    child.emitExit(null, 'SIGKILL');

    assert.deepEqual(await firstStop, { success: true, backend: 'pipewire-monitor' });
    assert.deepEqual(await secondStop, { success: true, backend: 'pipewire-monitor' });
    assert.deepEqual(await capture.stop(), { success: true, backend: 'pipewire-monitor' });
    assert.deepEqual(child.killSignals, ['SIGTERM', 'SIGKILL']);
    assert.deepEqual(await capture.dispose(), { success: true, backend: 'pipewire-monitor' });
    assert.deepEqual(await capture.dispose(), { success: true, backend: 'pipewire-monitor' });
    assert.deepEqual(unrelatedChild.killSignals, []);
  });
});

describe('PipeWire monitor IPC and preload', () => {
  it('starts capture at the active STT rate and registers a symmetric stop handler', async () => {
    const handlers = new Map();
    const starts = [];
    let stops = 0;
    registerSttIpc({
      ipcMain: {
        handle(channel, handler) {
          handlers.set(channel, handler);
        },
        on() {}
      },
      sttService: {
        getSampleRate: () => 24000,
        getActiveProviderId: () => 'openai',
        emitSttDebug() {},
        start: () => ({ success: true }),
        stop: () => ({ success: true }),
        handleAudioChunk() {},
        getDesktopSources: async () => [],
        transcribeAudio: async () => ({ success: true })
      },
      pipewireMonitorCapture: {
        start(sampleRate) {
          starts.push(sampleRate);
          return {
            success: true,
            backend: 'pipewire-monitor',
            sampleRate,
            sourceConfigured: true
          };
        },
        stop() {
          stops += 1;
          return { success: true, backend: 'pipewire-monitor' };
        }
      },
      platform: 'linux'
    });

    assert.deepEqual(
      await handlers.get('start-pipewire-monitor-capture')(),
      {
        success: true,
        backend: 'pipewire-monitor',
        sampleRate: 24000,
        sourceConfigured: true
      }
    );
    assert.deepEqual(starts, [24000]);
    assert.deepEqual(
      await handlers.get('stop-pipewire-monitor-capture')(),
      { success: true, backend: 'pipewire-monitor' }
    );
    assert.equal(stops, 1);
  });

  it('exposes direct capture actions through invoke-only preload channels', async () => {
    const calls = [];
    const actions = createInvokeActions({
      invoke(channel, ...args) {
        calls.push({ channel, args });
        return Promise.resolve({ success: true });
      },
      send() {}
    });

    await actions.startPipeWireMonitorCapture();
    await actions.stopPipeWireMonitorCapture();

    assert.deepEqual(calls, [
      { channel: 'start-pipewire-monitor-capture', args: [] },
      { channel: 'stop-pipewire-monitor-capture', args: [] }
    ]);
  });

  it('wires capture lifecycle and sanitized diagnostics into application startup', () => {
    const startApplication = fs.readFileSync(path.join(
      __dirname,
      '..',
      'src',
      'main-process',
      'start-application.js'
    ), 'utf8');
    const settingsManager = fs.readFileSync(path.join(
      __dirname,
      '..',
      'src',
      'windows',
      'assistant',
      'renderer',
      'features',
      'settings',
      'settings-panel-manager.js'
    ), 'utf8');

    assert.match(startApplication, /createPipeWireMonitorCapture/);
    assert.match(startApplication, /pipewireMonitorCapture\.dispose\(\)/);
    assert.match(
      startApplication,
      /registerSttIpc\(\{\s*ipcMain,\s*sttService,\s*pipewireMonitorCapture\s*\}\)/
    );
    assert.match(startApplication, /hostAudioCapture:\s*pipewireMonitorCapture\.getDiagnostics\(\)/);
    assert.match(settingsManager, /hostAudioCapture:\s*result\?\.hostAudioCapture/);
  });
});
