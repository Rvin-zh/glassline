'use strict';

/**
 * STT provider contract (CommonJS).
 *
 * Every provider returned by the factory MUST expose:
 * - id: 'assemblyai' | 'openai' | 'portkey-whisper'
 * - sampleRate: number (Hz the renderer should target)
 * - start(source): { success: boolean, error?: string, sampleRate?: number, message?: string }
 * - handleAudioChunk({ source, data }): void
 * - stop({ source } = {}): { success: boolean } | Promise<{ success: boolean }>
 * - dispose(): void
 *
 * Shared operational helpers (also expected by main-process wiring):
 * - emitSttDebug(...)
 * - flushAllSttHistoryBuffers(reason)
 * - resetSttHistoryBuffers()
 * - getDesktopSources()
 * - transcribeAudio(base64Audio)  // optional; AssemblyAI implements batch upload
 *
 * Renderer event channel names are preserved for UI compatibility:
 * vosk-partial, vosk-final, vosk-status, vosk-error, vosk-stopped, stt-debug
 *
 * Canonical provider lists live in src/config.js; this module re-exports them
 * so STT adapters can import a single contract surface.
 */

const {
  getSttProviders,
  getDefaultSttProvider,
  isConfiguredSttProvider,
  resolveSttProvider,
  getOpenAiSttModels,
  getDefaultOpenAiSttModel,
  resolveOpenAiSttModel,
  getSttSampleRate,
  isRealtimeSttProvider,
  STT_SAMPLE_RATES
} = require('../../config');

const STT_PROVIDERS = getSttProviders();
const DEFAULT_STT_PROVIDER = getDefaultSttProvider();
const DEFAULT_OPENAI_STT_MODEL = getDefaultOpenAiSttModel();

function normalizeSttSource(source) {
  return source === 'system' ? 'system' : 'mic';
}

function getDefaultOpenaiSttModel() {
  return getDefaultOpenAiSttModel();
}

function resolveOpenaiSttModel(modelName) {
  return resolveOpenAiSttModel(modelName);
}

module.exports = {
  STT_PROVIDERS,
  DEFAULT_STT_PROVIDER,
  DEFAULT_OPENAI_STT_MODEL,
  STT_SAMPLE_RATES,
  normalizeSttSource,
  isConfiguredSttProvider,
  resolveSttProvider,
  getSttSampleRate,
  isRealtimeSttProvider,
  getSttProviders,
  getDefaultSttProvider,
  getDefaultOpenaiSttModel,
  resolveOpenaiSttModel,
  getOpenAiSttModels,
  getDefaultOpenAiSttModel,
  resolveOpenAiSttModel
};
