'use strict';

const fs = require('fs');
const path = require('path');
const { isEncryptedEnvelope } = require('../security/secure-text');

const SETTINGS_SEED_FILE_NAME = 'settings-seed.json';
const SETTINGS_SEED_VERSION = 1;

const SEED_STATE_FIELDS = Object.freeze([
  'aiProvider',
  'geminiApiKey',
  'assemblyAiApiKey',
  'geminiModel',
  'portkeyApiKey',
  'portkeyProvider',
  'portkeyBaseUrl',
  'promptCacheEnabled',
  'webSearchEnabled',
  'webSearchProvider',
  'tavilyApiKey',
  'sttProvider',
  'openaiApiKey',
  'openaiSttModel',
  'assemblyAiSpeechModel',
  'programmingLanguage',
  'defaultOutputFormat',
  'windowOpacityLevel',
  'themePreference',
  'autoScreenIntervalSeconds'
]);

function hasUsableApiKey(value) {
  if (typeof value !== 'string') {
    return false;
  }
  const trimmed = value.trim();
  if (!trimmed) {
    return false;
  }
  return !isEncryptedEnvelope(trimmed);
}

function currentStateNeedsSeed(appState = {}) {
  return !hasUsableApiKey(appState.portkeyApiKey)
    && !hasUsableApiKey(appState.openaiApiKey)
    && !hasUsableApiKey(appState.geminiApiKey);
}

function seedHasKeys(seed = {}) {
  return hasUsableApiKey(seed.portkeyApiKey)
    || hasUsableApiKey(seed.openaiApiKey)
    || hasUsableApiKey(seed.geminiApiKey);
}

function resolveSettingsSeedPath(app, environment = process.env) {
  const explicit = String(environment.OPEN_CLUELY_SETTINGS_SEED || '').trim();
  if (explicit) {
    return path.resolve(explicit);
  }

  if (app && app.isPackaged) {
    return path.join(process.resourcesPath, SETTINGS_SEED_FILE_NAME);
  }

  return path.join(__dirname, '..', '..', '..', 'packaging', 'macos', SETTINGS_SEED_FILE_NAME);
}

function readSettingsSeed(seedPath) {
  if (!seedPath || !fs.existsSync(seedPath)) {
    return null;
  }

  try {
    const parsed = JSON.parse(fs.readFileSync(seedPath, 'utf8'));
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

function buildSettingsSeed(appState = {}, appEnvironment = {}) {
  const seed = {
    version: SETTINGS_SEED_VERSION
  };

  for (const field of SEED_STATE_FIELDS) {
    const value = appState[field];
    if (value == null || value === '') {
      continue;
    }
    if (typeof value === 'string' && isEncryptedEnvelope(value)) {
      continue;
    }
    seed[field] = value;
  }

  if (typeof appEnvironment.hideFromScreenCapture === 'boolean') {
    seed.hideFromScreenCapture = appEnvironment.hideFromScreenCapture;
  }

  return seed;
}

function writeSettingsSeed(seedPath, appState, appEnvironment) {
  const seed = buildSettingsSeed(appState, appEnvironment);
  fs.mkdirSync(path.dirname(seedPath), { recursive: true });
  fs.writeFileSync(seedPath, `${JSON.stringify(seed, null, 2)}\n`, 'utf8');
  return {
    path: seedPath,
    hasPortkey: hasUsableApiKey(seed.portkeyApiKey),
    hasOpenAI: hasUsableApiKey(seed.openaiApiKey),
    hasGemini: hasUsableApiKey(seed.geminiApiKey)
  };
}

function applySettingsSeed(appState, seed) {
  if (!seed || !seedHasKeys(seed) || !currentStateNeedsSeed(appState)) {
    return {
      applied: false,
      appState
    };
  }

  const nextPartial = {};
  for (const field of SEED_STATE_FIELDS) {
    if (seed[field] == null || seed[field] === '') {
      continue;
    }
    nextPartial[field] = seed[field];
  }

  return {
    applied: true,
    appState: {
      ...appState,
      ...nextPartial
    }
  };
}

function applyBundledSettingsSeed({
  app,
  appState,
  appEnvironment,
  saveAppState,
  saveApplicationEnvironment,
  environment = process.env
} = {}) {
  const seedPath = resolveSettingsSeedPath(app, environment);
  const seed = readSettingsSeed(seedPath);
  const applied = applySettingsSeed(appState, seed);

  if (!applied.applied) {
    return {
      applied: false,
      appState,
      appEnvironment
    };
  }

  const nextState = typeof saveAppState === 'function'
    ? saveAppState(app, applied.appState)
    : applied.appState;

  let nextEnvironment = appEnvironment;
  if (
    typeof saveApplicationEnvironment === 'function'
    && typeof seed.hideFromScreenCapture === 'boolean'
    && appEnvironment
  ) {
    nextEnvironment = saveApplicationEnvironment(app, {
      ...appEnvironment,
      hideFromScreenCapture: seed.hideFromScreenCapture
    });
  }

  console.log('Applied bundled settings seed (keys present, values not logged)');

  return {
    applied: true,
    appState: nextState,
    appEnvironment: nextEnvironment
  };
}

module.exports = {
  SETTINGS_SEED_FILE_NAME,
  SETTINGS_SEED_VERSION,
  applyBundledSettingsSeed,
  applySettingsSeed,
  buildSettingsSeed,
  currentStateNeedsSeed,
  hasUsableApiKey,
  readSettingsSeed,
  resolveSettingsSeedPath,
  seedHasKeys,
  writeSettingsSeed
};
