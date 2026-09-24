'use strict';

const { createAssemblyAiService } = require('../assembly-ai/service');
const { createOpenAiRealtimeSttService } = require('./openai-realtime');
const { createPortkeyWhisperSttService } = require('./portkey-whisper');
const {
  getSttSampleRate,
  resolveSttProvider
} = require('./contract');

/**
 * Create an STT provider that implements the contract in ./contract.js.
 */
function createSttProvider(providerId, deps = {}) {
  const resolved = resolveSttProvider(providerId);

  if (resolved === 'openai') {
    return createOpenAiRealtimeSttService({
      WebSocket: deps.WebSocket,
      desktopCapturer: deps.desktopCapturer,
      getOpenaiApiKey: deps.getOpenaiApiKey,
      getPortkeyApiKey: deps.getPortkeyApiKey,
      getPortkeyRealtimeVirtualKey: deps.getPortkeyRealtimeVirtualKey,
      getOpenaiSttModel: deps.getOpenaiSttModel,
      getTranscriptionHints: deps.getTranscriptionHints,
      getGeminiService: deps.getGeminiService,
      sendToRenderer: deps.sendToRenderer
    });
  }

  if (resolved === 'portkey-whisper') {
    return createPortkeyWhisperSttService({
      desktopCapturer: deps.desktopCapturer,
      getPortkeyApiKey: deps.getPortkeyApiKey,
      getPortkeyWhisperProvider: deps.getPortkeyWhisperProvider,
      getGeminiService: deps.getGeminiService,
      sendToRenderer: deps.sendToRenderer
    });
  }

  const assembly = createAssemblyAiService({
    WebSocket: deps.WebSocket,
    desktopCapturer: deps.desktopCapturer,
    getAssemblyApiKey: deps.getAssemblyApiKey,
    getSpeechModel: deps.getSpeechModel,
    getGeminiService: deps.getGeminiService,
    sendToRenderer: deps.sendToRenderer
  });

  // Adapt AssemblyAI to the shared STT contract without moving its module.
  return {
    id: 'assemblyai',
    sampleRate: getSttSampleRate('assemblyai'),
    start: (source) => assembly.startAssemblyAiStream(source),
    startAssemblyAiStream: assembly.startAssemblyAiStream,
    handleAudioChunk: assembly.handleAudioChunk,
    stop: (payload) => assembly.stopVoiceRecognition(payload),
    stopVoiceRecognition: assembly.stopVoiceRecognition,
    dispose: assembly.dispose,
    emitSttDebug: assembly.emitSttDebug,
    flushAllSttHistoryBuffers: assembly.flushAllSttHistoryBuffers,
    resetSttHistoryBuffers: assembly.resetSttHistoryBuffers,
    getDesktopSources: assembly.getDesktopSources,
    transcribeAudio: assembly.transcribeAudio
  };
}

/**
 * Runtime wrapper that rebuilds the active provider when settings change.
 */
function createSttRuntime({
  getProviderId,
  createProviderDeps
}) {
  let activeProvider = null;
  let activeProviderId = null;

  function ensureProvider() {
    const nextId = resolveSttProvider(
      typeof getProviderId === 'function' ? getProviderId() : getProviderId
    );

    if (activeProvider && activeProviderId === nextId) {
      return activeProvider;
    }

    if (activeProvider) {
      try {
        activeProvider.dispose();
      } catch (error) {
        console.error('Failed to dispose previous STT provider:', error.message);
      }
    }

    activeProvider = createSttProvider(nextId, createProviderDeps());
    activeProviderId = nextId;
    return activeProvider;
  }

  function dispose() {
    if (activeProvider) {
      try {
        activeProvider.dispose();
      } catch (error) {
        console.error('Failed to dispose STT provider:', error.message);
      }
    }
    activeProvider = null;
    activeProviderId = null;
  }

  return {
    ensureProvider,
    getActiveProviderId: () => activeProviderId || resolveSttProvider(
      typeof getProviderId === 'function' ? getProviderId() : getProviderId
    ),
    getSampleRate: () => getSttSampleRate(
      activeProviderId || resolveSttProvider(
        typeof getProviderId === 'function' ? getProviderId() : getProviderId
      )
    ),
    start(source) {
      return ensureProvider().start(source);
    },
    startAssemblyAiStream(source) {
      return ensureProvider().start(source);
    },
    handleAudioChunk(payload) {
      return ensureProvider().handleAudioChunk(payload);
    },
    stop(payload) {
      if (!activeProvider) {
        return { success: true };
      }
      return activeProvider.stop(payload);
    },
    stopVoiceRecognition(payload) {
      return this.stop(payload);
    },
    dispose,
    emitSttDebug(...args) {
      return ensureProvider().emitSttDebug(...args);
    },
    flushAllSttHistoryBuffers(reason) {
      if (!activeProvider) return;
      return activeProvider.flushAllSttHistoryBuffers(reason);
    },
    resetSttHistoryBuffers() {
      if (!activeProvider) return;
      return activeProvider.resetSttHistoryBuffers();
    },
    getDesktopSources() {
      return ensureProvider().getDesktopSources();
    },
    transcribeAudio(base64Audio) {
      return ensureProvider().transcribeAudio(base64Audio);
    }
  };
}

module.exports = {
  createSttProvider,
  createSttRuntime
};
