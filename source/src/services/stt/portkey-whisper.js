'use strict';

const PortkeyModule = require('portkey-ai');
const Portkey = PortkeyModule.default || PortkeyModule.Portkey || PortkeyModule;
const OpenAI = require('openai');
const {
  createSttHistoryManager,
  normalizeSttSource
} = require('../assembly-ai/stt-history');
const { getSttSampleRate } = require('./contract');
const {
  createSttDebugEmitter,
  getDesktopSources,
  pcm16ToWavBuffer
} = require('./helpers');

const WHISPER_SAMPLE_RATE = getSttSampleRate('portkey-whisper');
// Non-realtime: Portkey audio.transcriptions is request/response only.
const CHUNK_DURATION_MS = 4000;
const BYTES_PER_SAMPLE = 2;
const DEFAULT_PORTKEY_WHISPER_PROVIDER = '@openai';
const TARGET_CHUNK_BYTES = Math.round(
  (WHISPER_SAMPLE_RATE * (CHUNK_DURATION_MS / 1000)) * BYTES_PER_SAMPLE
);

function buildPortkeyWhisperClientOptions(
  apiKey,
  provider = DEFAULT_PORTKEY_WHISPER_PROVIDER
) {
  return {
    apiKey: String(apiKey || '').trim(),
    provider: String(provider || DEFAULT_PORTKEY_WHISPER_PROVIDER).trim()
      || DEFAULT_PORTKEY_WHISPER_PROVIDER,
    strictOpenAiCompliance: false
  };
}

function createPortkeyWhisperSttService({
  desktopCapturer,
  getPortkeyApiKey,
  getPortkeyWhisperProvider,
  getGeminiService,
  sendToRenderer,
  whisperModel = 'whisper-1'
}) {
  const emitSttDebug = createSttDebugEmitter(sendToRenderer);
  const sttHistoryManager = createSttHistoryManager({
    getGeminiService,
    emitSttDebug,
    mergeWindowMs: 3500
  });

  const sessions = {
    mic: createEmptySession(),
    system: createEmptySession()
  };

  function createEmptySession() {
    return {
      active: false,
      buffers: [],
      bufferedBytes: 0,
      flushing: false,
      chunkCount: 0
    };
  }

  function getSession(source) {
    return sessions[normalizeSttSource(source)];
  }

  function resetSession(source) {
    const resolvedSource = normalizeSttSource(source);
    const session = getSession(resolvedSource);
    session.active = false;
    session.buffers = [];
    session.bufferedBytes = 0;
    session.flushing = false;
    session.chunkCount = 0;
    sttHistoryManager.resetSttHistoryBuffer(resolvedSource);
  }

  function createClient() {
    const apiKey = typeof getPortkeyApiKey === 'function'
      ? String(getPortkeyApiKey() || '').trim()
      : '';
    if (!apiKey) {
      return null;
    }
    const provider = typeof getPortkeyWhisperProvider === 'function'
      ? getPortkeyWhisperProvider()
      : DEFAULT_PORTKEY_WHISPER_PROVIDER;
    return new Portkey(buildPortkeyWhisperClientOptions(apiKey, provider));
  }

  async function flushSource(source, { force = false } = {}) {
    const resolvedSource = normalizeSttSource(source);
    const session = getSession(resolvedSource);

    if (!session.active || session.flushing) {
      return;
    }
    if (!force && session.bufferedBytes < TARGET_CHUNK_BYTES) {
      return;
    }
    if (session.bufferedBytes === 0) {
      return;
    }

    const client = createClient();
    if (!client) {
      sendToRenderer('vosk-error', {
        source: resolvedSource,
        error: 'Portkey API key not configured. Add it in Settings.'
      });
      return;
    }

    const pcm = Buffer.concat(session.buffers);
    session.buffers = [];
    session.bufferedBytes = 0;
    session.flushing = true;

    try {
      const wav = pcm16ToWavBuffer(pcm, WHISPER_SAMPLE_RATE);
      // Portkey mirrors OpenAI audio.transcriptions.create; File/Blob-like upload.
      const file = await OpenAI.toFile(wav, `chunk-${resolvedSource}-${Date.now()}.wav`);

      emitSttDebug({
        source: resolvedSource,
        event: 'whisper-request',
        message: 'Submitting non-realtime Whisper chunk via Portkey',
        meta: {
          bytes: wav.length,
          durationMsApprox: Math.round((pcm.length / BYTES_PER_SAMPLE / WHISPER_SAMPLE_RATE) * 1000),
          model: whisperModel
        }
      });

      const result = await client.audio.transcriptions.create({
        file,
        model: whisperModel
      });

      const text = typeof result === 'string'
        ? result
        : String(result?.text || '').trim();

      if (text) {
        sendToRenderer('vosk-final', { source: resolvedSource, text });
        sttHistoryManager.queueSttHistorySegment(resolvedSource, text);
      }
    } catch (error) {
      emitSttDebug({
        source: resolvedSource,
        level: 'error',
        event: 'whisper-failed',
        message: error.message
      });
      sendToRenderer('vosk-error', {
        source: resolvedSource,
        error: `Portkey Whisper error (${resolvedSource}): ${error.message}`
      });
    } finally {
      session.flushing = false;
    }
  }

  function start(source) {
    const resolvedSource = normalizeSttSource(source);
    const apiKey = typeof getPortkeyApiKey === 'function'
      ? String(getPortkeyApiKey() || '').trim()
      : '';

    if (!apiKey) {
      emitSttDebug({
        source: resolvedSource,
        level: 'error',
        event: 'missing-api-key',
        message: 'Portkey API key not configured in Settings'
      });
      sendToRenderer('vosk-error', {
        source: resolvedSource,
        error: 'Portkey API key not configured. Add it in Settings.'
      });
      return { success: false, error: 'Portkey API key not configured. Add it in Settings.' };
    }

    const session = getSession(resolvedSource);
    if (session.active) {
      return {
        success: true,
        sampleRate: WHISPER_SAMPLE_RATE,
        message: resolvedSource === 'system' ? 'System already capturing' : 'Mic already capturing'
      };
    }

    resetSession(resolvedSource);
    session.active = true;

    sendToRenderer('vosk-status', {
      source: resolvedSource,
      status: 'loading',
      message: `Connecting (${resolvedSource})...`
    });

    // Non-realtime: listening means bounded chunk capture has started.
    sendToRenderer('vosk-status', {
      source: resolvedSource,
      status: 'listening',
      message: `Recording chunks (${resolvedSource === 'system' ? 'Host' : 'You'}) — non-realtime Whisper`
    });

    emitSttDebug({
      source: resolvedSource,
      event: 'start-request',
      message: 'Started Portkey Whisper non-realtime chunk capture',
      meta: {
        sampleRate: WHISPER_SAMPLE_RATE,
        chunkDurationMs: CHUNK_DURATION_MS,
        realtime: false
      }
    });

    return { success: true, sampleRate: WHISPER_SAMPLE_RATE };
  }

  function handleAudioChunk({ source, data }) {
    const resolvedSource = normalizeSttSource(source);
    const session = getSession(resolvedSource);
    if (!session.active) {
      return;
    }

    const chunk = Buffer.isBuffer(data) ? data : Buffer.from(data);
    session.buffers.push(chunk);
    session.bufferedBytes += chunk.length;
    session.chunkCount += 1;

    if (session.chunkCount % 50 === 0) {
      emitSttDebug({
        source: resolvedSource,
        event: 'chunk-heartbeat',
        message: 'Buffering non-realtime Whisper audio',
        meta: {
          chunks: session.chunkCount,
          bufferedBytes: session.bufferedBytes
        }
      });
    }

    if (session.bufferedBytes >= TARGET_CHUNK_BYTES) {
      flushSource(resolvedSource).catch(() => {});
    }
  }

  async function stopSource(source) {
    const resolvedSource = normalizeSttSource(source);
    const session = getSession(resolvedSource);
    if (!session.active) {
      sttHistoryManager.flushSttHistoryBuffer(resolvedSource, 'stop-noop');
      return;
    }

    await flushSource(resolvedSource, { force: true });
    sttHistoryManager.flushSttHistoryBuffer(resolvedSource, 'stop-request');
    session.active = false;
    sendToRenderer('vosk-status', {
      source: resolvedSource,
      status: 'stopped',
      message: 'Stopped'
    });
    sendToRenderer('vosk-stopped', { source: resolvedSource });
    emitSttDebug({
      source: resolvedSource,
      event: 'stop-issued',
      message: 'Portkey Whisper capture stopped'
    });
    resetSession(resolvedSource);
  }

  function stop({ source } = {}) {
    emitSttDebug({
      source: source === 'system' || source === 'mic' ? source : null,
      event: 'ipc-stop',
      message: `Stop requested for ${source || 'default'}`
    });

    const targets = source === 'all'
      ? ['mic', 'system']
      : [source === 'system' ? 'system' : 'mic'];

    // Fire-and-forget async flush; callers treat stop as sync success.
    Promise.all(targets.map((target) => stopSource(target))).catch((error) => {
      emitSttDebug({
        level: 'error',
        event: 'stop-error',
        message: error.message
      });
    });

    return { success: true };
  }

  function dispose() {
    sttHistoryManager.flushAllSttHistoryBuffers('cleanup');
    resetSession('mic');
    resetSession('system');
    sttHistoryManager.dispose();
  }

  return {
    id: 'portkey-whisper',
    sampleRate: WHISPER_SAMPLE_RATE,
    start,
    startAssemblyAiStream: start,
    handleAudioChunk,
    stop,
    stopVoiceRecognition: stop,
    dispose,
    emitSttDebug,
    flushAllSttHistoryBuffers: sttHistoryManager.flushAllSttHistoryBuffers,
    resetSttHistoryBuffers: () => {
      sttHistoryManager.resetSttHistoryBuffer('mic');
      sttHistoryManager.resetSttHistoryBuffer('system');
    },
    getDesktopSources: () => getDesktopSources(desktopCapturer),
    async transcribeAudio() {
      return {
        success: false,
        error: 'Batch transcribe-audio is not implemented for Portkey Whisper STT.'
      };
    }
  };
}

module.exports = {
  buildPortkeyWhisperClientOptions,
  createPortkeyWhisperSttService,
  CHUNK_DURATION_MS,
  DEFAULT_PORTKEY_WHISPER_PROVIDER,
  TARGET_CHUNK_BYTES
};
