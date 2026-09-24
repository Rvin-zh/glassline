// AI provider configuration.
// Supported providers: 'gemini' and 'portkey'.
const AI_PROVIDERS = ['gemini', 'portkey'];
const DEFAULT_AI_PROVIDER = 'gemini';

// Prefer a Portkey integration slug that can reach Gemini 3.x (workspace-dependent).
// Plain "google" often fails when the linked Google API key is invalid; "@vertex" worked in our Fedora bench.
const DEFAULT_PORTKEY_PROVIDER = '@vertex';
const DEFAULT_PORTKEY_BASE_URL = '';

// Live-answer output format configuration.
const OUTPUT_FORMATS = Object.freeze(['quick', 'adaptive', 'detailed', 'custom']);
const OUTPUT_FORMAT_LABELS = Object.freeze({
  quick: 'Quick',
  adaptive: 'Adaptive',
  detailed: 'Detailed',
  custom: 'Custom'
});
const DEFAULT_OUTPUT_FORMAT = 'quick';
const MAX_CUSTOM_OUTPUT_TEMPLATE_CHARS = 4000;

// Gemini model configuration.
// The first model in this list is treated as the default model everywhere.
// gemini-3.8-flash primary / 3.7 fallback. Portkey@vertex bench (thinking=low):
// 3.7 slightly lower median TTFT; 3.8 tighter p95/mean — keep 3.8 as default.
const GEMINI_MODELS = [
  'gemini-3.8-flash',
  'gemini-3.7-flash',
  'gemini-3.5-flash-lite'
];
const DEFAULT_GEMINI_FALLBACK_MODEL = 'gemini-3.7-flash';

// Background memory / summarizer model (isolated from foreground default).
const GEMINI_MEMORY_MODEL = 'gemini-3.5-flash-lite';

// Thinking levels for Gemini 3.x family.
// Foreground 3.7/3.8 accept low|medium|high (not disabled).
// Memory model supports minimal.
const THINKING_LEVELS = ['minimal', 'low', 'medium', 'high'];
const DEFAULT_FOREGROUND_THINKING_LEVEL = 'low';
const DEFAULT_MEMORY_THINKING_LEVEL = 'minimal';

// AssemblyAI speech model configuration.
// The first model in this list is treated as the default model everywhere.
const ASSEMBLY_AI_SPEECH_MODELS = [
  'universal-streaming-english',
  'universal-streaming-multilingual'
];

// STT provider configuration (contract lives in src/services/stt/contract.js).
const STT_PROVIDERS = ['assemblyai', 'openai', 'portkey-whisper'];
const DEFAULT_STT_PROVIDER = 'assemblyai';
const OPENAI_STT_MODELS = ['gpt-live-transcribe'];
const DEFAULT_OPENAI_STT_MODEL = 'gpt-live-transcribe';
const PORTKEY_WHISPER_MODELS = ['whisper-1'];
const DEFAULT_PORTKEY_WHISPER_MODEL = 'whisper-1';
const STT_SAMPLE_RATES = Object.freeze({
  assemblyai: 16000,
  openai: 24000,
  'portkey-whisper': 16000
});

// Web search defaults (Phase 5).
const WEB_SEARCH_PROVIDERS = ['gemini', 'tavily'];
const DEFAULT_WEB_SEARCH_PROVIDER = 'gemini';

// Auto Screen interval configuration.
// Production values are deliberately bounded to control API cost and capture frequency.
const AUTO_SCREEN_INTERVAL_SECONDS = Object.freeze([5, 10, 15, 30]);
const DEFAULT_AUTO_SCREEN_INTERVAL_SECONDS = 10;

// Programming language configuration.
// The first language in this list is treated as the default language everywhere.
const PROGRAMMING_LANGUAGES = [
  'Python',
  'Java',
  'JavaScript',
  'TypeScript',
  'C++',
  'Go',
  'Rust',
  'C#',
  'Kotlin'
];

// Keyboard shortcuts configuration.
// Edit accelerators here to customize app shortcuts in one place.
const KEYBOARD_SHORTCUTS = [
  {
    id: 'toggleTranscription',
    buttonLabel: 'Transcription',
    description: 'Toggle transcription master control',
    accelerator: 'Alt+Shift+T'
  },
  {
    id: 'takeScreenshot',
    buttonLabel: 'Screenshot',
    description: 'Capture screenshot',
    accelerator: 'Alt+Shift+S'
  },
  {
    id: 'askAi',
    buttonLabel: 'Ask AI',
    description: 'Uses only enabled transcript, enabled screenshots, and enabled chat context',
    accelerator: 'Alt+Shift+A'
  },
  {
    id: 'screenAi',
    buttonLabel: 'Screen AI',
    description: 'Analyzes only enabled screenshots selected in chat',
    accelerator: 'Alt+Shift+E'
  },
  {
    id: 'suggest',
    buttonLabel: 'Suggest',
    description: 'Uses only enabled transcript context to produce glanceable response cues',
    accelerator: 'Alt+Shift+G'
  },
  {
    id: 'notes',
    buttonLabel: 'Notes',
    description: 'Generates notes from only enabled context',
    accelerator: 'Alt+Shift+N'
  },
  {
    id: 'insights',
    buttonLabel: 'Insights',
    description: 'Finds key insights from only enabled context',
    accelerator: 'Alt+Shift+I'
  },
  {
    id: 'clearChat',
    buttonLabel: 'Clear Chat',
    description: 'Clears chat, screenshots, and AI history',
    accelerator: 'Alt+Shift+C'
  },
  {
    id: 'emergencyHide',
    buttonLabel: 'Hide',
    description: 'Emergency hide',
    accelerator: 'Alt+Shift+X'
  },
  {
    id: 'toggleStealth',
    buttonLabel: 'Toggle Stealth',
    description: 'Toggle stealth mode',
    accelerator: 'Alt+Shift+H'
  },
  {
    id: 'moveWindowLeft',
    buttonLabel: 'Move Window Left',
    description: 'Move window to left side',
    accelerator: 'Alt+Shift+Left'
  },
  {
    id: 'moveWindowRight',
    buttonLabel: 'Move Window Right',
    description: 'Move window to right side',
    accelerator: 'Alt+Shift+Right'
  },
  {
    id: 'moveWindowUp',
    buttonLabel: 'Move Window Up',
    description: 'Move window to top',
    accelerator: 'Alt+Shift+Up'
  },
  {
    id: 'moveWindowDown',
    buttonLabel: 'Move Window Down',
    description: 'Move window to bottom',
    accelerator: 'Alt+Shift+Down'
  },
  {
    id: 'windowSizePreset1',
    buttonLabel: 'Size Preset 1',
    description: 'Resize window to minimum size',
    accelerator: 'Alt+Shift+1'
  },
  {
    id: 'windowSizePreset2',
    buttonLabel: 'Size Preset 2',
    description: 'Resize window to +25% from minimum size',
    accelerator: 'Alt+Shift+2'
  },
  {
    id: 'windowSizePreset3',
    buttonLabel: 'Size Preset 3',
    description: 'Resize window to +50% from minimum size',
    accelerator: 'Alt+Shift+3'
  },
  {
    id: 'windowSizePreset4',
    buttonLabel: 'Size Preset 4',
    description: 'Resize window to +75% from minimum size',
    accelerator: 'Alt+Shift+4'
  }
];

// AI provider configuration functions
function getAiProviders() {
  return [...AI_PROVIDERS];
}

function getDefaultAiProvider() {
  return DEFAULT_AI_PROVIDER;
}

function isConfiguredAiProvider(providerName) {
  return AI_PROVIDERS.includes(providerName);
}

function resolveAiProvider(providerName) {
  return isConfiguredAiProvider(providerName) ? providerName : DEFAULT_AI_PROVIDER;
}

function getDefaultPortkeyProvider() {
  return DEFAULT_PORTKEY_PROVIDER;
}

function getDefaultPortkeyBaseUrl() {
  return DEFAULT_PORTKEY_BASE_URL;
}

function getOutputFormats() {
  return [...OUTPUT_FORMATS];
}

function getOutputFormatLabels() {
  return { ...OUTPUT_FORMAT_LABELS };
}

function getDefaultOutputFormat() {
  return DEFAULT_OUTPUT_FORMAT;
}

function isConfiguredOutputFormat(value) {
  return typeof value === 'string' &&
    OUTPUT_FORMATS.includes(value.trim().toLowerCase());
}

function sanitizeOutputFormat(value) {
  if (!isConfiguredOutputFormat(value)) {
    return DEFAULT_OUTPUT_FORMAT;
  }
  return value.trim().toLowerCase();
}

function sanitizeCustomOutputTemplate(value) {
  if (typeof value !== 'string') {
    return '';
  }
  return value.trim().slice(0, MAX_CUSTOM_OUTPUT_TEMPLATE_CHARS);
}

function resolveOutputFormat(value, customOutputTemplate = '') {
  const outputFormat = sanitizeOutputFormat(value);
  if (
    outputFormat === 'custom' &&
    !sanitizeCustomOutputTemplate(customOutputTemplate)
  ) {
    return DEFAULT_OUTPUT_FORMAT;
  }
  return outputFormat;
}

// Gemini model configuration functions
function getGeminiModels() {
  if (!Array.isArray(GEMINI_MODELS) || GEMINI_MODELS.length === 0) {
    throw new Error('Gemini models are not configured. Add at least one model to src/config.js.');
  }

  return [...GEMINI_MODELS];
}

function getDefaultGeminiModel() {
  return getGeminiModels()[0];
}

function getDefaultGeminiFallbackModel() {
  return DEFAULT_GEMINI_FALLBACK_MODEL;
}

function getGeminiMemoryModel() {
  return GEMINI_MEMORY_MODEL;
}

function isConfiguredGeminiModel(modelName) {
  return getGeminiModels().includes(modelName);
}

function resolveGeminiModel(modelName) {
  return isConfiguredGeminiModel(modelName) ? modelName : getDefaultGeminiModel();
}

// Thinking level helpers
function getThinkingLevels() {
  return [...THINKING_LEVELS];
}

function isConfiguredThinkingLevel(levelName) {
  return THINKING_LEVELS.includes(String(levelName || '').trim().toLowerCase());
}

function resolveThinkingLevel(levelName, fallback = DEFAULT_FOREGROUND_THINKING_LEVEL) {
  const normalized = String(levelName || '').trim().toLowerCase();
  if (isConfiguredThinkingLevel(normalized)) {
    return normalized;
  }

  const normalizedFallback = String(fallback || '').trim().toLowerCase();
  if (isConfiguredThinkingLevel(normalizedFallback)) {
    return normalizedFallback;
  }

  return DEFAULT_FOREGROUND_THINKING_LEVEL;
}

function getDefaultForegroundThinkingLevel() {
  return DEFAULT_FOREGROUND_THINKING_LEVEL;
}

function getDefaultMemoryThinkingLevel() {
  return DEFAULT_MEMORY_THINKING_LEVEL;
}

/**
 * Map a thinking level string to the @google/genai ThinkingLevel enum value.
 * Returns uppercase enum-style values: MINIMAL | LOW | MEDIUM | HIGH.
 */
function thinkingLevelToGeminiApi(levelName) {
  const resolved = resolveThinkingLevel(levelName);
  return resolved.toUpperCase();
}

/**
 * Map a thinking level for Portkey Gemini routes (strictOpenAiCompliance: false).
 * Returns lowercase google-native thinking_level values.
 */
function thinkingLevelToPortkey(levelName) {
  return resolveThinkingLevel(levelName);
}

// Programming language configuration functions
function getProgrammingLanguages() {
  if (!Array.isArray(PROGRAMMING_LANGUAGES) || PROGRAMMING_LANGUAGES.length === 0) {
    throw new Error('Programming languages are not configured. Add at least one language to src/config.js.');
  }

  return [...PROGRAMMING_LANGUAGES];
}

function getDefaultProgrammingLanguage() {
  return getProgrammingLanguages()[0];
}

function isConfiguredProgrammingLanguage(languageName) {
  return getProgrammingLanguages().includes(languageName);
}

function resolveProgrammingLanguage(languageName) {
  return isConfiguredProgrammingLanguage(languageName)
    ? languageName
    : getDefaultProgrammingLanguage();
}

// AssemblyAI speech model configuration functions
function getAssemblyAiSpeechModels() {
  if (!Array.isArray(ASSEMBLY_AI_SPEECH_MODELS) || ASSEMBLY_AI_SPEECH_MODELS.length === 0) {
    throw new Error('AssemblyAI speech models are not configured. Add at least one model to src/config.js.');
  }

  return [...ASSEMBLY_AI_SPEECH_MODELS];
}

function getDefaultAssemblyAiSpeechModel() {
  return getAssemblyAiSpeechModels()[0];
}

function isConfiguredAssemblyAiSpeechModel(modelName) {
  return getAssemblyAiSpeechModels().includes(modelName);
}

function resolveAssemblyAiSpeechModel(modelName, fallbackModel = getDefaultAssemblyAiSpeechModel()) {
  if (isConfiguredAssemblyAiSpeechModel(modelName)) {
    return modelName;
  }

  if (isConfiguredAssemblyAiSpeechModel(fallbackModel)) {
    return fallbackModel;
  }

  return getDefaultAssemblyAiSpeechModel();
}

// STT provider hooks
function getSttProviders() {
  return [...STT_PROVIDERS];
}

function getDefaultSttProvider() {
  return DEFAULT_STT_PROVIDER;
}

function isConfiguredSttProvider(providerName) {
  return STT_PROVIDERS.includes(providerName);
}

function resolveSttProvider(providerName) {
  return isConfiguredSttProvider(providerName) ? providerName : DEFAULT_STT_PROVIDER;
}

function getOpenAiSttModels() {
  return [...OPENAI_STT_MODELS];
}

function getDefaultOpenAiSttModel() {
  return DEFAULT_OPENAI_STT_MODEL;
}

function resolveOpenAiSttModel(modelName) {
  const normalized = String(modelName || '').trim();
  return OPENAI_STT_MODELS.includes(normalized) ? normalized : DEFAULT_OPENAI_STT_MODEL;
}

function getSttSampleRate(providerName) {
  const resolved = resolveSttProvider(providerName);
  return STT_SAMPLE_RATES[resolved] || STT_SAMPLE_RATES[DEFAULT_STT_PROVIDER];
}

function isRealtimeSttProvider(providerName) {
  return resolveSttProvider(providerName) !== 'portkey-whisper';
}

function getPortkeyWhisperModels() {
  return [...PORTKEY_WHISPER_MODELS];
}

function getDefaultPortkeyWhisperModel() {
  return DEFAULT_PORTKEY_WHISPER_MODEL;
}

function getWebSearchProviders() {
  return [...WEB_SEARCH_PROVIDERS];
}

function getDefaultWebSearchProvider() {
  return DEFAULT_WEB_SEARCH_PROVIDER;
}

function resolveWebSearchProvider(providerName) {
  const normalized = String(providerName || '').trim().toLowerCase();
  return WEB_SEARCH_PROVIDERS.includes(normalized)
    ? normalized
    : DEFAULT_WEB_SEARCH_PROVIDER;
}

function getAutoScreenIntervalSeconds() {
  return [...AUTO_SCREEN_INTERVAL_SECONDS];
}

function getDefaultAutoScreenIntervalSeconds() {
  return DEFAULT_AUTO_SCREEN_INTERVAL_SECONDS;
}

function resolveAutoScreenIntervalSeconds(value) {
  const normalized = Number(value);
  return Number.isInteger(normalized) && AUTO_SCREEN_INTERVAL_SECONDS.includes(normalized)
    ? normalized
    : DEFAULT_AUTO_SCREEN_INTERVAL_SECONDS;
}

function resolveAutoScreenIntervalMilliseconds(value, environment = process.env) {
  const productionIntervalMs = resolveAutoScreenIntervalSeconds(value) * 1000;
  const fixtureEnabled =
    String(environment?.OPEN_CLUELY_E2E || '') === '1' &&
    String(environment?.OPEN_CLUELY_E2E_SCREENSHOT_FIXTURE || '') === '1';
  if (!fixtureEnabled) {
    return productionIntervalMs;
  }

  const e2eIntervalMs = Number(environment?.OPEN_CLUELY_E2E_AUTO_SCREEN_INTERVAL_MS);
  return Number.isInteger(e2eIntervalMs) && e2eIntervalMs > 0
    ? e2eIntervalMs
    : productionIntervalMs;
}

function getKeyboardShortcuts() {
  if (!Array.isArray(KEYBOARD_SHORTCUTS) || KEYBOARD_SHORTCUTS.length === 0) {
    throw new Error('Keyboard shortcuts are not configured. Add at least one shortcut to src/config.js.');
  }

  return KEYBOARD_SHORTCUTS.map((shortcut) => ({ ...shortcut }));
}

function getKeyboardShortcutById(shortcutId) {
  const normalizedId = String(shortcutId || '').trim();
  if (!normalizedId) {
    throw new Error('Shortcut id is required.');
  }

  const shortcut = getKeyboardShortcuts().find((entry) => entry.id === normalizedId);
  if (!shortcut) {
    throw new Error(`Shortcut "${normalizedId}" is not configured in src/config.js.`);
  }

  return shortcut;
}

function getKeyboardShortcutAccelerator(shortcutId) {
  const shortcut = getKeyboardShortcutById(shortcutId);
  const accelerator = String(shortcut.accelerator || '').trim();
  if (!accelerator) {
    throw new Error(`Shortcut "${shortcutId}" is missing an accelerator in src/config.js.`);
  }

  return accelerator;
}

module.exports = {
  getAiProviders,
  getDefaultAiProvider,
  getDefaultPortkeyProvider,
  getDefaultPortkeyBaseUrl,
  getOutputFormats,
  getOutputFormatLabels,
  getDefaultOutputFormat,
  isConfiguredOutputFormat,
  sanitizeOutputFormat,
  sanitizeCustomOutputTemplate,
  resolveOutputFormat,
  isConfiguredAiProvider,
  resolveAiProvider,
  getAssemblyAiSpeechModels,
  getDefaultAssemblyAiSpeechModel,
  getGeminiModels,
  getDefaultGeminiModel,
  getDefaultGeminiFallbackModel,
  getGeminiMemoryModel,
  getThinkingLevels,
  isConfiguredThinkingLevel,
  resolveThinkingLevel,
  getDefaultForegroundThinkingLevel,
  getDefaultMemoryThinkingLevel,
  thinkingLevelToGeminiApi,
  thinkingLevelToPortkey,
  getKeyboardShortcutAccelerator,
  getKeyboardShortcutById,
  getKeyboardShortcuts,
  getDefaultProgrammingLanguage,
  getProgrammingLanguages,
  isConfiguredAssemblyAiSpeechModel,
  isConfiguredGeminiModel,
  isConfiguredProgrammingLanguage,
  resolveAssemblyAiSpeechModel,
  resolveGeminiModel,
  resolveProgrammingLanguage,
  getSttProviders,
  getDefaultSttProvider,
  isConfiguredSttProvider,
  resolveSttProvider,
  getOpenAiSttModels,
  getDefaultOpenAiSttModel,
  resolveOpenAiSttModel,
  getSttSampleRate,
  isRealtimeSttProvider,
  STT_SAMPLE_RATES,
  getPortkeyWhisperModels,
  getDefaultPortkeyWhisperModel,
  getWebSearchProviders,
  getDefaultWebSearchProvider,
  resolveWebSearchProvider,
  getAutoScreenIntervalSeconds,
  getDefaultAutoScreenIntervalSeconds,
  resolveAutoScreenIntervalSeconds,
  resolveAutoScreenIntervalMilliseconds,
  MAX_CUSTOM_OUTPUT_TEMPLATE_CHARS,
  DEFAULT_GEMINI_FALLBACK_MODEL
};
