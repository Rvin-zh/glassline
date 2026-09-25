const { invokeWithFallback } = require('./helpers');

function createInvokeActions(ipcRenderer) {
  return {
    toggleStealth: invokeWithFallback(ipcRenderer, {
      channel: 'toggle-stealth',
      label: 'toggleStealth',
      fallback: (error) => ({ error: error.message })
    }),

    emergencyHide: invokeWithFallback(ipcRenderer, {
      channel: 'emergency-hide',
      label: 'emergencyHide',
      fallback: (error) => ({ error: error.message })
    }),

    takeStealthScreenshot: invokeWithFallback(ipcRenderer, {
      channel: 'take-stealth-screenshot',
      label: 'takeStealthScreenshot',
      transformArgs: (args) => [{
        origin: args[0] === 'auto' ? 'auto' : 'manual'
      }],
      fallback: (error) => ({ error: error.message })
    }),

    analyzeStealth: invokeWithFallback(ipcRenderer, {
      channel: 'analyze-stealth',
      label: 'analyzeStealth',
      fallback: (error) => ({ error: error.message })
    }),

    analyzeStealthWithContext: invokeWithFallback(ipcRenderer, {
      channel: 'analyze-stealth-with-context',
      label: 'analyzeStealthWithContext',
      fallback: (error) => ({ error: error.message })
    }),

    askAiWithSessionContext: invokeWithFallback(ipcRenderer, {
      channel: 'ask-ai-with-session-context',
      label: 'askAiWithSessionContext',
      fallback: (error) => ({ success: false, error: error.message })
    }),

    clearStealth: invokeWithFallback(ipcRenderer, {
      channel: 'clear-stealth',
      label: 'clearStealth',
      fallback: (error) => ({ error: error.message })
    }),

    getScreenshotsCount: invokeWithFallback(ipcRenderer, {
      channel: 'get-screenshots-count',
      label: 'getScreenshotsCount',
      fallback: () => 0
    }),

    chooseExternalLayer: invokeWithFallback(ipcRenderer, {
      channel: 'choose-external-layer',
      label: 'chooseExternalLayer',
      transformArgs: (args) => [{ layerId: args[0] }],
      fallback: (error) => ({ ok: false, error: error.message })
    }),

    getWindowBounds: invokeWithFallback(ipcRenderer, {
      channel: 'get-window-bounds',
      label: 'getWindowBounds',
      fallback: (error) => ({ error: error.message })
    }),

    setWindowBounds: invokeWithFallback(ipcRenderer, {
      channel: 'set-window-bounds',
      label: 'setWindowBounds',
      fallback: (error) => ({ error: error.message })
    }),

    setWindowSizePreset: invokeWithFallback(ipcRenderer, {
      channel: 'set-window-size-preset',
      label: 'setWindowSizePreset',
      transformArgs: (args) => [{ preset: args[0] }],
      fallback: (error) => ({ error: error.message })
    }),

    startVoiceRecognition: invokeWithFallback(ipcRenderer, {
      channel: 'start-voice-recognition',
      label: 'startVoiceRecognition',
      transformArgs: (args) => [{ source: args[0] }],
      fallback: (error) => ({ error: error.message })
    }),

    stopVoiceRecognition: invokeWithFallback(ipcRenderer, {
      channel: 'stop-voice-recognition',
      label: 'stopVoiceRecognition',
      transformArgs: (args) => [{ source: args[0] }],
      fallback: (error) => ({ error: error.message })
    }),

    startPipeWireMonitorCapture: invokeWithFallback(ipcRenderer, {
      channel: 'start-pipewire-monitor-capture',
      label: 'startPipeWireMonitorCapture',
      fallback: () => ({
        success: false,
        backend: 'pipewire-monitor',
        sourceConfigured: false,
        error: 'Direct PipeWire/Pulse monitor capture is unavailable.'
      })
    }),

    stopPipeWireMonitorCapture: invokeWithFallback(ipcRenderer, {
      channel: 'stop-pipewire-monitor-capture',
      label: 'stopPipeWireMonitorCapture',
      fallback: () => ({
        success: false,
        backend: 'pipewire-monitor',
        error: 'Direct PipeWire/Pulse monitor capture could not be stopped.'
      })
    }),

    sendAudioChunk: (source, audioData) => {
      ipcRenderer.send('audio-chunk', { source, data: audioData });
    },

    getDesktopSources: invokeWithFallback(ipcRenderer, {
      channel: 'get-desktop-sources',
      label: 'getDesktopSources',
      fallback: () => []
    }),

    transcribeAudio: invokeWithFallback(ipcRenderer, {
      channel: 'transcribe-audio',
      label: 'transcribeAudio',
      fallback: (error) => ({ success: false, error: error.message })
    }),

    addVoiceTranscript: invokeWithFallback(ipcRenderer, {
      channel: 'add-voice-transcript',
      label: 'addVoiceTranscript',
      fallback: (error) => ({ error: error.message })
    }),

    suggestResponse: invokeWithFallback(ipcRenderer, {
      channel: 'suggest-response',
      label: 'suggestResponse',
      fallback: (error) => ({ error: error.message })
    }),

    generateMeetingNotes: invokeWithFallback(ipcRenderer, {
      channel: 'generate-meeting-notes',
      label: 'generateMeetingNotes',
      fallback: (error) => ({ error: error.message })
    }),

    generateFollowUpEmail: invokeWithFallback(ipcRenderer, {
      channel: 'generate-follow-up-email',
      label: 'generateFollowUpEmail',
      fallback: (error) => ({ error: error.message })
    }),

    answerQuestion: invokeWithFallback(ipcRenderer, {
      channel: 'answer-question',
      label: 'answerQuestion',
      fallback: (error) => ({ error: error.message })
    }),

    getConversationInsights: invokeWithFallback(ipcRenderer, {
      channel: 'get-conversation-insights',
      label: 'getConversationInsights',
      fallback: (error) => ({ error: error.message })
    }),

    clearConversationHistory: invokeWithFallback(ipcRenderer, {
      channel: 'clear-conversation-history',
      label: 'clearConversationHistory',
      fallback: (error) => ({ error: error.message })
    }),

    getConversationHistory: invokeWithFallback(ipcRenderer, {
      channel: 'get-conversation-history',
      label: 'getConversationHistory',
      fallback: (error) => ({ error: error.message })
    }),

    getSettings: invokeWithFallback(ipcRenderer, {
      channel: 'get-settings',
      label: 'getSettings',
      fallback: (error) => ({ error: error.message })
    }),

    getSttConfig: invokeWithFallback(ipcRenderer, {
      channel: 'get-stt-config',
      label: 'getSttConfig',
      fallback: (error) => ({ error: error.message, sampleRate: 16000, sttProvider: 'assemblyai', realtime: true })
    }),

    getPlatformDiagnostics: invokeWithFallback(ipcRenderer, {
      channel: 'platform-get-diagnostics',
      label: 'getPlatformDiagnostics',
      fallback: (error) => ({ error: error.message })
    }),

    saveSettings: invokeWithFallback(ipcRenderer, {
      channel: 'save-settings',
      label: 'saveSettings',
      fallback: (error) => ({ success: false, error: error.message })
    }),

    documentsGet: invokeWithFallback(ipcRenderer, {
      channel: 'documents-get',
      label: 'documentsGet',
      fallback: (error) => ({ success: false, error: error.message })
    }),

    documentsPickFile: invokeWithFallback(ipcRenderer, {
      channel: 'documents-pick-file',
      label: 'documentsPickFile',
      fallback: (error) => ({ success: false, error: error.message })
    }),

    documentsIngestPaste: invokeWithFallback(ipcRenderer, {
      channel: 'documents-ingest-paste',
      label: 'documentsIngestPaste',
      fallback: (error) => ({ success: false, error: error.message })
    }),

    documentsIngestFile: invokeWithFallback(ipcRenderer, {
      channel: 'documents-ingest-file',
      label: 'documentsIngestFile',
      fallback: (error) => ({ success: false, error: error.message })
    }),

    documentsSetEnabled: invokeWithFallback(ipcRenderer, {
      channel: 'documents-set-enabled',
      label: 'documentsSetEnabled',
      fallback: (error) => ({ success: false, error: error.message })
    }),

    memoryGetSummary: invokeWithFallback(ipcRenderer, {
      channel: 'memory-get-summary',
      label: 'memoryGetSummary',
      fallback: (error) => ({ success: false, error: error.message })
    }),

    memoryGetReviewQueue: invokeWithFallback(ipcRenderer, {
      channel: 'memory-get-review-queue',
      label: 'memoryGetReviewQueue',
      fallback: (error) => ({ success: false, error: error.message })
    }),

    memoryTriggerUpdate: invokeWithFallback(ipcRenderer, {
      channel: 'memory-trigger-update',
      label: 'memoryTriggerUpdate',
      fallback: (error) => ({ success: false, error: error.message })
    }),

    memoryFlush: invokeWithFallback(ipcRenderer, {
      channel: 'memory-flush',
      label: 'memoryFlush',
      fallback: (error) => ({ success: false, error: error.message })
    }),

    memoryReviewNote: invokeWithFallback(ipcRenderer, {
      channel: 'memory-review-note',
      label: 'memoryReviewNote',
      fallback: (error) => ({ success: false, error: error.message })
    }),

    interviewSessionsList: invokeWithFallback(ipcRenderer, {
      channel: 'interview-sessions-list',
      label: 'interviewSessionsList',
      fallback: (error) => ({ success: false, error: error.message, sessions: [], selectedIds: [] })
    }),

    interviewSessionsSetSelected: invokeWithFallback(ipcRenderer, {
      channel: 'interview-sessions-set-selected',
      label: 'interviewSessionsSetSelected',
      transformArgs: (args) => [{ ids: Array.isArray(args[0]) ? args[0] : [] }],
      fallback: (error) => ({ success: false, error: error.message, sessions: [], selectedIds: [] })
    }),

    interviewSessionsDelete: invokeWithFallback(ipcRenderer, {
      channel: 'interview-sessions-delete',
      label: 'interviewSessionsDelete',
      transformArgs: (args) => [{ id: args[0] }],
      fallback: (error) => ({ success: false, error: error.message, sessions: [], selectedIds: [] })
    }),

    interviewSessionsClear: invokeWithFallback(ipcRenderer, {
      channel: 'interview-sessions-clear',
      label: 'interviewSessionsClear',
      fallback: (error) => ({ success: false, error: error.message, sessions: [], selectedIds: [] })
    }),

    contextAssemblePreview: invokeWithFallback(ipcRenderer, {
      channel: 'context-assemble-preview',
      label: 'contextAssemblePreview',
      fallback: (error) => ({ success: false, error: error.message })
    }),

    clearScopedData: invokeWithFallback(ipcRenderer, {
      channel: 'clear-scoped-data',
      label: 'clearScopedData',
      fallback: (error) => ({ success: false, error: error.message })
    }),

    setThemePreference: invokeWithFallback(ipcRenderer, {
      channel: 'set-theme-preference',
      label: 'setThemePreference',
      transformArgs: (args) => [{ theme: args[0] }],
      fallback: (error) => ({ success: false, error: error.message })
    }),

    closeApp: invokeWithFallback(ipcRenderer, {
      channel: 'close-app',
      label: 'closeApp',
      fallback: (error) => ({ error: error.message })
    }),

    getMobileServerStatus: invokeWithFallback(ipcRenderer, {
      channel: 'mobile-server-get-status',
      label: 'getMobileServerStatus',
      fallback: () => ({ listening: false, port: 7823, urls: [], clientCount: 0, error: null })
    })
  };
}

module.exports = {
  createInvokeActions
};
