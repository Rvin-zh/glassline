/// <reference path="./renderer-globals.d.ts" />

import { createMessageStore } from './renderer/features/ai-context/message-store.js';
import { buildFilteredAiContextBundle as buildAiContextBundle } from './renderer/features/ai-context/context-bundle.js';
import { updateMessageAiToggleUi as syncMessageAiToggleUi } from './renderer/features/ai-context/toggle-ui.js';
import { createChatUiManager } from './renderer/features/chat/chat-ui-manager.js';
import { createWindowAdjustmentManager } from './renderer/features/layout/window-adjustments.js';
import { setupEventListeners as setupEventListenersModule } from './renderer/features/listeners/event-listeners.js';
import { setupIpcListeners as setupIpcListenersModule } from './renderer/features/listeners/ipc-listeners.js';
import { createAutoScreenController } from './renderer/features/auto-screen/auto-screen-controller.js';
import { createShortcutManager } from './renderer/features/settings/shortcut-manager.js';
import { createSettingsPanelManager } from './renderer/features/settings/settings-panel-manager.js';
import { createOutputFormatState } from './renderer/features/settings/output-format-state.js';
import { createTranscriptionManager } from './renderer/features/transcription/transcription-manager.js';

import {
    createTranscriptionSourceState,
    normalizeSource as normalizeAssemblySource,
    sourceLabel as resolveSourceLabel
} from './renderer/features/assembly-ai/source-state.js';
import { createAudioPipeline } from './renderer/features/assembly-ai/audio-pipeline.js';
import { createTranscriptBufferManager } from './renderer/features/assembly-ai/transcript-buffer.js';
// Renderer with AssemblyAI Streaming Transcription - Real-time & Accurate!
// Uses AssemblyAI WebSocket API for live speech-to-text

let screenshotsCount = 0;
let isAnalyzing = false;
let stealthHideTimeout = null;
const THEME_STORAGE_KEY = 'assistant-theme';
const THEME_LIGHT = 'light';
const THEME_DARK = 'dark';
let activeTheme = THEME_LIGHT;
const AI_CONTEXT_CHAR_BUDGET = 12000;
const messageStore = createMessageStore();
let chatMessagesArray = messageStore.getMessages();
const transcriptionSourceState = createTranscriptionSourceState();

// Source selection state (default: host/system on, mic off)
const selectedSources = transcriptionSourceState.selectedSources;

const audioPipeline = createAudioPipeline({
    sendAudioChunk: (source, audioBuffer) => {
        window.electronAPI.sendAudioChunk(source, audioBuffer);
    },
    addMonitorLog: (...args) => addMonitorLog(...args)
});

const transcriptBufferManager = createTranscriptBufferManager({
    mergeWindowMs: 3500,
    onBuffer: ({ source, text, segments }) => {
        addMonitorLog('info', 'final-buffer', 'Buffered transcript segment', source, {
            segments,
            chars: text.length
        });
    },
    onFlush: ({ source, text, reason, segments }) => {
        if (source === 'system') {
            addChatMessage('voice-system', text);
        } else {
            addChatMessage('voice-mic', text);
        }

        addMonitorLog('info', 'final-flush', 'Merged transcript committed', source, {
            reason,
            segments,
            chars: text.length
        });
        showFeedback('Captured', 'success');
    }
});


// DOM elements
const statusText = document.getElementById('status-text');
const screenshotCount = document.getElementById('screenshot-count');
const resultsPanel = document.getElementById('results-panel');
const resultText = document.getElementById('result-text');
const loadingOverlay = document.getElementById('loading-overlay');
const emergencyOverlay = document.getElementById('emergency-overlay');
const chatContainer = document.getElementById('chat-container');
const chatMessagesElement = document.getElementById('chat-messages');
const chatComposer = document.getElementById('chat-composer');
const chatManualInput = document.getElementById('chat-manual-input');
const chatManualSend = document.getElementById('chat-manual-send');
const chatAutoScrollToggle = document.getElementById('chat-autoscroll-toggle');

const AUTOSCROLL_STORAGE_KEY = 'open-cluely.autoScrollEnabled';
let autoScrollEnabledState = (() => {
    try {
        const raw = localStorage.getItem(AUTOSCROLL_STORAGE_KEY);
        if (raw === null) return true;
        return raw === '1';
    } catch (_) {
        return true;
    }
})();
function isAutoScrollEnabled() { return autoScrollEnabledState; }
function setAutoScrollEnabled(value) {
    autoScrollEnabledState = !!value;
    try { localStorage.setItem(AUTOSCROLL_STORAGE_KEY, autoScrollEnabledState ? '1' : '0'); } catch (_) {}
    paintAutoScrollToggle();
}
function paintAutoScrollToggle() {
    if (!chatAutoScrollToggle) return;
    const enabled = autoScrollEnabledState;
    chatAutoScrollToggle.setAttribute('aria-pressed', enabled ? 'true' : 'false');
    chatAutoScrollToggle.classList.toggle('off', !enabled);
    chatAutoScrollToggle.title = enabled ? 'Auto-scroll on (click to disable)' : 'Auto-scroll off (click to enable)';
}

const mobileServerPill = document.getElementById('mobile-server-pill');
const mobileServerPillLabel = document.getElementById('mobile-server-pill-label');
const autoScreenToggle = document.getElementById('auto-screen-toggle');
const outputFormatSelect = document.getElementById('output-format-select');
let mobileServerStatus = { listening: false, port: 7823, urls: [], clientCount: 0, error: null };

function paintMobileServerPill() {
    if (!mobileServerPill || !mobileServerPillLabel) return;

    mobileServerPill.classList.remove('off', 'idle', 'connected');

    if (!mobileServerStatus.listening) {
        mobileServerPill.classList.add('off');
        mobileServerPillLabel.textContent = mobileServerStatus.error ? 'Mobile · error' : 'Mobile · off';
        mobileServerPill.title = mobileServerStatus.error
            ? `Mobile companion not running: ${mobileServerStatus.error}`
            : 'Mobile companion not running';
        return;
    }

    const firstReal = mobileServerStatus.urls.find((u) => !u.virtual) || mobileServerStatus.urls[0];
    const firstUrl = firstReal?.url;
    const count = mobileServerStatus.clientCount || 0;
    mobileServerPill.classList.add(count > 0 ? 'connected' : 'idle');

    if (firstUrl) {
        mobileServerPillLabel.textContent = firstUrl.replace(/^http:\/\//, '') + (count > 0 ? ` · ${count}` : '');
    } else {
        mobileServerPillLabel.textContent = `:${mobileServerStatus.port}` + (count > 0 ? ` · ${count}` : ' · no LAN');
    }

    const lines = [
        count > 0
            ? `Mobile companion: ${count} client(s) connected`
            : 'Mobile companion listening (no clients yet — click for help)',
        ...mobileServerStatus.urls.map(({ url, name, virtual }) => virtual
            ? `${url}  (${name}) — virtual adapter, phone probably cannot reach this`
            : `${url}  (${name})`
        )
    ];
    if (mobileServerStatus.urls.length === 0) {
        lines.push('No non-loopback IPv4 interface detected.');
    }
    if (mobileServerStatus.urls.some((u) => u.virtual) && mobileServerStatus.urls.some((u) => !u.virtual)) {
        lines.push('Use the first non-virtual URL on the phone.');
    }
    lines.push('');
    lines.push('Click to copy URL. If the phone times out, run this once in elevated PowerShell:');
    lines.push('  New-NetFirewallRule -DisplayName "Open-Cluely Mobile" -Direction Inbound -LocalPort 7823 -Protocol TCP -Action Allow -Profile Any');
    mobileServerPill.title = lines.join('\n');
}

function copyMobileUrlPickReal() {
    return mobileServerStatus.urls.find((u) => !u.virtual)?.url || mobileServerStatus.urls[0]?.url;
}

async function copyMobileUrlToClipboard() {
    const url = copyMobileUrlPickReal();
    if (!url) {
        showFeedback('Mobile server has no LAN URL yet', 'error');
        return;
    }
    try {
        await navigator.clipboard.writeText(url);
        showFeedback(`Copied ${url}`, 'success');
    } catch (err) {
        showFeedback('Could not copy URL', 'error');
    }
}
const transcriptionToggle = document.getElementById('transcription-toggle');
const sourceSystemToggle = document.getElementById('source-system-toggle');
const sourceMicToggle = document.getElementById('source-mic-toggle');
const monitorMasterState = document.getElementById('monitor-master-state');
const monitorStatusSystem = document.getElementById('monitor-status-system');
const monitorStatusMic = document.getElementById('monitor-status-mic');
const monitorLiveSystem = document.getElementById('monitor-live-system');
const monitorLiveMic = document.getElementById('monitor-live-mic');
const monitorLogList = document.getElementById('monitor-log-list');
const windowResizeHandles = document.querySelectorAll('[data-resize-handle]');
const windowDragHandle = document.querySelector('.drag-handle');

const screenshotBtn = document.getElementById('screenshot-btn');
const analyzeBtn = document.getElementById('analyze-btn');
const screenAiBtn = document.getElementById('screen-ai-btn');
const clearBtn = document.getElementById('clear-btn');
const hideBtn = document.getElementById('hide-btn');
const closeResultsBtn = document.getElementById('close-results');
const closeAppBtn = document.getElementById('close-app-btn');
const closeConfirmationDialog = document.getElementById('close-confirmation-dialog');
const cancelCloseBtn = document.getElementById('cancel-close-btn');
const confirmCloseBtn = document.getElementById('confirm-close-btn');

// New Cluely-style buttons
const suggestBtn = document.getElementById('suggest-btn');
const notesBtn = document.getElementById('notes-btn');
const insightsBtn = document.getElementById('insights-btn');
const themeToggleBtn = document.getElementById('theme-toggle-btn');

// Settings elements
const settingsBtn = document.getElementById('settings-btn');
const settingsPanel = document.getElementById('settings-panel');
const closeSettingsBtn = document.getElementById('close-settings');
const saveSettingsBtn = document.getElementById('save-settings-btn');
const settingAiProvider = document.getElementById('setting-ai-provider');
const geminiSettingsGroup = document.getElementById('gemini-settings-group');
const portkeySettingsGroup = document.getElementById('portkey-settings-group');
const settingGeminiKey = document.getElementById('setting-gemini-key');
const toggleGeminiKeyVisibilityBtn = document.getElementById('toggle-gemini-key-visibility');
const settingGeminiModel = document.getElementById('setting-gemini-model');
const settingPortkeyKey = document.getElementById('setting-portkey-key');
const togglePortkeyKeyVisibilityBtn = document.getElementById('toggle-portkey-key-visibility');
const settingPortkeyProvider = document.getElementById('setting-portkey-provider');
const settingPortkeyBaseUrl = document.getElementById('setting-portkey-base-url');
const settingPortkeyModel = document.getElementById('setting-portkey-model');
const settingProgrammingLanguage = document.getElementById('setting-programming-language');
const settingAutoScreenInterval = document.getElementById('setting-auto-screen-interval');
const settingWebSearchEnabled = document.getElementById('setting-web-search-enabled');
const settingRequestWebSearchEnabled = document.getElementById('setting-request-web-search-enabled');
const settingWebSearchProvider = document.getElementById('setting-web-search-provider');
const settingTavilyKey = document.getElementById('setting-tavily-key');
const toggleTavilyKeyVisibilityBtn = document.getElementById('toggle-tavily-key-visibility');
const settingPromptCacheEnabled = document.getElementById('setting-prompt-cache-enabled');
const settingResumePaste = document.getElementById('setting-resume-paste');
const settingJobPaste = document.getElementById('setting-job-paste');
const settingResumeEnabled = document.getElementById('setting-resume-enabled');
const settingJobEnabled = document.getElementById('setting-job-enabled');
const pickResumeFileBtn = document.getElementById('pick-resume-file-btn');
const pickJobFileBtn = document.getElementById('pick-job-file-btn');
const saveResumePasteBtn = document.getElementById('save-resume-paste-btn');
const saveJobPasteBtn = document.getElementById('save-job-paste-btn');
const resumeDocStatus = document.getElementById('resume-doc-status');
const jobDocStatus = document.getElementById('job-doc-status');
const durableNotesReviewList = document.getElementById('durable-notes-review-list');
const previousInterviewsList = document.getElementById('previous-interviews-list');
const clearPreviousInterviewsBtn = document.getElementById('clear-previous-interviews-btn');
const clearSessionMemoryBtn = document.getElementById('clear-session-memory-btn');
const clearDocumentsBtn = document.getElementById('clear-documents-btn');
const clearDurableNotesBtn = document.getElementById('clear-durable-notes-btn');
const settingsDiagnostics = document.getElementById('settings-diagnostics');
const refreshDiagnosticsBtn = document.getElementById('refresh-diagnostics-btn');
const settingAssemblyKey = document.getElementById('setting-assembly-key');
const toggleAssemblyKeyVisibilityBtn = document.getElementById('toggle-assembly-key-visibility');
const settingAssemblyModel = document.getElementById('setting-assembly-model');
const settingWindowOpacity = document.getElementById('setting-window-opacity');
const settingWindowOpacityValue = document.getElementById('setting-window-opacity-value');
const settingHideFromScreenCapture = document.getElementById('setting-hide-from-screen-capture');
const settingHideFromScreenCaptureHelp = document.getElementById('setting-hide-from-screen-capture-help');
const settingsShortcutsList = document.getElementById('settings-shortcuts-list');

// Timer
let startTime = Date.now();
let timerInterval;
const MIN_WINDOW_WIDTH = 600;
const MIN_WINDOW_HEIGHT = 380;
const MAX_CHAT_INPUT_HEIGHT = 88;

let isCloseConfirmationOpen = false;
let hasGeminiApiKeysConfigured = false;
let hasAssemblyAiApiKeyConfigured = false;
let hasOpenaiApiKeyConfigured = false;
let hasPortkeyApiKeyConfigured = false;
let activeAiProvider = 'gemini';
let activeSttProvider = 'assemblyai';
let requestWebSearchEnabled = false;
let autoScreenIntervalSeconds = 10;
let autoScreenIntervalMs = 10_000;
let activeAiActionId = null;
const aiActionInFlightState = {
    askAi: false,
    screenAi: false,
    suggest: false,
    notes: false,
    insights: false
};
const autoScreenController = createAutoScreenController({
    captureScreenshot: (origin) => captureScreenshotForAnalysis(origin),
    analyzeScreenshot: ({ screenshotIds, origin }) => (
        analyzeScreenshotsUnlocked({ screenshotIds, origin })
    ),
    isAiAvailable: () => hasGeminiApiKeysConfigured,
    isBusy: () => isAnyAiActionInFlight(),
    runExclusive: (actionId, action) => runAiActionWithLock(actionId, action),
    getIntervalMs: () => autoScreenIntervalMs,
    onStateChange: () => {
        updateAutoScreenUi();
        updateUI();
    },
    onAutoDisabled: (details) => handleAutoScreenDisabled(details)
});
const shortcutManager = createShortcutManager({ settingsShortcutsList });
const outputFormatState = createOutputFormatState({
    toolbarSelect: outputFormatSelect
});
const windowAdjustmentManager = createWindowAdjustmentManager({
    windowResizeHandles,
    windowDragHandle,
    chatContainer,
    minWindowWidth: MIN_WINDOW_WIDTH,
    minWindowHeight: MIN_WINDOW_HEIGHT,
    onViewportResize: () => {
        autoResizeManualInput();
    }
});
const chatUiManager = createChatUiManager({
    chatContainer,
    chatMessagesElement,
    chatComposer,
    chatManualInput,
    chatManualSend,
    messageStore,
    maxChatInputHeight: MAX_CHAT_INPUT_HEIGHT,
    escapeHtml: (value) => escapeHtml(value),
    updateUi: () => updateUI(),
    onMessagesChanged: (messages) => {
        chatMessagesArray = messages;
    },
    showFeedback: (message, type) => showFeedback(message, type),
    addMonitorLog: (...args) => addMonitorLog(...args),
    onManualMessageSubmitted: () => askAiWithSessionContext(),
    isAutoScrollEnabled
});
const settingsPanelManager = createSettingsPanelManager({
    settingsPanel,
    settingAiProvider,
    geminiSettingsGroup,
    portkeySettingsGroup,
    settingGeminiKey,
    toggleGeminiKeyVisibilityBtn,
    settingGeminiModel,
    settingPortkeyKey,
    togglePortkeyKeyVisibilityBtn,
    settingPortkeyProvider,
    settingPortkeyBaseUrl,
    settingPortkeyModel,
    settingProgrammingLanguage,
    settingAutoScreenInterval,
    settingAssemblyKey,
    toggleAssemblyKeyVisibilityBtn,
    settingAssemblyModel,
    settingWindowOpacity,
    settingWindowOpacityValue,
    settingHideFromScreenCapture,
    settingHideFromScreenCaptureHelp,
    settingWebSearchEnabled,
    settingRequestWebSearchEnabled,
    settingWebSearchProvider,
    settingTavilyKey,
    toggleTavilyKeyVisibilityBtn,
    settingPromptCacheEnabled,
    settingResumePaste,
    settingJobPaste,
    settingResumeEnabled,
    settingJobEnabled,
    pickResumeFileBtn,
    pickJobFileBtn,
    saveResumePasteBtn,
    saveJobPasteBtn,
    resumeDocStatus,
    jobDocStatus,
    durableNotesReviewList,
    previousInterviewsList,
    clearPreviousInterviewsBtn,
    clearSessionMemoryBtn,
    clearDocumentsBtn,
    clearDurableNotesBtn,
    settingsDiagnostics,
    refreshDiagnosticsBtn,
    applySettingsShortcutConfig: (settings) => applySettingsShortcutConfig(settings),
    showFeedback: (message, type) => showFeedback(message, type),
    onSettingsSaved: (settings) => {
        applyApiKeyAvailabilityFromSettings(settings);
        requestWebSearchEnabled = settings?.requestWebSearchEnabled === true;
        applyAutoScreenSettings(settings);
        outputFormatState.applySavedSettings(settings);
        updateUI();
    }
});
const transcriptionManager = createTranscriptionManager({
    transcriptionSourceState,
    normalizeSourceRule: normalizeAssemblySource,
    sourceLabelRule: resolveSourceLabel,
    audioPipeline,
    transcriptBufferManager,
    chatMessagesElement,
    transcriptionToggle,
    sourceSystemToggle,
    sourceMicToggle,
    monitorMasterState,
    monitorStatusSystem,
    monitorStatusMic,
    monitorLiveSystem,
    monitorLiveMic,
    monitorLogList,
    addChatMessage: (type, content, options) => addChatMessage(type, content, options),
    showFeedback: (message, type) => showFeedback(message, type),
    isAutoScrollEnabled,
    isChatNearBottom: () => chatUiManager.isChatNearBottom()
});

// Initialize
async function init() {
    console.log('Initializing renderer with Vosk Live Transcription...');

    if (typeof window.electronAPI !== 'undefined') {
        console.log('electronAPI is available');
    } else {
        console.error('electronAPI not available');
        showFeedback('electronAPI not available', 'error');
    }

    const settings = await loadShortcutConfig();
    setupEventListeners();
    setupIpcListeners();
    setupWindowAdjustments();
    const externalLayerSelect = document.getElementById('external-layer-select');
    if (externalLayerSelect) {
        externalLayerSelect.addEventListener('change', async () => {
            const layerId = externalLayerSelect.value;
            if (!window.electronAPI?.chooseExternalLayer) {
                return;
            }
            const result = await window.electronAPI.chooseExternalLayer(layerId);
            if (result?.external) {
                showFeedback('Folio opened as an external layer', 'info');
            }
            if (result && result.ok === false) {
                showFeedback(result.error || 'Could not open that layer', 'error');
            }
        });
    }
    if (chatAutoScrollToggle) {
        chatAutoScrollToggle.addEventListener('click', () => setAutoScrollEnabled(!autoScrollEnabledState));
        paintAutoScrollToggle();
    }
    if (window.electronAPI?.onClearFromMobile) {
        window.electronAPI.onClearFromMobile(() => {
            autoScreenController.disableAutoScreen('clear-from-mobile');
            screenshotsCount = 0;
            messageStore.clear();
            chatMessagesArray = messageStore.getMessages();
            chatMessagesElement.innerHTML = '';
            updateUI();
            showFeedback('Cleared from mobile', 'info');
        });
    }
    if (mobileServerPill) {
        mobileServerPill.addEventListener('click', copyMobileUrlToClipboard);
        paintMobileServerPill();
        if (window.electronAPI?.onMobileServerStatus) {
            window.electronAPI.onMobileServerStatus((data) => {
                mobileServerStatus = { ...mobileServerStatus, ...(data || {}) };
                paintMobileServerPill();
            });
        }
        if (window.electronAPI?.getMobileServerStatus) {
            window.electronAPI.getMobileServerStatus().then((data) => {
                if (data && typeof data === 'object') {
                    mobileServerStatus = { ...mobileServerStatus, ...data };
                    paintMobileServerPill();
                }
            }).catch(() => {});
        }
    }
    applyTheme(resolveInitialThemePreference(settings), { persist: false });
    updateAutoScreenUi();
    updateUI();
    transcriptionManager.updateTranscriptionUI();
    transcriptionManager.renderMonitorState();
    startTimer();

    document.body.style.visibility = 'visible';
    document.body.style.display = 'block';
    const app = document.getElementById('app');
    if (app) {
        app.style.visibility = 'visible';
        app.style.display = 'flex';
    }

    console.log('Renderer initialized - Ready for live transcription!');
    showFeedback('Ready - click transcription to start', 'success');
    addMonitorLog('info', 'init', 'Renderer initialized');
    addMonitorLog('info', 'source-defaults', 'Default sources: Host on, Mic on');
}

function updateWindowOpacityValueLabel(value) {
    settingsPanelManager.updateWindowOpacityValueLabel(value);
}

function parseThemePreference(theme) {
    return theme === THEME_DARK || theme === THEME_LIGHT ? theme : null;
}

function normalizeTheme(theme) {
    return theme === THEME_DARK ? THEME_DARK : THEME_LIGHT;
}

function loadStoredThemePreference() {
    try {
        const savedTheme = window.localStorage?.getItem(THEME_STORAGE_KEY) || '';
        return parseThemePreference(savedTheme) || THEME_LIGHT;
    } catch (error) {
        console.warn('Failed to read saved theme preference:', error);
        return THEME_LIGHT;
    }
}

function resolveInitialThemePreference(settings) {
    const settingsTheme = parseThemePreference(String(settings?.themePreference || '').trim().toLowerCase());
    if (settingsTheme) {
        saveThemePreference(settingsTheme);
        return settingsTheme;
    }

    return loadStoredThemePreference();
}

function saveThemePreference(theme) {
    try {
        window.localStorage?.setItem(THEME_STORAGE_KEY, normalizeTheme(theme));
    } catch (error) {
        console.warn('Failed to save theme preference:', error);
    }
}

function persistThemePreference(theme) {
    const normalizedTheme = normalizeTheme(theme);
    saveThemePreference(normalizedTheme);

    const setThemePreference = window.electronAPI?.setThemePreference;
    if (typeof setThemePreference === 'function') {
        setThemePreference(normalizedTheme).catch((error) => {
            console.warn('Failed to persist theme preference to app state:', error);
        });
    }
}

function updateThemeToggleUi() {
    if (!themeToggleBtn) {
        return;
    }

    const isDarkMode = activeTheme === THEME_DARK;
    const nextThemeLabel = isDarkMode ? 'light' : 'dark';
    const ariaLabel = `Switch to ${nextThemeLabel} mode`;

    themeToggleBtn.classList.toggle('is-dark', isDarkMode);
    themeToggleBtn.setAttribute('aria-pressed', isDarkMode ? 'true' : 'false');
    themeToggleBtn.setAttribute('aria-label', ariaLabel);
    themeToggleBtn.removeAttribute('title');
}

function applyTheme(theme, options = {}) {
    const { persist = true, announce = false } = options;
    activeTheme = normalizeTheme(theme);

    document.body.classList.toggle('theme-dark', activeTheme === THEME_DARK);
    document.documentElement.setAttribute('data-theme', activeTheme);
    updateThemeToggleUi();

    if (persist) {
        persistThemePreference(activeTheme);
    }

    if (announce) {
        showFeedback(activeTheme === THEME_DARK ? 'Dark mode enabled' : 'Light mode enabled', 'info');
    }
}

function toggleThemeMode() {
    const nextTheme = activeTheme === THEME_DARK ? THEME_LIGHT : THEME_DARK;
    applyTheme(nextTheme, { persist: true, announce: true });
}

function applySettingsShortcutConfig(settings) {
    shortcutManager.applySettingsShortcutConfig(settings);
}

function isShortcutPressed(event, shortcutId) {
    return shortcutManager.isShortcutPressed(event, shortcutId);
}

function isAiActionInFlight(actionId) {
    return Boolean(aiActionInFlightState[actionId]);
}

function isAnyAiActionInFlight() {
    return activeAiActionId !== null;
}

function setAiActionInFlight(actionId, inFlight) {
    if (!Object.prototype.hasOwnProperty.call(aiActionInFlightState, actionId)) {
        return;
    }

    const nextValue = Boolean(inFlight);
    if (aiActionInFlightState[actionId] === nextValue) {
        return;
    }

    aiActionInFlightState[actionId] = nextValue;
    updateUI();
}

async function runAiActionWithLock(actionId, action) {
    if (isAnyAiActionInFlight()) {
        return {
            acquired: false,
            busyActionId: activeAiActionId
        };
    }

    activeAiActionId = actionId;
    setAiActionInFlight(actionId, true);
    try {
        return {
            acquired: true,
            value: await action()
        };
    } finally {
        setAiActionInFlight(actionId, false);
        if (activeAiActionId === actionId) {
            activeAiActionId = null;
        }
        updateUI();
    }
}

let activeScreenAiStream = null;

function createStreamHandler(actionId) {
    let accumulatedText = '';
    let messageRecord = null;
    let removeChunkListener = null;
    let loadingHidden = false;

    function start(headingPrefix) {
        accumulatedText = headingPrefix || '';
        messageRecord = addChatMessage('ai-response', accumulatedText || '...');

        removeChunkListener = window.electronAPI.onAiStreamChunk((data) => {
            if (data.actionId !== actionId) return;
            accumulatedText += data.text;
            if (messageRecord) {
                chatUiManager.updateChatMessageContent(messageRecord.id, accumulatedText);
            }
            if (!loadingHidden) {
                loadingHidden = true;
                hideLoadingOverlay();
            }
        });

        return messageRecord;
    }

    function finalize(finalText) {
        if (finalText && messageRecord) {
            chatUiManager.updateChatMessageContent(messageRecord.id, finalText);
        }
    }

    function cleanup() {
        if (removeChunkListener) {
            removeChunkListener();
            removeChunkListener = null;
        }
    }

    return { start, finalize, cleanup };
}

function hasConfiguredGeminiApiKeys(value) {
    const keys = String(value ?? '')
        .split(',')
        .map((entry) => entry.trim())
        .filter(Boolean);
    return keys.length > 0;
}

function hasConfiguredAssemblyAiApiKey(value) {
    return String(value ?? '').trim().length > 0;
}

function applyApiKeyAvailabilityFromSettings(settings) {
    if (!settings || typeof settings !== 'object') {
        hasGeminiApiKeysConfigured = false;
        hasAssemblyAiApiKeyConfigured = false;
        hasOpenaiApiKeyConfigured = false;
        hasPortkeyApiKeyConfigured = false;
        activeAiProvider = 'gemini';
        activeSttProvider = 'assemblyai';
        return;
    }

    activeAiProvider = ['gemini', 'portkey'].includes(settings.aiProvider)
        ? settings.aiProvider
        : 'gemini';
    activeSttProvider = String(settings.sttProvider || 'assemblyai').trim().toLowerCase() || 'assemblyai';

    if (typeof settings.isAiReady === 'boolean') {
        hasGeminiApiKeysConfigured = settings.isAiReady;
    } else if (settings.aiProvider === 'portkey') {
        if (typeof settings.hasPortkeyApiKey === 'boolean') {
            hasGeminiApiKeysConfigured = settings.hasPortkeyApiKey;
        } else {
            hasGeminiApiKeysConfigured = Boolean(String(settings.portkeyApiKey || '').trim());
        }
    } else if (typeof settings.hasGeminiApiKeys === 'boolean') {
        hasGeminiApiKeysConfigured = settings.hasGeminiApiKeys;
    } else {
        hasGeminiApiKeysConfigured = hasConfiguredGeminiApiKeys(settings.geminiApiKey);
    }

    if (typeof settings.hasAssemblyAiApiKey === 'boolean') {
        hasAssemblyAiApiKeyConfigured = settings.hasAssemblyAiApiKey;
    } else {
        hasAssemblyAiApiKeyConfigured = hasConfiguredAssemblyAiApiKey(settings.assemblyAiApiKey);
    }

    if (typeof settings.hasOpenaiApiKey === 'boolean') {
        hasOpenaiApiKeyConfigured = settings.hasOpenaiApiKey;
    } else {
        hasOpenaiApiKeyConfigured = Boolean(String(settings.openaiApiKey || '').trim());
    }

    if (typeof settings.hasPortkeyApiKey === 'boolean') {
        hasPortkeyApiKeyConfigured = settings.hasPortkeyApiKey;
    } else {
        hasPortkeyApiKeyConfigured = Boolean(String(settings.portkeyApiKey || '').trim());
    }
}

function applyAutoScreenSettings(settings) {
    const allowedIntervals = [5, 10, 15, 30];
    const requestedSeconds = Number(settings?.autoScreenIntervalSeconds);
    const nextSeconds = allowedIntervals.includes(requestedSeconds)
        ? requestedSeconds
        : 10;
    const requestedMilliseconds = Number(settings?.autoScreenIntervalMs);
    const nextMilliseconds =
        Number.isFinite(requestedMilliseconds) && requestedMilliseconds > 0
            ? requestedMilliseconds
            : nextSeconds * 1000;
    const changed =
        nextSeconds !== autoScreenIntervalSeconds ||
        nextMilliseconds !== autoScreenIntervalMs;

    autoScreenIntervalSeconds = nextSeconds;
    autoScreenIntervalMs = nextMilliseconds;
    if (changed) {
        autoScreenController.refreshInterval();
    }
    updateAutoScreenUi();
}

function updateAutoScreenUi() {
    if (!autoScreenToggle) {
        return;
    }

    const state = autoScreenController.getState();
    const enabled = state.enabled === true;
    autoScreenToggle.classList.toggle('active', enabled);
    autoScreenToggle.classList.toggle('running', state.running === true);
    autoScreenToggle.setAttribute('aria-pressed', enabled ? 'true' : 'false');
    autoScreenToggle.setAttribute(
        'aria-label',
        enabled ? 'Disable Auto Screen' : 'Enable Auto Screen'
    );
    if (!hasGeminiApiKeysConfigured && !enabled) {
        autoScreenToggle.title =
            'Configure an AI provider in Settings before enabling Auto Screen';
    } else if (state.running) {
        autoScreenToggle.title =
            `Auto Screen is capturing and analyzing; next cycle starts ${autoScreenIntervalSeconds}s after completion`;
    } else {
        autoScreenToggle.title = enabled
            ? `Auto Screen on · every ${autoScreenIntervalSeconds}s after each analysis`
            : `Enable Auto Screen · every ${autoScreenIntervalSeconds}s`;
    }
}

function handleAutoScreenDisabled(details = {}) {
    const message = details.reason === 'fatal'
        ? 'Auto Screen turned off because AI is unavailable. Configure an AI provider in Settings, then try again.'
        : 'Auto Screen turned off after 3 consecutive failures. Check screenshot permissions and AI Settings, then try again.';
    showFeedback(message, 'error');
    addChatMessage('system', message);
    addMonitorLog('error', 'auto-screen-disabled', message, null, {
        reason: details.reason || 'unknown',
        consecutiveFailures: Number(details.consecutiveFailures || 0)
    });
    updateAutoScreenUi();
}

async function toggleAutoScreen() {
    if (autoScreenController.getState().enabled) {
        autoScreenController.disableAutoScreen('user');
        showFeedback('Auto Screen off', 'info');
        updateAutoScreenUi();
        return;
    }

    showFeedback(
        `Auto Screen on · next cycles run ${autoScreenIntervalSeconds}s after each analysis`,
        'info'
    );
    await autoScreenController.enableAutoScreen();
}

function isSttReady() {
    if (activeSttProvider === 'openai') {
        return hasOpenaiApiKeyConfigured || hasPortkeyApiKeyConfigured;
    }
    if (activeSttProvider === 'portkey-whisper') {
        return hasPortkeyApiKeyConfigured;
    }
    return hasAssemblyAiApiKeyConfigured;
}

async function loadShortcutConfig() {
    if (!window.electronAPI?.getSettings) {
        applyApiKeyAvailabilityFromSettings(null);
        return null;
    }

    try {
        const settings = await window.electronAPI.getSettings();
        applySettingsShortcutConfig(settings);
        applyApiKeyAvailabilityFromSettings(settings);
        requestWebSearchEnabled = settings?.requestWebSearchEnabled === true;
        applyAutoScreenSettings(settings);
        outputFormatState.initializeFromSettings(settings);
        return settings;
    } catch (error) {
        console.error('Failed to load shortcut config:', error);
        applyApiKeyAvailabilityFromSettings(null);
        return null;
    }
}

function setupWindowAdjustments() {
    windowAdjustmentManager.setupWindowAdjustments();
}

function escapeHtml(value) {
    return String(value || '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

function isMessageIncludedForAi(message) {
    return messageStore.isIncludedForAi(message);
}

function buildFilteredAiContextBundle({ charBudget = AI_CONTEXT_CHAR_BUDGET, emitTruncationLog = true } = {}) {
    return buildAiContextBundle({
        messages: chatMessagesArray,
        isMessageIncludedForAi,
        charBudget,
        emitTruncationLog,
        onTruncationLog: (dropped, budget) => {
            addMonitorLog(
                'info',
                'context-cap',
                `Trimmed ${dropped} older context message(s) to stay within ${budget} chars`
            );
        }
    });
}

function updateMessageAiToggleUi(message) {
    syncMessageAiToggleUi(chatMessagesElement, message);
}

function toggleChatMessageInclusion(messageId) {
    const message = messageStore.toggleInclusion(messageId);
    if (!message) return;

    chatMessagesArray = messageStore.getMessages();
    updateMessageAiToggleUi(message);
    updateUI();

    const stateText = message.includeInAi ? 'included in' : 'excluded from';
    addMonitorLog('info', 'ai-context-toggle', `Message ${stateText} AI context`, null, {
        id: message.id,
        type: message.type
    });
}

function removeScreenshotMessagesByIds(screenshotIds) {
    const removed = messageStore.removeByScreenshotIds(screenshotIds);
    if (removed.length === 0) {
        return [];
    }

    const removedMessageIds = new Set(removed.map((message) => message.id));
    for (const element of chatMessagesElement?.querySelectorAll?.('[data-message-id]') || []) {
        if (removedMessageIds.has(element.dataset.messageId)) {
            element.remove();
        }
    }
    chatMessagesArray = messageStore.getMessages();
    updateUI();
    return removed;
}

async function captureScreenshotForAnalysis(origin) {
    const result = await window.electronAPI.takeStealthScreenshot(origin);
    if (result?.success === true) {
        removeScreenshotMessagesByIds(result.replacedScreenshotIds);
        screenshotsCount = Number(result.count || 0);
        updateUI();
    }
    return result;
}

function addMonitorLog(level, event, message, source = null, meta = null, timestamp = Date.now()) {
    transcriptionManager.addMonitorLog(level, event, message, source, meta, timestamp);
}

function flushAllFinalTranscripts(reason = 'flush-all') {
    transcriptionManager.flushAllFinalTranscripts(reason);
}

function setSourceSelected(source, enabled) {
    return transcriptionManager.setSourceSelected(source, enabled);
}

async function toggleMasterTranscription() {
    if (!isSttReady()) {
        const message = activeSttProvider === 'openai'
            ? 'OpenAI or Portkey API key missing. Add one in Settings.'
            : activeSttProvider === 'portkey-whisper'
                ? 'Portkey API key missing. Add it in Settings.'
                : 'AssemblyAI API key missing. Add it in Settings.';
        showFeedback(message, 'error');
        return;
    }

    return transcriptionManager.toggleMasterTranscription();
}

// Screenshot functions
async function takeStealthScreenshot() {
    showFeedback('Taking screenshot and analyzing it...', 'info');
    const result = await autoScreenController.captureManualScreenshot();
    if (result?.busy === true) {
        showFeedback('Another assistant action is in progress', 'info');
        return result;
    }
    if (result?.success === false) {
        const message = result.error || 'Screenshot capture or analysis failed';
        showFeedback(message, 'error');
        if (result.fatal === true) {
            addChatMessage('system', message);
        }
    }
    return result;
}

function buildAskAiContextPayload() {
    const bundle = buildFilteredAiContextBundle({ charBudget: AI_CONTEXT_CHAR_BUDGET, emitTruncationLog: true });
    return {
        mode: 'best-next-answer',
        contextString: bundle.contextString,
        transcriptContext: bundle.transcriptContext,
        sessionSummary: bundle.sessionSummary,
        enabledScreenshotIds: bundle.enabledScreenshotIds,
        screenshotCount: bundle.enabledScreenshotIds.length,
        enableSearch: requestWebSearchEnabled === true,
        ...outputFormatState.buildRendererPayload()
    };
}

async function askAiWithSessionContext() {
    if (!hasGeminiApiKeysConfigured) {
        const message = activeAiProvider === 'portkey'
            ? 'Portkey is not configured. Add its API key in Settings.'
            : 'Gemini is not configured. Add its API key in Settings.';
        showFeedback(message, 'error');
        addChatMessage('system', message);
        return { success: false, error: message };
    }

    if (!window.electronAPI?.askAiWithSessionContext) {
        showFeedback('Feature not available', 'error');
        return;
    }

    const payload = buildAskAiContextPayload();
    if (!payload.contextString && payload.enabledScreenshotIds.length === 0) {
        showFeedback('No transcript or screenshots available yet', 'error');
        return;
    }

    await runAiActionWithLock('askAi', async () => {
        const stream = createStreamHandler('askAi');
        try {
            setAnalyzing(true);
            showLoadingOverlay('Analyzing full session context...');
            stream.start('**Best Next Answer:**\n\n');

            const result = await window.electronAPI.askAiWithSessionContext(payload);

            if (result?.success && result?.text) {
                const heading = result.usedScreenshots
                    ? '**Best Next Answer (Transcript + Screen):**'
                    : '**Best Next Answer (Transcript):**';
                const citations = Array.isArray(result.citations) && result.citations.length
                    ? `\n\n**Sources:**\n${result.citations.map((c) => `- [${c.title || c.url}](${c.url})`).join('\n')}`
                    : '';
                stream.finalize(`${heading}\n\n${result.text}${citations}`);
                showFeedback('Ask AI ready', 'success');
            } else {
                throw new Error(result?.error || 'Ask AI failed');
            }
        } catch (error) {
            console.error('Ask AI error:', error);
            showFeedback('Ask AI failed', 'error');
            addChatMessage('system', `Error: ${error.message}`);
        } finally {
            stream.cleanup();
            setAnalyzing(false);
            hideLoadingOverlay();
        }
    });
}

async function analyzeScreenshotsUnlocked({
    screenshotIds = null,
    origin = 'manual'
} = {}) {
    if (!hasGeminiApiKeysConfigured) {
        return {
            success: false,
            error: 'AI provider is not ready. Configure it in Settings.'
        };
    }

    const bundle = buildFilteredAiContextBundle({ charBudget: AI_CONTEXT_CHAR_BUDGET, emitTruncationLog: true });
    const requestedScreenshotIds = Array.isArray(screenshotIds)
        ? screenshotIds.filter((id) => typeof id === 'string' && id.trim().length > 0)
        : bundle.enabledScreenshotIds;
    if (requestedScreenshotIds.length === 0) {
        return {
            success: false,
            error: 'No enabled screenshots to analyze'
        };
    }

    const stream = createStreamHandler('screenAi');
    activeScreenAiStream = stream;
    try {
        setAnalyzing(true);
        showLoadingOverlay(
            origin === 'auto' ? 'Auto Screen analyzing...' : 'Analyzing screenshots...'
        );
        stream.start('');

        return await window.electronAPI.analyzeStealthWithContext({
            contextString: bundle.contextString,
            enabledScreenshotIds: requestedScreenshotIds,
            enableSearch: requestWebSearchEnabled === true,
            ...outputFormatState.buildRendererPayload()
        });
    } catch (error) {
        console.error('Analysis error:', error);
        showFeedback('Analysis failed', 'error');
        setAnalyzing(false);
        hideLoadingOverlay();
        stream.cleanup();
        if (activeScreenAiStream === stream) {
            activeScreenAiStream = null;
        }
        return {
            success: false,
            error: error?.message || 'Analysis failed'
        };
    }
}

async function analyzeScreenshotsOnly() {
    const result = await runAiActionWithLock(
        'screenAi',
        () => analyzeScreenshotsUnlocked()
    );
    if (result?.acquired === false) {
        showFeedback('Another assistant action is in progress', 'info');
        return {
            success: false,
            busy: true
        };
    }
    if (result?.value?.success === false) {
        showFeedback(result.value.error || 'Analysis failed', 'error');
    }
    return result?.value;
}

async function clearStealthData() {
    autoScreenController.disableAutoScreen('clear');
    try {
        await window.electronAPI.clearStealth();
        if (window.electronAPI.clearConversationHistory) {
            await window.electronAPI.clearConversationHistory();
        }
        screenshotsCount = 0;
        messageStore.clear();
        chatMessagesArray = messageStore.getMessages();
        chatMessagesElement.innerHTML = '';
        updateUI();
        showFeedback('Cleared', 'success');
    } catch (error) {
        console.error('Clear error:', error);
        showFeedback('Clear failed', 'error');
    }
}

async function emergencyHide() {
    autoScreenController.disableAutoScreen('emergency-hide');
    try {
        await window.electronAPI.emergencyHide();
        showEmergencyOverlay();
    } catch (error) {
        console.error('Emergency hide error:', error);
    }
}

function openCloseConfirmation() {
    if (!closeConfirmationDialog) {
        closeApplication();
        return;
    }

    isCloseConfirmationOpen = true;
    closeConfirmationDialog.classList.remove('hidden');
    confirmCloseBtn?.focus();
}

function closeCloseConfirmation() {
    if (!closeConfirmationDialog) {
        return;
    }

    isCloseConfirmationOpen = false;
    closeConfirmationDialog.classList.add('hidden');
    closeAppBtn?.focus();
}

async function closeApplication() {
    autoScreenController.disableAutoScreen('close');
    try {
        console.log('Closing application...');
        flushAllFinalTranscripts('app-close');
        await window.electronAPI.closeApp();
    } catch (error) {
        console.error('Close application error:', error);
    }
}

// NEW CLUELY-STYLE FEATURES

async function getResponseSuggestions() {
    if (!hasGeminiApiKeysConfigured) {
        showFeedback('Gemini API key missing. Add it in Settings.', 'error');
        return;
    }

    if (!window.electronAPI || !window.electronAPI.suggestResponse) {
        showFeedback('Feature not available', 'error');
        return;
    }

    await runAiActionWithLock('suggest', async () => {
        const stream = createStreamHandler('suggest');
        try {
            showFeedback('Generating suggestions...', 'info');
            const bundle = buildFilteredAiContextBundle({ charBudget: AI_CONTEXT_CHAR_BUDGET, emitTruncationLog: true });
            const transcriptOnlyContext = String(bundle.transcriptContext || '').trim();
            if (!transcriptOnlyContext) {
                showFeedback('No enabled transcript context available for suggestions', 'error');
                return;
            }

            stream.start('\u{1F4A1} **What should I say?**\n\n');

            const result = await window.electronAPI.suggestResponse({
                context: bundle.sessionSummary || 'Current meeting conversation',
                contextString: transcriptOnlyContext,
                ...outputFormatState.buildRendererPayload()
            });

            if (result.success && result.suggestions) {
                stream.finalize(`\u{1F4A1} **What should I say?**\n\n${result.suggestions}`);
                showFeedback('Suggestions generated', 'success');
            } else {
                throw new Error(result.error || 'Failed to generate suggestions');
            }
        } catch (error) {
            console.error('Error getting suggestions:', error);
            showFeedback('Failed to generate suggestions', 'error');
            addChatMessage('system', `Error: ${error.message}`);
        } finally {
            stream.cleanup();
        }
    });
}

async function generateMeetingNotes() {
    if (!hasGeminiApiKeysConfigured) {
        showFeedback('Gemini API key missing. Add it in Settings.', 'error');
        return;
    }

    if (!window.electronAPI || !window.electronAPI.generateMeetingNotes) {
        showFeedback('Feature not available', 'error');
        return;
    }

    await runAiActionWithLock('notes', async () => {
        const stream = createStreamHandler('notes');
        try {
            showFeedback('Generating meeting notes...', 'info');
            setAnalyzing(true);
            const bundle = buildFilteredAiContextBundle({ charBudget: AI_CONTEXT_CHAR_BUDGET, emitTruncationLog: true });
            if (!bundle.contextString) {
                showFeedback('No enabled context available for notes', 'error');
                return;
            }

            stream.start('\u{1F4DD} **Meeting Notes**\n\n');

            const result = await window.electronAPI.generateMeetingNotes({
                contextString: bundle.contextString
            });

            if (result.success && result.notes) {
                stream.finalize(`\u{1F4DD} **Meeting Notes**\n\n${result.notes}`);
                showFeedback('Meeting notes generated', 'success');
            } else {
                throw new Error(result.error || 'Failed to generate notes');
            }
        } catch (error) {
            console.error('Error generating notes:', error);
            showFeedback('Failed to generate notes', 'error');
            addChatMessage('system', `Error: ${error.message}`);
        } finally {
            stream.cleanup();
            setAnalyzing(false);
        }
    });
}

async function getConversationInsights() {
    if (!hasGeminiApiKeysConfigured) {
        showFeedback('Gemini API key missing. Add it in Settings.', 'error');
        return;
    }

    if (!window.electronAPI || !window.electronAPI.getConversationInsights) {
        showFeedback('Feature not available', 'error');
        return;
    }

    await runAiActionWithLock('insights', async () => {
        const stream = createStreamHandler('insights');
        try {
            showFeedback('Analyzing conversation...', 'info');
            setAnalyzing(true);
            const bundle = buildFilteredAiContextBundle({ charBudget: AI_CONTEXT_CHAR_BUDGET, emitTruncationLog: true });
            if (!bundle.contextString) {
                showFeedback('No enabled context available for insights', 'error');
                return;
            }

            stream.start('\u{1F4CA} **Conversation Insights**\n\n');

            const result = await window.electronAPI.getConversationInsights({
                contextString: bundle.contextString
            });

            if (result.success && result.insights) {
                stream.finalize(`\u{1F4CA} **Conversation Insights**\n\n${result.insights}`);
                showFeedback('Insights generated', 'success');
            } else {
                throw new Error(result.error || 'Failed to get insights');
            }
        } catch (error) {
            console.error('Error getting insights:', error);
            showFeedback('Failed to get insights', 'error');
            addChatMessage('system', `Error: ${error.message}`);
        } finally {
            stream.cleanup();
            setAnalyzing(false);
        }
    });
}

// SETTINGS FUNCTIONS

async function openSettings() {
    await settingsPanelManager.openSettings();
}

function closeSettings() {
    settingsPanelManager.closeSettings();
}

async function saveSettings() {
    const result = await settingsPanelManager.saveSettings();
    if (result?.success && result?.settings) {
        applyApiKeyAvailabilityFromSettings(result.settings);
        updateUI();
    }
}

// UI Helper functions
function setAnalyzing(analyzing) {
    isAnalyzing = analyzing;
    updateUI();
}

function updateUI() {
    if (screenshotCount) {
        screenshotCount.textContent = screenshotsCount;
    }

    const aiBundle = buildFilteredAiContextBundle({
        charBudget: AI_CONTEXT_CHAR_BUDGET,
        emitTruncationLog: false
    });
    const hasTranscriptContext = aiBundle.transcriptContext.length > 0;
    const hasEnabledScreenshots = aiBundle.enabledScreenshotIds.length > 0;
    const hasAiContext = hasTranscriptContext || hasEnabledScreenshots || aiBundle.contextString.length > 0;
    const canRunAiActions = hasGeminiApiKeysConfigured;
    const canRunTranscription = isSttReady();
    const anyAiActionInFlight = isAnyAiActionInFlight();
    const askAiInFlight = isAiActionInFlight('askAi');
    const screenAiInFlight = isAiActionInFlight('screenAi');
    const suggestInFlight = isAiActionInFlight('suggest');
    const notesInFlight = isAiActionInFlight('notes');
    const insightsInFlight = isAiActionInFlight('insights');

    if (screenshotBtn) {
        screenshotBtn.disabled = anyAiActionInFlight;
        screenshotBtn.title = canRunAiActions
            ? 'Capture one screenshot and analyze it immediately'
            : 'Configure an AI provider in Settings before capture and analysis';
        screenshotBtn.setAttribute(
            'aria-label',
            'Capture screenshot and run Screen AI'
        );
    }

    if (analyzeBtn) {
        analyzeBtn.disabled = isAnalyzing || anyAiActionInFlight || askAiInFlight || !hasAiContext;
        analyzeBtn.title = canRunAiActions ? 'Ask AI using session context' : 'Configure an AI provider in Settings';
    }

    if (screenAiBtn) {
        screenAiBtn.disabled = isAnalyzing || anyAiActionInFlight || screenAiInFlight || !hasEnabledScreenshots;
        screenAiBtn.title = canRunAiActions ? 'Analyze enabled screenshots' : 'Configure an AI provider in Settings';
    }

    if (suggestBtn) {
        suggestBtn.disabled = isAnalyzing || anyAiActionInFlight || suggestInFlight || !hasTranscriptContext;
        suggestBtn.title = canRunAiActions ? 'Suggest what to say next' : 'Configure an AI provider in Settings';
    }

    if (notesBtn) {
        notesBtn.disabled = isAnalyzing || anyAiActionInFlight || notesInFlight || !hasAiContext;
        notesBtn.title = canRunAiActions ? 'Generate meeting notes' : 'Configure an AI provider in Settings';
    }

    if (insightsBtn) {
        insightsBtn.disabled = isAnalyzing || anyAiActionInFlight || insightsInFlight || !hasAiContext;
        insightsBtn.title = canRunAiActions ? 'Generate conversation insights' : 'Configure an AI provider in Settings';
    }

    if (transcriptionToggle) {
        transcriptionToggle.disabled = false;
        transcriptionToggle.title = canRunTranscription
            ? 'Start or stop transcription'
            : 'Configure the selected speech provider in Settings';
    }

    if (sourceSystemToggle) {
        sourceSystemToggle.disabled = false;
    }

    if (sourceMicToggle) {
        sourceMicToggle.disabled = false;
    }

    updateAutoScreenUi();
}

function showFeedback(message, type = 'info') {
    console.log(`Feedback (${type}):`, message);

    if (statusText) {
        statusText.textContent = message;
        statusText.className = `status-text ${type} show`;
        statusText.style.display = 'block';

        setTimeout(() => {
            statusText.classList.remove('show');
            setTimeout(() => {
                statusText.style.display = 'none';
            }, 300);
        }, 3000);
    }
}

function showLoadingOverlay(message = 'Analyzing screen...') {
    if (loadingOverlay) {
        // Update the loading text if custom message provided
        const loadingTextElement = loadingOverlay.querySelector('.loading-text');
        if (loadingTextElement) {
            loadingTextElement.innerHTML = message;
        }
        loadingOverlay.classList.remove('hidden');
    }
}

function hideLoadingOverlay() {
    if (loadingOverlay) {
        loadingOverlay.classList.add('hidden');
        // Reset to default text
        const loadingTextElement = loadingOverlay.querySelector('.loading-text');
        if (loadingTextElement) {
            loadingTextElement.innerHTML = 'Analyzing screen...';
        }
    }
}

function showEmergencyOverlay() {
    if (emergencyOverlay) {
        emergencyOverlay.classList.remove('hidden');
        setTimeout(() => {
            emergencyOverlay.classList.add('hidden');
        }, 2000);
    }
}

function hideResults() {
    if (resultsPanel) {
        resultsPanel.classList.add('hidden');
    }
}

async function writeTextToClipboard(text) {
    const value = String(text ?? '');

    if (navigator?.clipboard?.writeText) {
        try {
            await navigator.clipboard.writeText(value);
            return;
        } catch (error) {
            console.warn('Clipboard API denied, using fallback copy path:', error);
        }
    }

    const copyListener = (event) => {
        event.preventDefault();
        if (event.clipboardData) {
            event.clipboardData.setData('text/plain', value);
        }
    };

    document.addEventListener('copy', copyListener, true);
    try {
        const copiedViaEvent = document.execCommand('copy');
        if (copiedViaEvent) {
            return;
        }
    } finally {
        document.removeEventListener('copy', copyListener, true);
    }

    const temporaryInput = document.createElement('textarea');
    temporaryInput.value = value;
    temporaryInput.setAttribute('readonly', '');
    temporaryInput.style.position = 'fixed';
    temporaryInput.style.left = '-9999px';
    temporaryInput.style.top = '0';
    document.body.appendChild(temporaryInput);
    temporaryInput.select();

    const copiedViaSelection = document.execCommand('copy');
    document.body.removeChild(temporaryInput);

    if (!copiedViaSelection) {
        throw new Error('Clipboard write failed');
    }
}

async function copyChatMessageById(messageId) {
    const message = messageStore.findById(messageId);
    const content = String(message?.content || '');

    if (!content.trim()) {
        showFeedback('Nothing to copy', 'error');
        return;
    }

    try {
        await writeTextToClipboard(content);
        showFeedback('Message copied', 'success');
    } catch (error) {
        console.error('Message copy error:', error);
        showFeedback('Copy failed', 'error');
    }
}

// Chat message management
function addChatMessage(type, content, options = {}) {
    return chatUiManager.addChatMessage(type, content, options);
}

function autoResizeManualInput() {
    chatUiManager.autoResizeManualInput();
}

function updateManualComposerState() {
    chatUiManager.updateManualComposerState();
}

function submitManualContextMessage() {
    chatUiManager.submitManualContextMessage();
}

// Timer
function startTimer() {
    const timerElement = document.querySelector('.timer');
    if (!timerElement) return;

    timerInterval = setInterval(() => {
        const elapsed = Math.floor((Date.now() - startTime) / 1000);
        const minutes = Math.floor(elapsed / 60).toString().padStart(2, '0');
        const seconds = (elapsed % 60).toString().padStart(2, '0');
        timerElement.textContent = `${minutes}:${seconds}`;
    }, 1000);
}

// Event listeners
function setupEventListeners() {
    setupEventListenersModule({
        windowApi: window.electronAPI,
        autoScreenToggle,
        screenshotBtn,
        analyzeBtn,
        screenAiBtn,
        clearBtn,
        hideBtn,
        chatManualSend,
        chatManualInput,
        closeResultsBtn,
        transcriptionToggle,
        sourceSystemToggle,
        sourceMicToggle,
        closeAppBtn,
        cancelCloseBtn,
        confirmCloseBtn,
        closeConfirmationDialog,
        chatMessagesElement,
        suggestBtn,
        notesBtn,
        insightsBtn,
        themeToggleBtn,
        settingsBtn,
        closeSettingsBtn,
        saveSettingsBtn,
        settingWindowOpacity,
        selectedSources,
        isCloseConfirmationOpen: () => isCloseConfirmationOpen,
        isShortcutPressed,
        updateWindowOpacityValueLabel,
        toggleAutoScreen,
        takeStealthScreenshot,
        askAiWithSessionContext,
        analyzeScreenshotsOnly,
        clearStealthData,
        emergencyHide,
        copyChatMessageById,
        submitManualContextMessage,
        autoResizeManualInput,
        updateManualComposerState,
        hideResults,
        toggleMasterTranscription,
        addMonitorLog,
        setSourceSelected,
        openCloseConfirmation,
        closeCloseConfirmation,
        closeApplication,
        toggleChatMessageInclusion,
        getResponseSuggestions,
        generateMeetingNotes,
        getConversationInsights,
        toggleThemeMode,
        openSettings,
        closeSettings,
        saveSettings
    });
}

// IPC listeners
function setupIpcListeners() {
    setupIpcListenersModule({
        windowApi: window.electronAPI,
        setScreenshotsCount: (nextCount) => {
            screenshotsCount = nextCount;
        },
        removeScreenshotMessagesByIds,
        updateUi: updateUI,
        addChatMessage,
        setAnalyzing,
        showLoadingOverlay,
        hideLoadingOverlay,
        showFeedback,
        showEmergencyOverlay,
        disableAutoScreen: (reason) => autoScreenController.disableAutoScreen(reason),
        transcriptionManager,
        toggleMasterTranscription,
        takeStealthScreenshot,
        askAiWithSessionContext,
        isAskAiShortcutEnabled: () => Boolean(analyzeBtn && !analyzeBtn.disabled),
        addMonitorLog,
        getActiveScreenAiStream: () => activeScreenAiStream,
        clearActiveScreenAiStream: () => {
            if (activeScreenAiStream) {
                activeScreenAiStream.cleanup();
                activeScreenAiStream = null;
            }
        }
    });
}

// Initialize on load
if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
} else {
    init();
}





