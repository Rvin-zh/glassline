const fs = require('fs');
const path = require('path');
const {
  resolveAiProvider,
  resolveAutoScreenIntervalSeconds,
  resolveSttProvider,
  resolveWebSearchProvider,
  resolveOpenAiSttModel,
  resolveOutputFormat,
  sanitizeCustomOutputTemplate,
  getDefaultOutputFormat
} = require('../../config');
const { createSecureText } = require('../security/secure-text');
const {
  sanitizeInterviewSessionFields
} = require('./interview-sessions');

const APP_STATE_DIR_NAME = 'cache';
const APP_STATE_FILE_NAME = 'app-state.json';

const defaultSecureText = createSecureText();
const LEGACY_LOCAL_AI_PROVIDER = ['ol', 'lama'].join('');

function mapSensitiveAppStateText(state, transformText) {
  if (!state || typeof state !== 'object' || Array.isArray(state)) {
    return state;
  }

  const nextState = { ...state };

  for (const keyField of [
    'geminiApiKey',
    'assemblyAiApiKey',
    'portkeyApiKey',
    'tavilyApiKey',
    'openaiApiKey'
  ]) {
    if (typeof nextState[keyField] === 'string') {
      nextState[keyField] = transformText(nextState[keyField]);
    }
  }

  if (typeof nextState.resumeText === 'string') {
    nextState.resumeText = transformText(nextState.resumeText);
  }
  if (typeof nextState.jobDescriptionText === 'string') {
    nextState.jobDescriptionText = transformText(nextState.jobDescriptionText);
  }
  if (typeof nextState.customOutputTemplate === 'string') {
    nextState.customOutputTemplate = transformText(nextState.customOutputTemplate);
  }

  if (nextState.documents && typeof nextState.documents === 'object' && !Array.isArray(nextState.documents)) {
    nextState.documents = { ...nextState.documents };
    for (const kind of ['resume', 'jobDescription']) {
      const record = nextState.documents[kind];
      if (!record || typeof record !== 'object' || Array.isArray(record)) {
        continue;
      }
      nextState.documents[kind] = {
        ...record,
        text: typeof record.text === 'string' ? transformText(record.text) : record.text
      };
    }
  }

  if (Array.isArray(nextState.durableNotes)) {
    nextState.durableNotes = nextState.durableNotes.map((note) => {
      if (!note || typeof note !== 'object' || Array.isArray(note)) {
        return note;
      }
      if (typeof note.text !== 'string') {
        return { ...note };
      }
      return {
        ...note,
        text: transformText(note.text)
      };
    });
  }

  if (Array.isArray(nextState.interviewSessions)) {
    nextState.interviewSessions = nextState.interviewSessions.map((session) => {
      if (!session || typeof session !== 'object' || Array.isArray(session)) {
        return session;
      }

      const nextSession = {
        ...session,
        title: typeof session.title === 'string'
          ? transformText(session.title)
          : session.title
      };

      if (typeof session.summary === 'string') {
        nextSession.summary = transformText(session.summary);
      } else if (
        session.summary &&
        typeof session.summary === 'object' &&
        !Array.isArray(session.summary)
      ) {
        nextSession.summary = { ...session.summary };
        if (typeof session.summary.currentTopic === 'string') {
          nextSession.summary.currentTopic = transformText(session.summary.currentTopic);
        }
        for (const field of [
          'questions',
          'facts',
          'candidateExamples',
          'strengthsGaps',
          'commitments'
        ]) {
          if (Array.isArray(session.summary[field])) {
            nextSession.summary[field] = session.summary[field].map((entry) => (
              typeof entry === 'string' ? transformText(entry) : entry
            ));
          }
        }
      }

      if (Array.isArray(session.notes)) {
        nextSession.notes = session.notes.map((note) => {
          if (!note || typeof note !== 'object' || Array.isArray(note)) {
            return note;
          }
          return {
            ...note,
            text: typeof note.text === 'string'
              ? transformText(note.text)
              : note.text
          };
        });
      }

      return nextSession;
    });
  }

  return nextState;
}

function sealAppStateForDisk(state, secureText = defaultSecureText) {
  return mapSensitiveAppStateText(state, (value) => secureText.encryptForStorage(value));
}

function unsealAppStateFromDisk(state, secureText = defaultSecureText) {
  return mapSensitiveAppStateText(state, (value) => secureText.decryptFromStorage(value));
}

function getDefaultAppState() {
  return {
    aiProvider: null,
    geminiApiKey: null,
    assemblyAiApiKey: null,
    geminiApiKeyIndex: 0,
    geminiModel: null,
    portkeyApiKey: null,
    portkeyProvider: null,
    portkeyBaseUrl: null,
    promptCacheEnabled: true,
    webSearchEnabled: false,
    webSearchProvider: null,
    tavilyApiKey: null,
    resumeText: null,
    jobDescriptionText: null,
    documents: {
      resume: {
        text: '',
        enabled: true,
        source: null,
        hash: null,
        updatedAt: null
      },
      jobDescription: {
        text: '',
        enabled: true,
        source: null,
        hash: null,
        updatedAt: null
      }
    },
    sessionMemorySummary: null,
    sessionMemory: null,
    durableNotes: [],
    interviewSessions: [],
    selectedInterviewSessionIds: [],
    requestWebSearchEnabled: false,
    sttProvider: null,
    openaiApiKey: null,
    openaiSttModel: null,
    assemblyAiSpeechModel: null,
    programmingLanguage: null,
    defaultOutputFormat: getDefaultOutputFormat(),
    customOutputTemplate: '',
    windowOpacityLevel: 10,
    themePreference: null,
    autoScreenIntervalSeconds: resolveAutoScreenIntervalSeconds()
  };
}

function sanitizeNullableString(value) {
  if (typeof value !== 'string') {
    return undefined;
  }

  const trimmed = value.trim();
  return trimmed || null;
}

function sanitizeAppState(state) {
  const nextState = getDefaultAppState();

  if (state && typeof state === 'object' && !Array.isArray(state)) {
    const aiProvider = String(state.aiProvider ?? '').trim().toLowerCase();
    if (aiProvider === LEGACY_LOCAL_AI_PROVIDER) {
      nextState.aiProvider = typeof state.portkeyApiKey === 'string' && state.portkeyApiKey.trim()
        ? 'portkey'
        : 'gemini';
    } else if (aiProvider === 'gemini' || aiProvider === 'portkey') {
      nextState.aiProvider = resolveAiProvider(aiProvider);
    }

    if (typeof state.geminiApiKey === 'string') {
      const geminiApiKey = state.geminiApiKey.trim();
      nextState.geminiApiKey = geminiApiKey || null;
    }

    if (typeof state.assemblyAiApiKey === 'string') {
      const assemblyAiApiKey = state.assemblyAiApiKey.trim();
      nextState.assemblyAiApiKey = assemblyAiApiKey || null;
    }

    const geminiApiKeyIndex = Number.parseInt(String(state.geminiApiKeyIndex ?? ''), 10);
    if (Number.isFinite(geminiApiKeyIndex) && geminiApiKeyIndex >= 0) {
      nextState.geminiApiKeyIndex = geminiApiKeyIndex;
    }

    if (typeof state.geminiModel === 'string' && state.geminiModel.trim()) {
      nextState.geminiModel = state.geminiModel.trim();
    }

    if (typeof state.portkeyApiKey === 'string') {
      const portkeyApiKey = state.portkeyApiKey.trim();
      nextState.portkeyApiKey = portkeyApiKey || null;
    }

    if (typeof state.portkeyProvider === 'string' && state.portkeyProvider.trim()) {
      nextState.portkeyProvider = state.portkeyProvider.trim();
    } else if (state.portkeyProvider === null) {
      nextState.portkeyProvider = null;
    }

    if (typeof state.portkeyBaseUrl === 'string') {
      const portkeyBaseUrl = state.portkeyBaseUrl.trim();
      nextState.portkeyBaseUrl = portkeyBaseUrl || null;
    }

    if (typeof state.promptCacheEnabled === 'boolean') {
      nextState.promptCacheEnabled = state.promptCacheEnabled;
    }

    if (typeof state.webSearchEnabled === 'boolean') {
      nextState.webSearchEnabled = state.webSearchEnabled;
    }

    if (typeof state.webSearchProvider === 'string' && state.webSearchProvider.trim()) {
      const resolved = resolveWebSearchProvider(state.webSearchProvider);
      nextState.webSearchProvider = resolved === 'gemini' ? 'gemini-grounding' : resolved;
    } else if (state.webSearchProvider === null) {
      nextState.webSearchProvider = null;
    }

    if (typeof state.tavilyApiKey === 'string') {
      const tavilyApiKey = state.tavilyApiKey.trim();
      nextState.tavilyApiKey = tavilyApiKey || null;
    }

    const resumeText = sanitizeNullableString(state.resumeText);
    if (resumeText !== undefined) {
      nextState.resumeText = resumeText;
    }

    const jobDescriptionText = sanitizeNullableString(state.jobDescriptionText);
    if (jobDescriptionText !== undefined) {
      nextState.jobDescriptionText = jobDescriptionText;
    }

    if (state.documents && typeof state.documents === 'object' && !Array.isArray(state.documents)) {
      const resumeDoc = state.documents.resume && typeof state.documents.resume === 'object'
        ? state.documents.resume
        : {};
      const jobDoc = state.documents.jobDescription && typeof state.documents.jobDescription === 'object'
        ? state.documents.jobDescription
        : {};

      nextState.documents = {
        resume: {
          text: typeof resumeDoc.text === 'string' ? resumeDoc.text : (nextState.resumeText || ''),
          enabled: resumeDoc.enabled !== false,
          source: resumeDoc.source && typeof resumeDoc.source === 'object' ? resumeDoc.source : null,
          hash: typeof resumeDoc.hash === 'string' ? resumeDoc.hash : null,
          updatedAt: resumeDoc.updatedAt || null
        },
        jobDescription: {
          text: typeof jobDoc.text === 'string' ? jobDoc.text : (nextState.jobDescriptionText || ''),
          enabled: jobDoc.enabled !== false,
          source: jobDoc.source && typeof jobDoc.source === 'object' ? jobDoc.source : null,
          hash: typeof jobDoc.hash === 'string' ? jobDoc.hash : null,
          updatedAt: jobDoc.updatedAt || null
        }
      };
    } else {
      // Hydrate structured documents from legacy plain-text fields when present.
      if (nextState.resumeText) {
        nextState.documents.resume.text = nextState.resumeText;
      }
      if (nextState.jobDescriptionText) {
        nextState.documents.jobDescription.text = nextState.jobDescriptionText;
      }
    }

    // Keep legacy plain-text mirrors in sync for other agents/features.
    if (nextState.documents.resume.text) {
      nextState.resumeText = nextState.documents.resume.text;
    }
    if (nextState.documents.jobDescription.text) {
      nextState.jobDescriptionText = nextState.documents.jobDescription.text;
    }

    if (typeof state.sessionMemorySummary === 'string') {
      nextState.sessionMemorySummary = state.sessionMemorySummary.trim() || null;
    } else if (state.sessionMemorySummary === null) {
      nextState.sessionMemorySummary = null;
    }

    if (state.sessionMemory && typeof state.sessionMemory === 'object' && !Array.isArray(state.sessionMemory)) {
      nextState.sessionMemory = { ...state.sessionMemory };
    } else if (state.sessionMemory === null) {
      nextState.sessionMemory = null;
    }

    if (typeof state.requestWebSearchEnabled === 'boolean') {
      nextState.requestWebSearchEnabled = state.requestWebSearchEnabled;
    }

    if (Array.isArray(state.durableNotes)) {
      nextState.durableNotes = state.durableNotes
        .filter((note) => note && typeof note === 'object')
        .map((note) => ({ ...note }));
    }

    const interviewSessionFields = sanitizeInterviewSessionFields(state);
    nextState.interviewSessions = interviewSessionFields.interviewSessions;
    nextState.selectedInterviewSessionIds =
      interviewSessionFields.selectedInterviewSessionIds;

    if (typeof state.sttProvider === 'string' && state.sttProvider.trim()) {
      nextState.sttProvider = resolveSttProvider(state.sttProvider);
    } else if (state.sttProvider === null) {
      nextState.sttProvider = null;
    }

    if (typeof state.openaiApiKey === 'string') {
      const openaiApiKey = state.openaiApiKey.trim();
      nextState.openaiApiKey = openaiApiKey || null;
    }

    if (typeof state.openaiSttModel === 'string' && state.openaiSttModel.trim()) {
      nextState.openaiSttModel = resolveOpenAiSttModel(state.openaiSttModel);
    } else if (state.openaiSttModel === null) {
      nextState.openaiSttModel = null;
    }

    if (typeof state.assemblyAiSpeechModel === 'string' && state.assemblyAiSpeechModel.trim()) {
      nextState.assemblyAiSpeechModel = state.assemblyAiSpeechModel.trim();
    }

    if (typeof state.programmingLanguage === 'string' && state.programmingLanguage.trim()) {
      nextState.programmingLanguage = state.programmingLanguage.trim();
    }

    nextState.customOutputTemplate = sanitizeCustomOutputTemplate(
      state.customOutputTemplate
    );
    nextState.defaultOutputFormat = resolveOutputFormat(
      state.defaultOutputFormat,
      nextState.customOutputTemplate
    );

    const windowOpacityLevel = Number.parseInt(String(state.windowOpacityLevel ?? ''), 10);
    if (Number.isFinite(windowOpacityLevel)) {
      nextState.windowOpacityLevel = Math.min(Math.max(windowOpacityLevel, 1), 10);
    }

    const themePreference = String(state.themePreference ?? '').trim().toLowerCase();
    if (themePreference === 'dark' || themePreference === 'light') {
      nextState.themePreference = themePreference;
    }

    nextState.autoScreenIntervalSeconds = resolveAutoScreenIntervalSeconds(
      state.autoScreenIntervalSeconds
    );
  }

  return nextState;
}

function getAppStateBaseDir(app) {
  const explicitStateDir = String(process.env.OPEN_CLUELY_STATE_DIR || '').trim();
  if (explicitStateDir) {
    return path.resolve(explicitStateDir);
  }

  // Dev: project root next to package.json so devs can inspect state easily.
  if (app && !app.isPackaged) {
    return path.join(__dirname, '..', '..', '..');
  }

  // Packaged: userData (e.g. %APPDATA%/<productName> on Windows). Critical for
  // portable builds — the EXE extracts to a temp dir each launch, so writing
  // beside the EXE means state is wiped every run.
  if (app) {
    return app.getPath('userData');
  }

  return path.join(__dirname, '..', '..', '..');
}

function getAppStateDir(app) {
  return path.join(getAppStateBaseDir(app), APP_STATE_DIR_NAME);
}

function getAppStatePath(app) {
  return path.join(getAppStateDir(app), APP_STATE_FILE_NAME);
}

function ensureAppStateDir(app) {
  fs.mkdirSync(getAppStateDir(app), { recursive: true });
}

function writeAppStateFile(app, state) {
  ensureAppStateDir(app);
  const sealedState = sealAppStateForDisk(state);
  fs.writeFileSync(
    getAppStatePath(app),
    `${JSON.stringify(sealedState, null, 2)}\n`,
    'utf8'
  );
}

function loadAppState(app) {
  const appStatePath = getAppStatePath(app);

  try {
    ensureAppStateDir(app);

    if (!fs.existsSync(appStatePath)) {
      const defaultState = getDefaultAppState();
      writeAppStateFile(app, defaultState);
      return defaultState;
    }

    const fileContent = fs.readFileSync(appStatePath, 'utf8');
    const parsedState = unsealAppStateFromDisk(JSON.parse(fileContent));
    const sanitizedState = sanitizeAppState(parsedState);
    writeAppStateFile(app, sanitizedState);
    return sanitizedState;
  } catch (error) {
    console.error('Failed to load app state:', error);
    return getDefaultAppState();
  }
}

function saveAppState(app, partialState = {}) {
  ensureAppStateDir(app);

  const currentState = loadAppState(app);
  const nextState = sanitizeAppState({
    ...currentState,
    ...partialState
  });

  writeAppStateFile(app, nextState);

  return nextState;
}

module.exports = {
  getDefaultAppState,
  sanitizeAppState,
  getAppStateBaseDir,
  getAppStatePath,
  loadAppState,
  saveAppState,
  sealAppStateForDisk,
  unsealAppStateFromDisk
};
