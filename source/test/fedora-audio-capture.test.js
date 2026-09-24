'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const esbuild = require('esbuild');

const TRANSCRIPTION_MANAGER_PATH = path.join(
  __dirname,
  '..',
  'src',
  'windows',
  'assistant',
  'renderer',
  'features',
  'transcription',
  'transcription-manager.js'
);

function loadTranscriptionManager() {
  const { createRequire } = require('node:module');
  const sourceRequire = createRequire(TRANSCRIPTION_MANAGER_PATH);
  const transformed = esbuild.transformSync(
    fs.readFileSync(TRANSCRIPTION_MANAGER_PATH, 'utf8'),
    {
      format: 'cjs',
      loader: 'js',
      target: 'node20'
    }
  );
  const loaded = { exports: {} };
  new Function('module', 'exports', 'require', transformed.code)(
    loaded,
    loaded.exports,
    sourceRequire
  );
  return loaded.exports;
}

const { createTranscriptionManager } = loadTranscriptionManager();

function createSourceState({ system = true, mic = true } = {}) {
  const selectedSources = { system, mic };
  const sourceStatuses = { system: 'off', mic: 'off' };
  const activeSources = { system: false, mic: false };

  return {
    selectedSources,
    sourceStatuses,
    activeSources,
    setSourceSelected(source, enabled) {
      selectedSources[source] = Boolean(enabled);
    },
    setSourceStatus(source, status) {
      sourceStatuses[source] = status;
    },
    setSourceActive(source, active) {
      activeSources[source] = Boolean(active);
    },
    isAnySourceConnecting() {
      return sourceStatuses.system === 'connecting' || sourceStatuses.mic === 'connecting';
    }
  };
}

function createStream(kind) {
  const audioTrack = {
    label: `${kind}-audio`,
    stop() {}
  };
  return {
    kind,
    getTracks: () => [audioTrack],
    getAudioTracks: () => [audioTrack],
    getVideoTracks: () => []
  };
}

function setGlobal(t, name, value) {
  const previous = Object.getOwnPropertyDescriptor(globalThis, name);
  Object.defineProperty(globalThis, name, {
    configurable: true,
    writable: true,
    value
  });
  t.after(() => {
    if (previous) {
      Object.defineProperty(globalThis, name, previous);
    } else {
      delete globalThis[name];
    }
  });
}

function createManagerHarness(t, {
  selected = { system: true, mic: true },
  getDesktopSources = async () => [],
  getMonitorStream = async () => null,
  getDesktopStream = async () => createStream('desktop'),
  startDirectCapture = async () => ({
    success: false,
    backend: 'pipewire-monitor',
    sourceConfigured: false,
    error: 'Direct monitor capture unavailable'
  }),
  stopDirectCapture = async () => ({ success: true }),
  captureTimeoutMs = 20,
  rendererPlatform = 'linux',
  navigatorPlatform = 'Linux x86_64'
} = {}) {
  const events = [];
  const feedback = [];
  const sourceState = createSourceState(selected);
  const micStream = createStream('mic');

  class FakeAudioContext {
    constructor() {
      events.push('audio-context:new');
      this.destination = {};
      this.sampleRate = 48000;
    }

    async resume() {}
    async close() {}
  }

  setGlobal(t, 'AudioContext', FakeAudioContext);
  setGlobal(t, 'navigator', {
    platform: navigatorPlatform,
    mediaDevices: {
      async getUserMedia() {
        events.push('mic:getUserMedia');
        return micStream;
      }
    }
  });
  setGlobal(t, 'window', {
    electronAPI: {
      platform: rendererPlatform,
      async startVoiceRecognition(source) {
        events.push(`stt:${source}`);
        return { success: true, sampleRate: 16000 };
      },
      async stopVoiceRecognition(source) {
        events.push(`stop:${source}`);
        return { success: true };
      },
      async startPipeWireMonitorCapture() {
        events.push('direct:start');
        return startDirectCapture();
      },
      async stopPipeWireMonitorCapture() {
        events.push('direct:stop');
        return stopDirectCapture();
      },
      async getDesktopSources() {
        events.push('desktop:getSources');
        return getDesktopSources();
      }
    }
  });

  const audioPipeline = {
    setTargetSampleRate() {},
    resetSourceSampleQueue() {},
    resetChunkCounter() {},
    drainSourceSampleQueue() {},
    stopAudioResources() {},
    isLikelyCameraTrack: () => false,
    async getLinuxMonitorAudioStream() {
      events.push('monitor:getUserMedia');
      return getMonitorStream();
    },
    async getSystemAudioStream(sourceId) {
      events.push(`desktop:getUserMedia:${sourceId}`);
      return getDesktopStream(sourceId);
    },
    async buildAudioProcessor(_context, _stream, source) {
      events.push(`processor:${source}`);
      return { disconnect() {} };
    }
  };

  const manager = createTranscriptionManager({
    transcriptionSourceState: sourceState,
    normalizeSourceRule: (source) => source === 'system' ? 'system' : 'mic',
    sourceLabelRule: (source) => source === 'system' ? 'Host' : 'Mic',
    audioPipeline,
    transcriptBufferManager: {
      resetFinalTranscriptBuffer() {},
      flushFinalTranscript() {},
      queueFinalTranscript() {},
      flushAllFinalTranscripts() {}
    },
    chatMessagesElement: {
      appendChild() {},
      scrollTop: 0,
      scrollHeight: 0
    },
    transcriptionToggle: null,
    sourceSystemToggle: null,
    sourceMicToggle: null,
    monitorMasterState: null,
    monitorStatusSystem: null,
    monitorStatusMic: null,
    monitorLiveSystem: null,
    monitorLiveMic: null,
    monitorLogList: null,
    addChatMessage: () => {},
    showFeedback(message, level) {
      feedback.push({ message, level });
    },
    captureTimeoutMs
  });

  return { manager, events, feedback, sourceState };
}

async function settleWithin(promise, timeoutMs) {
  let timer;
  try {
    return await Promise.race([
      promise.then(() => true),
      new Promise((resolve) => {
        timer = setTimeout(() => resolve(false), timeoutMs);
      })
    ]);
  } finally {
    clearTimeout(timer);
  }
}

describe('Fedora host audio capture', () => {
  it('uses direct PipeWire capture without renderer media resources', async (t) => {
    const { manager, events, sourceState } = createManagerHarness(t, {
      selected: { system: true, mic: false },
      startDirectCapture: async () => ({
        success: true,
        backend: 'pipewire-monitor',
        sampleRate: 24000,
        sourceConfigured: true
      }),
      getMonitorStream: async () => {
        throw new Error('browser monitor must not run');
      },
      getDesktopSources: async () => {
        throw new Error('desktop portal must not run');
      }
    });

    await manager.toggleMasterTranscription();

    assert.equal(sourceState.activeSources.system, true);
    assert.deepEqual(events, ['stt:system', 'direct:start']);
    assert.equal(events.includes('processor:system'), false);
    assert.equal(events.includes('audio-context:new'), false);
    assert.equal(events.includes('monitor:getUserMedia'), false);
    assert.equal(events.includes('desktop:getSources'), false);

    await manager.toggleMasterTranscription();

    assert.equal(sourceState.activeSources.system, false);
    assert.equal(events.indexOf('direct:stop') < events.indexOf('stop:system'), true);
  });

  it('tries direct then browser monitor capture before desktop enumeration', async (t) => {
    const monitorStream = createStream('monitor');
    const { manager, events, sourceState } = createManagerHarness(t, {
      selected: { system: true, mic: false },
      getMonitorStream: async () => monitorStream,
      getDesktopSources: async () => [{
        id: 'desktop-source',
        name: 'Desktop'
      }]
    });

    await manager.toggleMasterTranscription();

    assert.equal(sourceState.activeSources.system, true);
    assert.ok(events.includes('direct:start'));
    assert.ok(events.includes('monitor:getUserMedia'));
    assert.equal(events.includes('desktop:getSources'), false);
    assert.equal(
      events.indexOf('direct:start') < events.indexOf('monitor:getUserMedia')
        && events.indexOf('monitor:getUserMedia') < events.indexOf('processor:system'),
      true
    );
  });

  it('starts mic independently and bounds a hung desktop portal source request', async (t) => {
    let releaseDesktop;
    const desktopSources = new Promise((resolve) => {
      releaseDesktop = resolve;
    });
    const { manager, events, feedback, sourceState } = createManagerHarness(t, {
      selected: { system: true, mic: true },
      captureTimeoutMs: 15,
      getMonitorStream: async () => null,
      getDesktopSources: () => desktopSources
    });

    const running = manager.toggleMasterTranscription();
    const settledBeforePortalRelease = await settleWithin(running, 80);
    const eventsBeforePortalRelease = [...events];
    releaseDesktop([]);
    await settleWithin(running, 80);

    assert.equal(settledBeforePortalRelease, true);
    assert.equal(sourceState.activeSources.mic, true);
    assert.ok(eventsBeforePortalRelease.includes('mic:getUserMedia'));
    assert.ok(eventsBeforePortalRelease.includes('desktop:getSources'));
    assert.equal(
      eventsBeforePortalRelease.indexOf('stt:mic') <
        eventsBeforePortalRelease.indexOf('monitor:getUserMedia'),
      true
    );
    assert.ok(
      feedback.some(({ message }) => /desktop capture portal timed out/i.test(message)),
      `expected actionable portal timeout feedback, got ${JSON.stringify(feedback)}`
    );
  });

  it('bounds desktop getUserMedia after monitor fallback without stopping mic', async (t) => {
    let releaseDesktopMedia;
    const desktopMedia = new Promise((resolve) => {
      releaseDesktopMedia = resolve;
    });
    const { manager, events, feedback, sourceState } = createManagerHarness(t, {
      selected: { system: true, mic: true },
      captureTimeoutMs: 15,
      getMonitorStream: async () => null,
      getDesktopSources: async () => [{
        id: 'desktop-source',
        name: 'Desktop'
      }],
      getDesktopStream: () => desktopMedia
    });

    const running = manager.toggleMasterTranscription();
    const settledBeforeMediaRelease = await settleWithin(running, 80);
    releaseDesktopMedia(createStream('late-desktop'));
    await settleWithin(running, 80);

    assert.equal(settledBeforeMediaRelease, true);
    assert.equal(sourceState.activeSources.mic, true);
    assert.ok(events.includes('desktop:getUserMedia:desktop-source'));
    assert.ok(
      feedback.some(({ message }) => /desktop audio capture timed out/i.test(message)),
      `expected actionable media timeout feedback, got ${JSON.stringify(feedback)}`
    );
  });

  it('skips the Linux monitor fallback on macOS and goes straight to desktop sources', async (t) => {
    const monitorStream = createStream('monitor');
    const desktopStream = createStream('desktop');
    const { manager, events, sourceState } = createManagerHarness(t, {
      selected: { system: true, mic: false },
      rendererPlatform: 'darwin',
      navigatorPlatform: 'MacIntel',
      getMonitorStream: async () => {
        throw new Error('linux monitor must not run on macOS');
      },
      getDesktopSources: async () => [{ id: 'desktop-source', name: 'Desktop' }],
      getDesktopStream: async () => desktopStream
    });

    await manager.toggleMasterTranscription();

    assert.equal(sourceState.activeSources.system, true);
    // Finding 7: getLinuxMonitorAudioStream must not be called on macOS.
    assert.equal(events.includes('monitor:getUserMedia'), false);
    assert.ok(events.includes('desktop:getSources'));
    assert.ok(events.includes('desktop:getUserMedia:desktop-source'));
  });
});
