'use strict';

const { describe, it, mock } = require('node:test');
const assert = require('node:assert/strict');
const {
  getSttSampleRate,
  resolveSttProvider,
  isRealtimeSttProvider
} = require('../../src/config');
const { createSttProvider, createSttRuntime } = require('../../src/services/stt/factory');
const { createOpenAiRealtimeSttService } = require('../../src/services/stt/openai-realtime');
const portkeyWhisper = require('../../src/services/stt/portkey-whisper');

function createRealtimeDrainHarness({
  drainTimeoutMs,
  setDrainTimeout,
  clearDrainTimeout
} = {}) {
  const events = [];
  const sockets = [];

  class ManualWebSocket {
    static CONNECTING = 0;
    static OPEN = 1;
    static CLOSED = 3;

    constructor(url, options) {
      this.url = url;
      this.options = options;
      this.readyState = ManualWebSocket.CONNECTING;
      this.handlers = {};
      this.sent = [];
      this.closeCalls = [];
      sockets.push(this);
      queueMicrotask(() => {
        if (this.readyState !== ManualWebSocket.CONNECTING) return;
        this.readyState = ManualWebSocket.OPEN;
        this.handlers.open?.();
      });
    }

    on(event, handler) {
      this.handlers[event] = handler;
    }

    send(payload) {
      this.sent.push(JSON.parse(payload));
    }

    close(code, reason) {
      this.closeCalls.push({ code, reason });
      this.readyState = ManualWebSocket.CLOSED;
    }

    removeAllListeners() {
      this.handlers = {};
    }

    emitMessage(event) {
      this.handlers.message?.(JSON.stringify(event));
    }

    emitClose(code = 1000, reason = 'closed') {
      this.readyState = ManualWebSocket.CLOSED;
      this.handlers.close?.(code, Buffer.from(reason));
    }
  }

  const service = createOpenAiRealtimeSttService({
    WebSocket: ManualWebSocket,
    desktopCapturer: { getSources: async () => [] },
    getOpenaiApiKey: () => 'test-key',
    getOpenaiSttModel: () => 'gpt-live-transcribe',
    getTranscriptionHints: () => ({ prompt: '', keywords: [] }),
    getGeminiService: () => null,
    sendToRenderer: (channel, data) => {
      events.push({ channel, data });
    },
    drainTimeoutMs,
    setDrainTimeout,
    clearDrainTimeout
  });

  return { events, service, sockets, WebSocket: ManualWebSocket };
}

describe('STT sample rate selection', () => {
  it('maps providers to expected PCM rates', () => {
    assert.equal(getSttSampleRate('assemblyai'), 16000);
    assert.equal(getSttSampleRate('openai'), 24000);
    assert.equal(getSttSampleRate('portkey-whisper'), 16000);
    assert.equal(getSttSampleRate('unknown'), 16000);
  });

  it('marks Portkey Whisper as non-realtime', () => {
    assert.equal(isRealtimeSttProvider('assemblyai'), true);
    assert.equal(isRealtimeSttProvider('openai'), true);
    assert.equal(isRealtimeSttProvider('portkey-whisper'), false);
  });

  it('resolves invalid provider ids to assemblyai', () => {
    assert.equal(resolveSttProvider('nope'), 'assemblyai');
    assert.equal(resolveSttProvider('openai'), 'openai');
  });
});

describe('STT OpenAI event ordering', () => {
  it('emits vosk-partial then vosk-final for the same item', () => {
    const events = [];
    class FakeWebSocket {
      static OPEN = 1;
      static CONNECTING = 0;
      constructor() {
        this.readyState = FakeWebSocket.CONNECTING;
        this.handlers = {};
        queueMicrotask(() => {
          this.readyState = FakeWebSocket.OPEN;
          this.handlers.open?.();
        });
      }

      on(event, handler) {
        this.handlers[event] = handler;
      }

      send(payload) {
        const parsed = JSON.parse(payload);
        if (parsed.type === 'session.update') {
          queueMicrotask(() => {
            this.handlers.message?.(JSON.stringify({ type: 'session.created' }));
            this.handlers.message?.(JSON.stringify({ type: 'session.updated' }));
            this.handlers.message?.(JSON.stringify({
              type: 'conversation.item.input_audio_transcription.delta',
              item_id: 'item_1',
              delta: 'Hello'
            }));
            this.handlers.message?.(JSON.stringify({
              type: 'conversation.item.input_audio_transcription.delta',
              item_id: 'item_1',
              delta: ' world'
            }));
            this.handlers.message?.(JSON.stringify({
              type: 'conversation.item.input_audio_transcription.completed',
              item_id: 'item_1',
              transcript: 'Hello world'
            }));
          });
        }
      }

      close() {
        this.readyState = 3;
        this.handlers.close?.(1000, Buffer.from('OK'));
      }

      removeAllListeners() {
        this.handlers = {};
      }
    }

    const service = createOpenAiRealtimeSttService({
      WebSocket: FakeWebSocket,
      desktopCapturer: { getSources: async () => [] },
      getOpenaiApiKey: () => 'test-key',
      getOpenaiSttModel: () => 'gpt-live-transcribe',
      getTranscriptionHints: () => ({ prompt: '', keywords: [] }),
      getGeminiService: () => null,
      sendToRenderer: (channel, data) => {
        events.push({ channel, data });
      }
    });

    const result = service.start('mic');
    assert.equal(result.success, true);
    assert.equal(result.sampleRate, 24000);

    return new Promise((resolve, reject) => {
      setTimeout(() => {
        try {
          const relevant = events
            .filter((entry) => entry.channel === 'vosk-partial' || entry.channel === 'vosk-final')
            .map((entry) => ({ channel: entry.channel, text: entry.data.text }));

          assert.deepEqual(relevant, [
            { channel: 'vosk-partial', text: 'Hello' },
            { channel: 'vosk-partial', text: 'Hello world' },
            { channel: 'vosk-final', text: 'Hello world' }
          ]);
          assert.deepEqual(
            events
              .filter((entry) => entry.channel === 'vosk-status')
              .map((entry) => entry.data.status),
            ['loading', 'listening']
          );

          service.dispose();
          resolve();
        } catch (error) {
          reject(error);
        }
      }, 50);
    });
  });

  it('uses Portkey realtime fallback and commits bounded audio turns', async () => {
    let socket = null;

    class CaptureWebSocket {
      static OPEN = 1;
      static CONNECTING = 0;

      constructor(url, options) {
        this.url = url;
        this.options = options;
        this.readyState = CaptureWebSocket.CONNECTING;
        this.handlers = {};
        this.sent = [];
        socket = this;
        queueMicrotask(() => {
          this.readyState = CaptureWebSocket.OPEN;
          this.handlers.open?.();
        });
      }

      on(event, handler) {
        this.handlers[event] = handler;
      }

      send(payload) {
        this.sent.push(JSON.parse(payload));
      }

      close() {
        this.readyState = 3;
      }

      removeAllListeners() {
        this.handlers = {};
      }
    }

    const service = createOpenAiRealtimeSttService({
      WebSocket: CaptureWebSocket,
      desktopCapturer: { getSources: async () => [] },
      getOpenaiApiKey: () => '',
      getPortkeyApiKey: () => 'portkey-key',
      getPortkeyRealtimeVirtualKey: () => 'openai',
      getOpenaiSttModel: () => 'gpt-live-transcribe',
      getTranscriptionHints: () => ({ prompt: '', keywords: [] }),
      getGeminiService: () => null,
      sendToRenderer: () => {}
    });

    const started = service.start('mic');
    assert.equal(started.success, true);
    await new Promise((resolve) => setImmediate(resolve));

    assert.match(socket.url, /^wss:\/\/api\.portkey\.ai\/v1\/realtime\?intent=transcription$/);
    assert.equal(socket.options.headers['x-portkey-api-key'], 'portkey-key');
    assert.equal(socket.options.headers['x-portkey-virtual-key'], 'openai');
    assert.equal(socket.options.headers['OpenAI-Beta'], undefined);

    const sessionUpdate = socket.sent.find((event) => event.type === 'session.update');
    assert.equal(sessionUpdate.session.audio.input.turn_detection, null);

    // Three seconds of PCM16 at 24 kHz should close one bounded turn.
    service.handleAudioChunk({
      source: 'mic',
      data: Buffer.alloc(24000 * 2 * 3)
    });
    assert.deepEqual(
      socket.sent.slice(-2).map((event) => event.type),
      ['input_audio_buffer.append', 'input_audio_buffer.commit']
    );

    service.dispose();
  });

  it('drains an outstanding automatic commit when stop has zero buffered bytes', async () => {
    const { events, service, sockets, WebSocket } = createRealtimeDrainHarness();
    service.start('mic');
    await Promise.resolve();
    const socket = sockets[0];

    service.handleAudioChunk({
      source: 'mic',
      data: Buffer.alloc(24000 * 2 * 3)
    });
    assert.equal(
      socket.sent.filter((event) => event.type === 'input_audio_buffer.commit').length,
      1
    );

    const stopped = service.stop({ source: 'mic' });
    assert.equal(socket.readyState, WebSocket.OPEN);
    assert.equal(
      socket.sent.filter((event) => event.type === 'input_audio_buffer.commit').length,
      1,
      'stop must attach to the outstanding auto-commit without sending an empty commit'
    );
    assert.equal(events.some((entry) => entry.channel === 'vosk-stopped'), false);

    socket.emitMessage({
      type: 'input_audio_buffer.committed',
      item_id: 'automatic-item'
    });
    socket.emitMessage({
      type: 'conversation.item.input_audio_transcription.completed',
      item_id: 'automatic-item',
      transcript: 'Automatic final'
    });

    assert.deepEqual(await stopped, { success: true });
    assert.deepEqual(
      events
        .filter((entry) => entry.channel === 'vosk-final' || entry.channel === 'vosk-stopped')
        .map((entry) => entry.channel),
      ['vosk-final', 'vosk-stopped']
    );
    assert.equal(socket.readyState, WebSocket.CLOSED);
    service.dispose();
  });

  it('drains all pre-stop commits when completions arrive out of order by item id', async () => {
    const { events, service, sockets, WebSocket } = createRealtimeDrainHarness();
    service.start('mic');
    await Promise.resolve();
    const socket = sockets[0];

    service.handleAudioChunk({
      source: 'mic',
      data: Buffer.alloc(24000 * 2 * 3)
    });
    socket.emitMessage({
      type: 'input_audio_buffer.committed',
      item_id: 'first-item'
    });
    service.handleAudioChunk({
      source: 'mic',
      data: Buffer.alloc(24000 * 2 * 3)
    });

    const stopped = service.stop({ source: 'mic' });
    assert.equal(socket.readyState, WebSocket.OPEN);
    socket.emitMessage({
      type: 'input_audio_buffer.committed',
      item_id: 'second-item'
    });
    socket.emitMessage({
      type: 'conversation.item.input_audio_transcription.completed',
      item_id: 'second-item',
      transcript: 'Second final'
    });

    assert.equal(socket.readyState, WebSocket.OPEN);
    assert.equal(events.some((entry) => entry.channel === 'vosk-stopped'), false);

    socket.emitMessage({
      type: 'conversation.item.input_audio_transcription.completed',
      item_id: 'first-item',
      transcript: 'First final'
    });

    assert.deepEqual(await stopped, { success: true });
    assert.deepEqual(
      events
        .filter((entry) => entry.channel === 'vosk-final' || entry.channel === 'vosk-stopped')
        .map((entry) => ({
          channel: entry.channel,
          text: entry.data.text
        })),
      [
        { channel: 'vosk-final', text: 'Second final' },
        { channel: 'vosk-final', text: 'First final' },
        { channel: 'vosk-stopped', text: undefined }
      ]
    );
    assert.equal(socket.readyState, WebSocket.CLOSED);
    service.dispose();
  });

  it('keeps the socket open for the matching final transcript before stopping', async () => {
    const { events, service, sockets, WebSocket } = createRealtimeDrainHarness();
    service.start('mic');
    await Promise.resolve();
    const socket = sockets[0];

    service.handleAudioChunk({
      source: 'mic',
      data: Buffer.alloc(480)
    });
    const stopped = service.stop({ source: 'mic' });

    assert.equal(typeof stopped?.then, 'function');
    assert.equal(socket.readyState, WebSocket.OPEN);
    assert.equal(socket.closeCalls.length, 0);
    assert.equal(socket.sent.at(-1).type, 'input_audio_buffer.commit');

    socket.emitMessage({
      type: 'input_audio_buffer.committed',
      item_id: 'drain-item'
    });
    socket.emitMessage({
      type: 'conversation.item.input_audio_transcription.completed',
      item_id: 'older-item',
      transcript: 'Earlier final'
    });
    assert.equal(socket.readyState, WebSocket.OPEN);
    assert.equal(events.some((entry) => entry.channel === 'vosk-stopped'), false);

    socket.emitMessage({
      type: 'conversation.item.input_audio_transcription.completed',
      item_id: 'drain-item',
      transcript: 'Preserved final'
    });
    assert.deepEqual(await stopped, { success: true });

    const lifecycle = events
      .filter((entry) => entry.channel === 'vosk-final' || entry.channel === 'vosk-stopped')
      .map((entry) => ({
        channel: entry.channel,
        text: entry.data.text
      }));
    assert.deepEqual(lifecycle, [
      { channel: 'vosk-final', text: 'Earlier final' },
      { channel: 'vosk-final', text: 'Preserved final' },
      { channel: 'vosk-stopped', text: undefined }
    ]);
    assert.equal(socket.readyState, WebSocket.CLOSED);
    assert.equal(socket.closeCalls.length, 1);
    assert.equal(sockets.length, 1);
    service.dispose();
  });

  it('matches ordered completions when commit acknowledgements are unavailable', async () => {
    const { service, sockets, WebSocket } = createRealtimeDrainHarness();
    service.start('mic');
    await Promise.resolve();
    const socket = sockets[0];

    service.handleAudioChunk({
      source: 'mic',
      data: Buffer.alloc(24000 * 2 * 3)
    });
    socket.emitMessage({
      type: 'conversation.item.input_audio_transcription.completed',
      item_id: 'periodic-item',
      transcript: 'Periodic final'
    });
    service.handleAudioChunk({
      source: 'mic',
      data: Buffer.alloc(2)
    });
    const stopped = service.stop({ source: 'mic' });
    assert.equal(socket.readyState, WebSocket.OPEN);

    socket.emitMessage({
      type: 'conversation.item.input_audio_transcription.completed',
      item_id: 'drain-item',
      transcript: 'Drain final'
    });
    assert.equal(socket.readyState, WebSocket.CLOSED);
    assert.deepEqual(await stopped, { success: true });
    service.dispose();
  });

  it('stops immediately when no audio is buffered', async () => {
    const { events, service, sockets, WebSocket } = createRealtimeDrainHarness();
    service.start('mic');
    await Promise.resolve();
    const socket = sockets[0];

    const stopped = service.stop({ source: 'mic' });

    assert.equal(socket.readyState, WebSocket.CLOSED);
    assert.equal(
      events.filter((entry) => entry.channel === 'vosk-stopped').length,
      1
    );
    assert.deepEqual(await stopped, { success: true });
    service.dispose();
  });

  it('cleans up a pending stop when the drain timeout fires', async () => {
    let fireDrainTimeout = null;
    let timeoutDelay = null;
    let clearedTimer = null;
    const timerToken = {};
    const { events, service, sockets, WebSocket } = createRealtimeDrainHarness({
      drainTimeoutMs: 37,
      setDrainTimeout(callback, delay) {
        fireDrainTimeout = callback;
        timeoutDelay = delay;
        return timerToken;
      },
      clearDrainTimeout(timer) {
        clearedTimer = timer;
      }
    });
    service.start('mic');
    await Promise.resolve();
    const socket = sockets[0];
    service.handleAudioChunk({ source: 'mic', data: Buffer.alloc(2) });

    const stopped = service.stop({ source: 'mic' });
    assert.equal(socket.readyState, WebSocket.OPEN);
    assert.equal(timeoutDelay, 37);
    assert.equal(typeof fireDrainTimeout, 'function');

    fireDrainTimeout();
    const result = await stopped;
    assert.equal(result.success, false);
    assert.match(result.error, /timed out waiting for final transcription results/i);
    assert.equal(socket.readyState, WebSocket.CLOSED);
    assert.equal(clearedTimer, timerToken);
    const timeoutEvent = events.find((entry) => (
      entry.channel === 'stt-debug'
      && entry.data.event === 'stop-drain-timeout'
    ));
    assert.equal(timeoutEvent?.data?.level, 'error');
    assert.equal(
      events.filter((entry) => entry.channel === 'vosk-stopped').length,
      1
    );
    service.dispose();
  });

  it('dispose forces cleanup and settles a pending drain', async () => {
    let fireDrainTimeout = null;
    const { service, sockets, WebSocket } = createRealtimeDrainHarness({
      setDrainTimeout(callback) {
        fireDrainTimeout = callback;
        return {};
      },
      clearDrainTimeout() {}
    });
    service.start('mic');
    await Promise.resolve();
    const socket = sockets[0];
    service.handleAudioChunk({ source: 'mic', data: Buffer.alloc(2) });

    const stopped = service.stop({ source: 'mic' });
    assert.equal(socket.readyState, WebSocket.OPEN);
    assert.equal(typeof fireDrainTimeout, 'function');

    service.dispose();
    assert.deepEqual(await stopped, { success: true });
    assert.equal(socket.readyState, WebSocket.CLOSED);
  });

  it('does not reconnect when the socket closes during an intentional drain', async () => {
    let fireDrainTimeout = null;
    const { events, service, sockets } = createRealtimeDrainHarness({
      setDrainTimeout(callback) {
        fireDrainTimeout = callback;
        return {};
      },
      clearDrainTimeout() {}
    });
    service.start('mic');
    await Promise.resolve();
    const socket = sockets[0];
    service.handleAudioChunk({ source: 'mic', data: Buffer.alloc(2) });

    const stopped = service.stop({ source: 'mic' });
    socket.emitClose(1000, 'intentional stop');

    assert.equal(events.some((entry) => entry.channel === 'vosk-stopped'), false);
    assert.equal(sockets.length, 1);
    assert.equal(
      events.some((entry) => entry.channel === 'stt-debug'
        && entry.data.event === 'reconnect-scheduled'),
      false
    );
    fireDrainTimeout();
    assert.equal((await stopped).success, false);
    assert.equal(
      events.filter((entry) => entry.channel === 'vosk-stopped').length,
      1
    );
    service.dispose();
  });
});

describe('STT factory / runtime', () => {
  it('routes Portkey Whisper through the OpenAI virtual provider by default', () => {
    assert.equal(typeof portkeyWhisper.buildPortkeyWhisperClientOptions, 'function');
    if (typeof portkeyWhisper.buildPortkeyWhisperClientOptions !== 'function') {
      return;
    }

    assert.deepEqual(
      portkeyWhisper.buildPortkeyWhisperClientOptions('portkey-key'),
      {
        apiKey: 'portkey-key',
        provider: '@openai',
        strictOpenAiCompliance: false
      }
    );
    assert.equal(
      portkeyWhisper.buildPortkeyWhisperClientOptions('portkey-key', '@custom').provider,
      '@custom'
    );
  });

  it('creates assemblyai provider with 16 kHz contract fields', () => {
    const provider = createSttProvider('assemblyai', {
      WebSocket: class {},
      desktopCapturer: { getSources: async () => [] },
      getAssemblyApiKey: () => '',
      getSpeechModel: () => 'universal-streaming-english',
      getGeminiService: () => null,
      sendToRenderer: () => {}
    });

    assert.equal(provider.id, 'assemblyai');
    assert.equal(provider.sampleRate, 16000);
    assert.equal(typeof provider.start, 'function');
    assert.equal(typeof provider.handleAudioChunk, 'function');
    assert.equal(typeof provider.stop, 'function');
    assert.equal(typeof provider.dispose, 'function');
    provider.dispose();
  });

  it('runtime switches providers and reports active sample rate', () => {
    let providerId = 'assemblyai';
    const runtime = createSttRuntime({
      getProviderId: () => providerId,
      createProviderDeps: () => ({
        WebSocket: class {
          static OPEN = 1;
          constructor() {
            this.readyState = 3;
          }
          on() {}
          send() {}
          close() {}
          removeAllListeners() {}
          terminate() {}
        },
        desktopCapturer: { getSources: async () => [] },
        getAssemblyApiKey: () => 'assembly-key',
        getSpeechModel: () => 'universal-streaming-english',
        getOpenaiApiKey: () => 'openai-key',
        getOpenaiSttModel: () => 'gpt-live-transcribe',
        getPortkeyApiKey: () => 'portkey-key',
        getTranscriptionHints: () => ({}),
        getGeminiService: () => null,
        sendToRenderer: () => {}
      })
    });

    runtime.ensureProvider();
    assert.equal(runtime.getActiveProviderId(), 'assemblyai');
    assert.equal(runtime.getSampleRate(), 16000);

    providerId = 'openai';
    runtime.ensureProvider();
    assert.equal(runtime.getActiveProviderId(), 'openai');
    assert.equal(runtime.getSampleRate(), 24000);

    runtime.dispose();
  });
});

// Keep unused mock import intentional for future expansion without lint noise.
void mock;
