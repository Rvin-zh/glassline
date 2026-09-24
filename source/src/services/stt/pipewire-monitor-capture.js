'use strict';

const {
  execFile: defaultExecFile,
  spawn: defaultSpawn
} = require('node:child_process');

const BACKEND = 'pipewire-monitor';
const DEFAULT_COMMAND_TIMEOUT_MS = 2000;
const DEFAULT_STARTUP_GRACE_MS = 75;
const DEFAULT_STOP_TIMEOUT_MS = 500;
const DEFAULT_KILL_TIMEOUT_MS = 250;
const MAX_PACTL_OUTPUT_BYTES = 256 * 1024;
const MIN_SAMPLE_RATE = 8000;
const MAX_SAMPLE_RATE = 192000;
const MAX_SOURCE_NAME_LENGTH = 512;
const PULSE_NAME_PATTERN = /^[A-Za-z0-9_.:+@-]+$/;
const MONITOR_NAME_PATTERN = /^[A-Za-z0-9_.:+@-]+\.monitor$/;

function createCaptureError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function isValidPulseName(value) {
  return (
    typeof value === 'string'
    && value.length > 0
    && value.length <= MAX_SOURCE_NAME_LENGTH
    && PULSE_NAME_PATTERN.test(value)
  );
}

function isValidMonitorSource(value) {
  return (
    typeof value === 'string'
    && value.length > '.monitor'.length
    && value.length <= MAX_SOURCE_NAME_LENGTH
    && MONITOR_NAME_PATTERN.test(value)
  );
}

function parseMonitorSources(output) {
  return String(output || '')
    .split(/\r?\n/)
    .map((line) => line.trim().split(/\s+/)[1] || '')
    .filter(isValidMonitorSource);
}

function runPactl(execFile, args, timeoutMs) {
  return new Promise((resolve, reject) => {
    try {
      execFile(
        'pactl',
        args,
        {
          encoding: 'utf8',
          timeout: timeoutMs,
          killSignal: 'SIGKILL',
          maxBuffer: MAX_PACTL_OUTPUT_BYTES,
          windowsHide: true,
          shell: false
        },
        (error, stdout) => {
          if (error) {
            reject(createCaptureError(
              'PACTL_UNAVAILABLE',
              'PipeWire/Pulse monitor discovery is unavailable.'
            ));
            return;
          }
          resolve(String(stdout || ''));
        }
      );
    } catch (_) {
      reject(createCaptureError(
        'PACTL_UNAVAILABLE',
        'PipeWire/Pulse monitor discovery is unavailable.'
      ));
    }
  });
}

async function resolveMonitorSource({
  execFile = defaultExecFile,
  timeoutMs = DEFAULT_COMMAND_TIMEOUT_MS
} = {}) {
  let defaultSink = '';
  try {
    defaultSink = (await runPactl(
      execFile,
      ['get-default-sink'],
      timeoutMs
    )).trim();
  } catch (_) {
    // A usable monitor can still be selected from the source list.
  }

  let sourceOutput;
  try {
    sourceOutput = await runPactl(
      execFile,
      ['list', 'short', 'sources'],
      timeoutMs
    );
  } catch (_) {
    throw createCaptureError(
      'MONITOR_SOURCE_UNAVAILABLE',
      'No PipeWire/Pulse monitor source is available.'
    );
  }

  const monitorSources = parseMonitorSources(sourceOutput);
  const preferredMonitor = isValidPulseName(defaultSink)
    ? `${defaultSink}.monitor`
    : '';

  if (
    isValidMonitorSource(preferredMonitor)
    && monitorSources.includes(preferredMonitor)
  ) {
    return preferredMonitor;
  }

  if (monitorSources.length > 0) {
    return monitorSources[0];
  }

  throw createCaptureError(
    'MONITOR_SOURCE_UNAVAILABLE',
    'No PipeWire/Pulse monitor source is available.'
  );
}

function normalizeSampleRate(value) {
  const sampleRate = Number.parseInt(String(value ?? ''), 10);
  if (
    !Number.isFinite(sampleRate)
    || sampleRate < MIN_SAMPLE_RATE
    || sampleRate > MAX_SAMPLE_RATE
  ) {
    throw createCaptureError(
      'INVALID_SAMPLE_RATE',
      'The host audio sample rate is invalid.'
    );
  }
  return sampleRate;
}

function sanitizeProcessFailure(error, fallbackCode = 'CAPTURE_START_FAILED') {
  if (error?.code === 'ENOENT') {
    return {
      code: 'PAREC_UNAVAILABLE',
      message: 'PipeWire/Pulse monitor capture is unavailable.'
    };
  }

  return {
    code: fallbackCode,
    message: fallbackCode === 'CAPTURE_EARLY_EXIT'
      ? 'PipeWire/Pulse monitor capture stopped before it became ready.'
      : 'PipeWire/Pulse monitor capture could not be started.'
  };
}

function createPipeWireMonitorCapture({
  sttService,
  execFile = defaultExecFile,
  spawn = defaultSpawn,
  setTimeout: setTimer = setTimeout,
  clearTimeout: clearTimer = clearTimeout,
  commandTimeoutMs = DEFAULT_COMMAND_TIMEOUT_MS,
  startupGraceMs = DEFAULT_STARTUP_GRACE_MS,
  stopTimeoutMs = DEFAULT_STOP_TIMEOUT_MS,
  killTimeoutMs = DEFAULT_KILL_TIMEOUT_MS
} = {}) {
  if (!sttService || typeof sttService.handleAudioChunk !== 'function') {
    throw new TypeError('sttService.handleAudioChunk is required');
  }

  let ownedLifecycle = null;
  let startPromise = null;
  let stopPromise = null;
  let disposed = false;
  let operationGeneration = 0;
  let status = 'idle';
  let chunkCount = 0;
  let activeSampleRate = null;
  let sourceConfigured = false;
  let selectedSource = null;
  let lastError = null;

  function resultSuccess(sampleRate = activeSampleRate) {
    return {
      success: true,
      backend: BACKEND,
      ...(sampleRate ? { sampleRate } : {}),
      ...(sampleRate ? { sourceConfigured: true } : {})
    };
  }

  function stopSuccess() {
    return {
      success: true,
      backend: BACKEND
    };
  }

  function resultFailure({
    code,
    message,
    sampleRate = activeSampleRate,
    configured = sourceConfigured
  }) {
    return {
      success: false,
      backend: BACKEND,
      ...(sampleRate ? { sampleRate } : {}),
      sourceConfigured: Boolean(configured),
      code,
      error: message
    };
  }

  function setFailure(code, message) {
    status = 'error';
    lastError = { code, message };
  }

  function isCurrentLifecycle(lifecycle) {
    return ownedLifecycle === lifecycle && !lifecycle.ended;
  }

  function detachLifecycle(lifecycle) {
    const { child, stdout } = lifecycle;
    try {
      stdout?.removeListener('data', lifecycle.onData);
    } catch (_) {}
    if (lifecycle.startupTimer) {
      clearTimer(lifecycle.startupTimer);
      lifecycle.startupTimer = null;
    }
    try {
      child.removeListener('spawn', lifecycle.onSpawn);
      child.removeListener('error', lifecycle.onError);
      child.removeListener('exit', lifecycle.onExit);
    } catch (_) {}
  }

  function finishLifecycle(lifecycle, {
    error = null,
    earlyExit = false
  } = {}) {
    if (lifecycle.ended) {
      return;
    }

    lifecycle.ended = true;
    lifecycle.acceptingAudio = false;
    try {
      lifecycle.stdout?.pause();
    } catch (_) {}
    detachLifecycle(lifecycle);

    if (ownedLifecycle === lifecycle) {
      ownedLifecycle = null;
    }

    for (const resolve of lifecycle.endWaiters) {
      resolve(true);
    }
    lifecycle.endWaiters.clear();

    if (!lifecycle.startSettled) {
      const sanitized = sanitizeProcessFailure(
        error,
        earlyExit ? 'CAPTURE_EARLY_EXIT' : 'CAPTURE_START_FAILED'
      );
      setFailure(sanitized.code, sanitized.message);
      lifecycle.startSettled = true;
      lifecycle.resolveStart(resultFailure({
        code: sanitized.code,
        message: sanitized.message,
        sampleRate: lifecycle.sampleRate,
        configured: true
      }));
      return;
    }

    if (status !== 'stopping' && !disposed) {
      setFailure(
        'CAPTURE_UNEXPECTED_EXIT',
        'PipeWire/Pulse monitor capture stopped unexpectedly.'
      );
    }
  }

  function stopAfterForwardFailure(lifecycle) {
    if (!isCurrentLifecycle(lifecycle)) {
      return;
    }
    setFailure(
      'AUDIO_FORWARD_FAILED',
      'Host audio forwarding failed.'
    );
    stop().then(() => {
      if (!disposed) {
        setFailure(
          'AUDIO_FORWARD_FAILED',
          'Host audio forwarding failed.'
        );
      }
    }).catch(() => {});
  }

  function markLifecycleReady(lifecycle) {
    if (
      lifecycle.ended
      || lifecycle.startSettled
      || !isCurrentLifecycle(lifecycle)
      || status !== 'starting'
    ) {
      return;
    }

    if (lifecycle.startupTimer) {
      clearTimer(lifecycle.startupTimer);
      lifecycle.startupTimer = null;
    }
    lifecycle.acceptingAudio = true;
    lifecycle.startSettled = true;
    status = 'listening';
    lastError = null;
    lifecycle.resolveStart(resultSuccess(lifecycle.sampleRate));
  }

  function forwardAudioChunk(lifecycle, data) {
    if (
      isCurrentLifecycle(lifecycle)
      && lifecycle.spawned
      && !lifecycle.startSettled
    ) {
      markLifecycleReady(lifecycle);
    }

    if (
      !isCurrentLifecycle(lifecycle)
      || !lifecycle.acceptingAudio
      || status !== 'listening'
    ) {
      return;
    }

    const audio = Buffer.isBuffer(data) ? data : Buffer.from(data || []);
    if (audio.length === 0) {
      return;
    }

    lifecycle.acceptingAudio = false;
    try {
      lifecycle.stdout.pause();
    } catch (_) {}

    chunkCount += 1;
    let forwarding;
    try {
      forwarding = sttService.handleAudioChunk({
        source: 'system',
        data: audio
      });
    } catch (_) {
      stopAfterForwardFailure(lifecycle);
      return;
    }

    Promise.resolve(forwarding).then(() => {
      if (!isCurrentLifecycle(lifecycle) || status !== 'listening') {
        return;
      }
      lifecycle.acceptingAudio = true;
      try {
        lifecycle.stdout.resume();
      } catch (_) {}
    }).catch(() => {
      stopAfterForwardFailure(lifecycle);
    });
  }

  function createLifecycle(child, sampleRate) {
    const lifecycle = {
      child,
      stdout: child.stdout,
      sampleRate,
      acceptingAudio: false,
      spawned: false,
      ended: false,
      startSettled: false,
      resolveStart: null,
      endWaiters: new Set(),
      startupTimer: null,
      onData: null,
      onSpawn: null,
      onError: null,
      onExit: null
    };

    lifecycle.onData = (data) => forwardAudioChunk(lifecycle, data);
    lifecycle.onSpawn = () => {
      if (lifecycle.ended || lifecycle.startSettled) {
        return;
      }
      lifecycle.spawned = true;
      if (startupGraceMs <= 0) {
        markLifecycleReady(lifecycle);
        return;
      }
      lifecycle.startupTimer = setTimer(() => {
        lifecycle.startupTimer = null;
        markLifecycleReady(lifecycle);
      }, startupGraceMs);
    };
    lifecycle.onError = (error) => {
      finishLifecycle(lifecycle, {
        error,
        earlyExit: !lifecycle.startSettled
      });
    };
    lifecycle.onExit = () => {
      finishLifecycle(lifecycle, { earlyExit: !lifecycle.startSettled });
    };

    return lifecycle;
  }

  async function performStart(sampleRate, generation) {
    let monitorSource;
    try {
      monitorSource = await resolveMonitorSource({
        execFile,
        timeoutMs: commandTimeoutMs
      });
    } catch (_) {
      if (generation !== operationGeneration || disposed) {
        return resultFailure({
          code: 'CAPTURE_START_CANCELLED',
          message: 'PipeWire/Pulse monitor capture start was cancelled.',
          sampleRate,
          configured: false
        });
      }
      setFailure(
        'MONITOR_SOURCE_UNAVAILABLE',
        'No PipeWire/Pulse monitor source is available.'
      );
      sourceConfigured = false;
      return resultFailure({
        code: 'MONITOR_SOURCE_UNAVAILABLE',
        message: 'No PipeWire/Pulse monitor source is available.',
        sampleRate,
        configured: false
      });
    }

    if (
      generation !== operationGeneration
      || disposed
      || !isValidMonitorSource(monitorSource)
    ) {
      return resultFailure({
        code: 'CAPTURE_START_CANCELLED',
        message: 'PipeWire/Pulse monitor capture start was cancelled.',
        sampleRate,
        configured: false
      });
    }

    selectedSource = monitorSource;
    sourceConfigured = true;

    let child;
    try {
      child = spawn(
        'parec',
        [
          `--device=${monitorSource}`,
          '--format=s16le',
          `--rate=${sampleRate}`,
          '--channels=1',
          '--raw'
        ],
        {
          stdio: ['ignore', 'pipe', 'ignore'],
          windowsHide: true,
          shell: false
        }
      );
    } catch (error) {
      const sanitized = sanitizeProcessFailure(error);
      setFailure(sanitized.code, sanitized.message);
      return resultFailure({
        code: sanitized.code,
        message: sanitized.message,
        sampleRate,
        configured: true
      });
    }

    if (
      !child
      || typeof child.on !== 'function'
      || !child.stdout
      || typeof child.stdout.on !== 'function'
    ) {
      setFailure(
        'CAPTURE_START_FAILED',
        'PipeWire/Pulse monitor capture could not be started.'
      );
      return resultFailure({
        code: 'CAPTURE_START_FAILED',
        message: 'PipeWire/Pulse monitor capture could not be started.',
        sampleRate,
        configured: true
      });
    }

    const lifecycle = createLifecycle(child, sampleRate);
    ownedLifecycle = lifecycle;
    child.on('spawn', lifecycle.onSpawn);
    child.on('error', lifecycle.onError);
    child.on('exit', lifecycle.onExit);
    lifecycle.stdout.on('data', lifecycle.onData);

    return new Promise((resolve) => {
      lifecycle.resolveStart = resolve;

      if (generation !== operationGeneration || disposed) {
        status = 'stopping';
        try {
          child.kill('SIGTERM');
        } catch (_) {}
      }
    });
  }

  function start(sampleRateValue) {
    let sampleRate;
    try {
      sampleRate = normalizeSampleRate(sampleRateValue);
    } catch (error) {
      return Promise.resolve(resultFailure({
        code: error.code,
        message: error.message,
        configured: false
      }));
    }

    if (disposed) {
      return Promise.resolve(resultFailure({
        code: 'CAPTURE_DISPOSED',
        message: 'PipeWire/Pulse monitor capture has been disposed.',
        sampleRate,
        configured: false
      }));
    }

    if (ownedLifecycle && !ownedLifecycle.ended && ownedLifecycle.spawned) {
      return Promise.resolve(resultSuccess(activeSampleRate));
    }

    if (startPromise) {
      return startPromise;
    }

    if (stopPromise) {
      return stopPromise.then(() => start(sampleRate));
    }

    const generation = ++operationGeneration;
    status = 'starting';
    chunkCount = 0;
    activeSampleRate = sampleRate;
    sourceConfigured = false;
    selectedSource = null;
    lastError = null;

    const operation = performStart(sampleRate, generation);
    let trackedPromise;
    trackedPromise = operation.then(
      (result) => {
        if (startPromise === trackedPromise) {
          startPromise = null;
        }
        return result;
      },
      () => {
        if (startPromise === trackedPromise) {
          startPromise = null;
        }
        setFailure(
          'CAPTURE_START_FAILED',
          'PipeWire/Pulse monitor capture could not be started.'
        );
        return resultFailure({
          code: 'CAPTURE_START_FAILED',
          message: 'PipeWire/Pulse monitor capture could not be started.',
          sampleRate,
          configured: sourceConfigured
        });
      }
    );
    startPromise = trackedPromise;
    return trackedPromise;
  }

  function waitForLifecycleEnd(lifecycle) {
    if (lifecycle.ended) {
      return Promise.resolve(true);
    }

    return new Promise((resolve) => {
      let settled = false;
      let termTimer = null;
      let killTimer = null;

      const settle = (exited) => {
        if (settled) {
          return;
        }
        settled = true;
        lifecycle.endWaiters.delete(onEnded);
        if (termTimer) clearTimer(termTimer);
        if (killTimer) clearTimer(killTimer);
        resolve(exited);
      };
      const onEnded = () => settle(true);
      lifecycle.endWaiters.add(onEnded);

      termTimer = setTimer(() => {
        if (isCurrentLifecycle(lifecycle)) {
          try {
            lifecycle.child.kill('SIGKILL');
          } catch (_) {}
        }

        killTimer = setTimer(() => {
          settle(lifecycle.ended);
        }, killTimeoutMs);
      }, stopTimeoutMs);
    });
  }

  async function performStop() {
    ++operationGeneration;

    if (startPromise && !ownedLifecycle) {
      await startPromise;
    }

    const lifecycle = ownedLifecycle;
    if (!lifecycle || lifecycle.ended) {
      selectedSource = null;
      sourceConfigured = false;
      activeSampleRate = null;
      status = disposed ? 'disposed' : 'idle';
      return stopSuccess();
    }

    status = 'stopping';
    lifecycle.acceptingAudio = false;
    try {
      lifecycle.stdout.pause();
    } catch (_) {}

    if (isCurrentLifecycle(lifecycle)) {
      try {
        lifecycle.child.kill('SIGTERM');
      } catch (_) {}
    }

    const exited = await waitForLifecycleEnd(lifecycle);
    if (!exited && isCurrentLifecycle(lifecycle)) {
      finishLifecycle(lifecycle);
    }

    selectedSource = null;
    sourceConfigured = false;
    activeSampleRate = null;

    if (!exited) {
      setFailure(
        'CAPTURE_STOP_TIMEOUT',
        'PipeWire/Pulse monitor capture did not stop in time.'
      );
      return resultFailure({
        code: 'CAPTURE_STOP_TIMEOUT',
        message: 'PipeWire/Pulse monitor capture did not stop in time.',
        configured: false
      });
    }

    status = disposed ? 'disposed' : 'idle';
    lastError = null;
    return stopSuccess();
  }

  function stop() {
    if (stopPromise) {
      return stopPromise;
    }

    const operation = performStop();
    let trackedPromise;
    trackedPromise = operation.then(
      (result) => {
        if (stopPromise === trackedPromise) {
          stopPromise = null;
        }
        return result;
      },
      () => {
        if (stopPromise === trackedPromise) {
          stopPromise = null;
        }
        setFailure(
          'CAPTURE_STOP_FAILED',
          'PipeWire/Pulse monitor capture could not be stopped.'
        );
        return resultFailure({
          code: 'CAPTURE_STOP_FAILED',
          message: 'PipeWire/Pulse monitor capture could not be stopped.',
          configured: false
        });
      }
    );
    stopPromise = trackedPromise;
    return trackedPromise;
  }

  function dispose() {
    disposed = true;
    return stop();
  }

  function getDiagnostics() {
    return {
      backend: BACKEND,
      status,
      chunkCount,
      sampleRate: activeSampleRate,
      sourceConfigured,
      processActive: Boolean(ownedLifecycle && !ownedLifecycle.ended),
      lastError
    };
  }

  return {
    start,
    stop,
    dispose,
    getDiagnostics
  };
}

module.exports = {
  createPipeWireMonitorCapture,
  isValidMonitorSource,
  parseMonitorSources,
  resolveMonitorSource
};
