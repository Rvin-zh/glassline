'use strict';

const {
  createSttHistoryManager,
  normalizeSttSource
} = require('../assembly-ai/stt-history');
const {
  DEFAULT_OPENAI_STT_MODEL,
  getSttSampleRate,
  resolveOpenaiSttModel
} = require('./contract');
const {
  createSttDebugEmitter,
  getDesktopSources,
  sanitizeKeywords,
  sanitizePrompt
} = require('./helpers');

const OPENAI_SAMPLE_RATE = getSttSampleRate('openai');
const REALTIME_WS_URL = 'wss://api.openai.com/v1/realtime?intent=transcription';
const PORTKEY_REALTIME_WS_URL = 'wss://api.portkey.ai/v1/realtime?intent=transcription';
const DEFAULT_PORTKEY_REALTIME_VIRTUAL_KEY = 'openai';
const AUTO_COMMIT_INTERVAL_MS = 3000;
const AUTO_COMMIT_BYTES = OPENAI_SAMPLE_RATE * 2 * (AUTO_COMMIT_INTERVAL_MS / 1000);
const MAX_RECONNECT_ATTEMPTS = 8;
const BASE_RECONNECT_MS = 500;
const DEFAULT_DRAIN_TIMEOUT_MS = 1500;
const DRAIN_TIMEOUT_ERROR = 'Timed out waiting for final transcription results';
const STOP_COMMIT_ERROR = 'Could not finalize pending transcription audio';

function createOpenAiRealtimeSttService({
  WebSocket,
  desktopCapturer,
  getOpenaiApiKey,
  getPortkeyApiKey,
  getPortkeyRealtimeVirtualKey,
  getOpenaiSttModel,
  getTranscriptionHints,
  getGeminiService,
  sendToRenderer,
  drainTimeoutMs = DEFAULT_DRAIN_TIMEOUT_MS,
  setDrainTimeout = setTimeout,
  clearDrainTimeout = clearTimeout
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
      ws: null,
      streaming: false,
      intentionalStop: false,
      reconnectAttempt: 0,
      reconnectTimer: null,
      chunkCount: 0,
      droppedCount: 0,
      bufferedBytesSinceCommit: 0,
      partialByItem: new Map(),
      lastPartialText: '',
      pendingCommits: [],
      committedItems: new Map(),
      stopDrain: null
    };
  }

  function getSession(source) {
    return sessions[normalizeSttSource(source)];
  }

  function clearReconnect(session) {
    if (session.reconnectTimer) {
      clearTimeout(session.reconnectTimer);
      session.reconnectTimer = null;
    }
  }

  function cleanupSocket(ws) {
    if (!ws) return;
    try {
      // close() while CONNECTING emits "WebSocket was closed before the
      // connection was established" on the next tick. Keep a listener so
      // that expected abort does not become an uncaught exception.
      ws.removeAllListeners();
      ws.on('error', (error) => {
        const message = error && error.message ? error.message : '';
        if (/closed before the connection was established/i.test(message)) {
          return;
        }
        console.error('Error cleaning OpenAI Realtime socket:', message);
      });
      if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) {
        ws.close(1000, 'cleanup');
      }
    } catch (error) {
      console.error('Error cleaning OpenAI Realtime socket:', error.message);
    }
  }

  function settleStopDrain(session, result = { success: true }) {
    const drain = session.stopDrain;
    if (!drain) return;

    session.stopDrain = null;
    if (drain.timer !== null) {
      clearDrainTimeout(drain.timer);
      drain.timer = null;
    }
    drain.resolve(result);
  }

  function resetSession(
    source,
    { keepReconnect = false, stopResult = { success: true } } = {}
  ) {
    const resolvedSource = normalizeSttSource(source);
    const session = getSession(resolvedSource);
    clearReconnect(session);
    cleanupSocket(session.ws);
    session.ws = null;
    session.streaming = false;
    session.chunkCount = 0;
    session.droppedCount = 0;
    session.bufferedBytesSinceCommit = 0;
    session.partialByItem.clear();
    session.lastPartialText = '';
    session.pendingCommits.length = 0;
    session.committedItems.clear();
    if (!keepReconnect) {
      session.reconnectAttempt = 0;
      session.intentionalStop = false;
    }
    sttHistoryManager.resetSttHistoryBuffer(resolvedSource);
    settleStopDrain(session, stopResult);
  }

  function finishIntentionalStop(source, reason, result = { success: true }) {
    const resolvedSource = normalizeSttSource(source);
    const session = getSession(resolvedSource);
    if (!session.intentionalStop && !session.stopDrain) {
      return;
    }

    sttHistoryManager.flushSttHistoryBuffer(resolvedSource, reason);
    sendToRenderer('vosk-status', {
      source: resolvedSource,
      status: 'stopped',
      message: 'Stopped'
    });
    emitSttDebug({
      source: resolvedSource,
      event: 'stop-issued',
      message: 'OpenAI Realtime session stop requested',
      meta: { reason }
    });
    sendToRenderer('vosk-stopped', { source: resolvedSource });
    resetSession(resolvedSource, { stopResult: result });
  }

  function beginStopDrain(source, ws) {
    const resolvedSource = normalizeSttSource(source);
    const session = getSession(resolvedSource);
    let resolveDrain;
    const promise = new Promise((resolve) => {
      resolveDrain = resolve;
    });
    const timeoutMs = Number.isFinite(Number(drainTimeoutMs))
      ? Math.max(0, Number(drainTimeoutMs))
      : DEFAULT_DRAIN_TIMEOUT_MS;
    const drain = {
      ws,
      remainingCommits: new Set(),
      timer: null,
      promise,
      resolve: resolveDrain
    };

    session.stopDrain = drain;
    for (const commit of new Set([
      ...session.pendingCommits,
      ...session.committedItems.values()
    ])) {
      commit.drain = drain;
      drain.remainingCommits.add(commit);
    }
    drain.timer = setDrainTimeout(() => {
      if (session.stopDrain !== drain) return;
      emitSttDebug({
        source: resolvedSource,
        level: 'error',
        event: 'stop-drain-timeout',
        message: 'Timed out waiting for final OpenAI Realtime transcript',
        meta: { timeoutMs }
      });
      finishIntentionalStop(
        resolvedSource,
        'stop-drain-timeout',
        { success: false, error: DRAIN_TIMEOUT_ERROR }
      );
    }, timeoutMs);
    return drain;
  }

  function sendAudioCommit(session, ws, drain = null) {
    const pendingCommit = { drain: null };
    if (drain) {
      pendingCommit.drain = drain;
      drain.remainingCommits.add(pendingCommit);
    }
    session.pendingCommits.push(pendingCommit);
    try {
      ws.send(JSON.stringify({ type: 'input_audio_buffer.commit' }));
    } catch (error) {
      const index = session.pendingCommits.indexOf(pendingCommit);
      if (index >= 0) {
        session.pendingCommits.splice(index, 1);
      }
      drain?.remainingCommits.delete(pendingCommit);
      throw error;
    }
    return pendingCommit;
  }

  function buildSessionUpdatePayload() {
    const model = resolveOpenaiSttModel(
      typeof getOpenaiSttModel === 'function' ? getOpenaiSttModel() : DEFAULT_OPENAI_STT_MODEL
    );
    const hints = typeof getTranscriptionHints === 'function'
      ? (getTranscriptionHints() || {})
      : {};
    const prompt = sanitizePrompt(hints.prompt);
    const keywords = sanitizeKeywords(hints.keywords);

    const transcription = {
      model,
      delay: 'minimal'
    };

    if (prompt) {
      transcription.prompt = prompt;
    }
    if (keywords.length > 0) {
      transcription.keywords = keywords;
    }

    return {
      type: 'session.update',
      session: {
        type: 'transcription',
        audio: {
          input: {
            format: {
              type: 'audio/pcm',
              rate: OPENAI_SAMPLE_RATE
            },
            transcription,
            // gpt-live-transcribe requires explicit commits; bounded commits
            // below keep final transcript events flowing during long sessions.
            turn_detection: null
          }
        }
      }
    };
  }

  function emitPartial(source, text) {
    const trimmed = String(text || '').trim();
    if (!trimmed) return;
    const session = getSession(source);
    session.lastPartialText = trimmed;
    sendToRenderer('vosk-partial', { source, text: trimmed });
  }

  function emitFinal(source, text) {
    const trimmed = String(text || '').trim();
    if (!trimmed) return;
    const session = getSession(source);
    session.lastPartialText = '';
    sendToRenderer('vosk-final', { source, text: trimmed });
    sttHistoryManager.queueSttHistorySegment(source, trimmed);
  }

  function handleServerEvent(source, event) {
    if (!event || typeof event !== 'object') {
      return;
    }

    const session = getSession(source);
    const type = String(event.type || '');

    if (type === 'session.created') {
      emitSttDebug({
        source,
        event: type,
        message: 'OpenAI Realtime transcription session created; awaiting configuration',
        meta: { model: resolveOpenaiSttModel(getOpenaiSttModel?.()) }
      });
      return;
    }

    if (type === 'session.updated') {
      sendToRenderer('vosk-status', {
        source,
        status: 'listening',
        message: `Listening (${source === 'system' ? 'Host' : 'You'})...`
      });
      emitSttDebug({
        source,
        event: type,
        message: 'OpenAI Realtime transcription session ready',
        meta: { model: resolveOpenaiSttModel(getOpenaiSttModel?.()) }
      });
      return;
    }

    if (type === 'conversation.item.input_audio_transcription.delta') {
      const itemId = event.item_id || 'default';
      const delta = String(event.delta || '');
      if (!delta) return;
      const previous = session.partialByItem.get(itemId) || '';
      const next = `${previous}${delta}`;
      session.partialByItem.set(itemId, next);
      emitPartial(source, next);
      return;
    }

    if (type === 'input_audio_buffer.committed') {
      const pendingCommit = session.pendingCommits.shift() || null;
      const itemId = String(event.item_id || '');
      if (itemId && pendingCommit) {
        session.committedItems.set(itemId, pendingCommit);
      }
      return;
    }

    if (type === 'conversation.item.input_audio_transcription.completed') {
      const itemId = String(event.item_id || 'default');
      let completedCommit = session.committedItems.get(itemId) || null;
      session.committedItems.delete(itemId);
      if (!completedCommit) {
        // Some providers omit commit acknowledgements. In that case,
        // completion order is the only available commit correlation.
        completedCommit = session.pendingCommits.shift() || null;
      }
      session.partialByItem.delete(itemId);
      emitFinal(source, event.transcript || '');

      const drain = completedCommit?.drain;
      if (drain && session.stopDrain === drain) {
        drain.remainingCommits.delete(completedCommit);
        if (drain.remainingCommits.size === 0) {
          finishIntentionalStop(source, 'stop-drain-completed');
        }
      }
      return;
    }

    if (type === 'error') {
      const message = event.error?.message || 'OpenAI Realtime transcription error';
      emitSttDebug({
        source,
        level: 'error',
        event: 'provider-error',
        message
      });
      sendToRenderer('vosk-error', { source, error: message });
    }
  }

  function scheduleReconnect(source) {
    const session = getSession(source);
    if (session.intentionalStop) {
      return;
    }
    if (session.reconnectAttempt >= MAX_RECONNECT_ATTEMPTS) {
      emitSttDebug({
        source,
        level: 'error',
        event: 'reconnect-exhausted',
        message: 'OpenAI Realtime reconnect attempts exhausted'
      });
      sendToRenderer('vosk-error', {
        source,
        error: 'OpenAI Realtime connection lost (reconnect exhausted)'
      });
      resetSession(source);
      sendToRenderer('vosk-stopped', { source });
      return;
    }

    const delay = Math.min(30000, BASE_RECONNECT_MS * (2 ** session.reconnectAttempt));
    session.reconnectAttempt += 1;
    emitSttDebug({
      source,
      event: 'reconnect-scheduled',
      message: `Reconnecting in ${delay}ms`,
      meta: { attempt: session.reconnectAttempt, delayMs: delay }
    });

    clearReconnect(session);
    session.reconnectTimer = setTimeout(() => {
      session.reconnectTimer = null;
      start(source, { isReconnect: true });
    }, delay);
  }

  function start(source, { isReconnect = false } = {}) {
    const resolvedSource = normalizeSttSource(source);
    const openaiApiKey = typeof getOpenaiApiKey === 'function'
      ? String(getOpenaiApiKey() || '').trim()
      : '';
    const portkeyApiKey = typeof getPortkeyApiKey === 'function'
      ? String(getPortkeyApiKey() || '').trim()
      : '';
    const usePortkey = !openaiApiKey && Boolean(portkeyApiKey);
    const session = getSession(resolvedSource);

    if (!openaiApiKey && !portkeyApiKey) {
      emitSttDebug({
        source: resolvedSource,
        level: 'error',
        event: 'missing-api-key',
        message: 'OpenAI or Portkey API key not configured in Settings'
      });
      sendToRenderer('vosk-error', {
        source: resolvedSource,
        error: 'OpenAI or Portkey API key not configured. Add one in Settings.'
      });
      return {
        success: false,
        error: 'OpenAI or Portkey API key not configured. Add one in Settings.'
      };
    }

    if (session.streaming && session.ws && session.ws.readyState === WebSocket.OPEN) {
      return {
        success: true,
        sampleRate: OPENAI_SAMPLE_RATE,
        message: resolvedSource === 'system' ? 'System audio already streaming' : 'Mic already streaming'
      };
    }

    try {
      session.intentionalStop = false;
      clearReconnect(session);
      cleanupSocket(session.ws);
      session.ws = null;
      session.partialByItem.clear();
      session.lastPartialText = '';
      session.pendingCommits.length = 0;
      session.committedItems.clear();
      if (!isReconnect) {
        session.reconnectAttempt = 0;
        session.chunkCount = 0;
        session.droppedCount = 0;
        session.bufferedBytesSinceCommit = 0;
        sttHistoryManager.resetSttHistoryBuffer(resolvedSource);
      }

      sendToRenderer('vosk-status', {
        source: resolvedSource,
        status: 'loading',
        message: `Connecting (${resolvedSource})...`
      });

      emitSttDebug({
        source: resolvedSource,
        event: isReconnect ? 'reconnect-request' : 'start-request',
        message: 'Opening OpenAI Realtime transcription WebSocket',
        meta: {
          sampleRate: OPENAI_SAMPLE_RATE,
          transport: usePortkey ? 'portkey' : 'direct-openai'
        }
      });

      const virtualKey = typeof getPortkeyRealtimeVirtualKey === 'function'
        ? String(getPortkeyRealtimeVirtualKey() || '').trim()
        : DEFAULT_PORTKEY_REALTIME_VIRTUAL_KEY;
      const headers = usePortkey
        ? {
          'x-portkey-api-key': portkeyApiKey,
          'x-portkey-virtual-key': virtualKey || DEFAULT_PORTKEY_REALTIME_VIRTUAL_KEY
        }
        : {
          Authorization: `Bearer ${openaiApiKey}`
        };
      const ws = new WebSocket(
        usePortkey ? PORTKEY_REALTIME_WS_URL : REALTIME_WS_URL,
        { headers }
      );

      session.ws = ws;

      ws.on('open', () => {
        session.streaming = true;
        session.reconnectAttempt = 0;
        emitSttDebug({
          source: resolvedSource,
          event: 'ws-open',
          message: 'OpenAI Realtime WebSocket connected'
        });
        try {
          ws.send(JSON.stringify(buildSessionUpdatePayload()));
        } catch (error) {
          emitSttDebug({
            source: resolvedSource,
            level: 'error',
            event: 'session-update-failed',
            message: error.message
          });
        }
      });

      ws.on('message', (rawMessage) => {
        try {
          const event = JSON.parse(rawMessage.toString());
          handleServerEvent(resolvedSource, event);
        } catch (parseError) {
          emitSttDebug({
            source: resolvedSource,
            level: 'error',
            event: 'parse-error',
            message: parseError.message
          });
        }
      });

      ws.on('error', (error) => {
        emitSttDebug({
          source: resolvedSource,
          level: 'error',
          event: 'ws-error',
          message: error.message
        });
        if (!session.intentionalStop) {
          sendToRenderer('vosk-error', {
            source: resolvedSource,
            error: `Connection error (${resolvedSource}): ${error.message}`
          });
        }
      });

      ws.on('close', (code, reason) => {
        const wasStreaming = session.streaming;
        session.streaming = false;
        emitSttDebug({
          source: resolvedSource,
          event: 'ws-close',
          message: 'OpenAI Realtime WebSocket closed',
          meta: { code, reason: reason?.toString() || '' }
        });

        if (session.intentionalStop) {
          if (session.stopDrain?.remainingCommits.size > 0) {
            return;
          }
          finishIntentionalStop(resolvedSource, 'ws-close');
          return;
        }

        session.ws = null;
        if (wasStreaming) {
          sttHistoryManager.flushSttHistoryBuffer(resolvedSource, 'ws-close-reconnect');
          scheduleReconnect(resolvedSource);
        }
      });

      return { success: true, sampleRate: OPENAI_SAMPLE_RATE };
    } catch (error) {
      emitSttDebug({
        source: resolvedSource,
        level: 'error',
        event: 'start-failed',
        message: error.message
      });
      session.streaming = false;
      return { success: false, error: error.message };
    }
  }

  function handleAudioChunk({ source, data }) {
    const resolvedSource = normalizeSttSource(source);
    const session = getSession(resolvedSource);
    const ws = session.ws;

    if (ws && ws.readyState === WebSocket.OPEN) {
      const audioBuffer = Buffer.isBuffer(data) ? data : Buffer.from(data);
      ws.send(JSON.stringify({
        type: 'input_audio_buffer.append',
        audio: audioBuffer.toString('base64')
      }));
      session.chunkCount += 1;
      session.bufferedBytesSinceCommit += audioBuffer.length;

      if (session.bufferedBytesSinceCommit >= AUTO_COMMIT_BYTES) {
        sendAudioCommit(session, ws);
        session.bufferedBytesSinceCommit = 0;
      }

      if (session.chunkCount % 50 === 0) {
        emitSttDebug({
          source: resolvedSource,
          event: 'chunk-heartbeat',
          message: 'Streaming audio chunks',
          meta: {
            chunks: session.chunkCount,
            dropped: session.droppedCount
          }
        });
      }
      return;
    }

    session.droppedCount += 1;
    if (session.droppedCount % 25 === 0) {
      emitSttDebug({
        source: resolvedSource,
        level: 'error',
        event: 'chunk-dropped',
        message: 'Audio chunk dropped because WebSocket is not open',
        meta: {
          dropped: session.droppedCount,
          readyState: ws ? ws.readyState : 'no-ws'
        }
      });
    }
  }

  function stopSource(source) {
    const resolvedSource = normalizeSttSource(source);
    const session = getSession(resolvedSource);
    if (session.stopDrain) {
      return session.stopDrain.promise;
    }

    session.intentionalStop = true;
    clearReconnect(session);

    const ws = session.ws;
    const hasOutstandingCommits = (
      session.pendingCommits.length > 0
      || session.committedItems.size > 0
    );
    const hasBufferedAudio = session.bufferedBytesSinceCommit > 0;
    if (!hasOutstandingCommits && !hasBufferedAudio) {
      finishIntentionalStop(resolvedSource, ws ? 'stop-no-buffered-audio' : 'stop-noop');
      return Promise.resolve({ success: true });
    }

    let drain = null;
    try {
      drain = beginStopDrain(resolvedSource, ws);
      if (hasBufferedAudio) {
        if (!ws || ws.readyState !== WebSocket.OPEN) {
          throw new Error('OpenAI Realtime socket is unavailable during stop');
        }
        session.bufferedBytesSinceCommit = 0;
        sendAudioCommit(session, ws, drain);
      }
    } catch (error) {
      emitSttDebug({
        source: resolvedSource,
        level: 'error',
        event: 'stop-error',
        message: error.message
      });
      finishIntentionalStop(
        resolvedSource,
        'stop-error',
        { success: false, error: STOP_COMMIT_ERROR }
      );
    }

    return drain?.promise || Promise.resolve({ success: true });
  }

  async function stop({ source } = {}) {
    emitSttDebug({
      source: source === 'system' || source === 'mic' ? source : null,
      event: 'ipc-stop',
      message: `Stop requested for ${source || 'default'}`
    });

    if (source === 'all') {
      const results = await Promise.all([
        stopSource('mic'),
        stopSource('system')
      ]);
      return results.find((result) => result?.success === false) || { success: true };
    }

    return stopSource(source === 'system' ? 'system' : 'mic');
  }

  function dispose() {
    sttHistoryManager.flushAllSttHistoryBuffers('cleanup');
    resetSession('mic');
    resetSession('system');
    sttHistoryManager.dispose();
  }

  return {
    id: 'openai',
    sampleRate: OPENAI_SAMPLE_RATE,
    start,
    // Compatibility aliases used by older AssemblyAI wiring
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
        error: 'Batch transcribe-audio is not implemented for OpenAI Realtime STT.'
      };
    }
  };
}

module.exports = {
  createOpenAiRealtimeSttService
};
