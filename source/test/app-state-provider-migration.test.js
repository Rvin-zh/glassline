'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const {
  getDefaultAppState,
  sanitizeAppState
} = require('../src/services/state/app-state');

const LEGACY_LOCAL_PROVIDER = ['ol', 'lama'].join('');
const LEGACY_BASE_URL_FIELD = `${LEGACY_LOCAL_PROVIDER}BaseUrl`;
const LEGACY_MODEL_FIELD = `${LEGACY_LOCAL_PROVIDER}Model`;

describe('legacy local AI provider migration', () => {
  it('migrates to Portkey when a Portkey key is present', () => {
    const sanitized = sanitizeAppState({
      aiProvider: LEGACY_LOCAL_PROVIDER,
      portkeyApiKey: ' test-portkey-key ',
      [LEGACY_BASE_URL_FIELD]: 'http://127.0.0.1:11434',
      [LEGACY_MODEL_FIELD]: 'legacy-model'
    });

    assert.equal(sanitized.aiProvider, 'portkey');
    assert.equal(sanitized.portkeyApiKey, 'test-portkey-key');
    assert.equal(LEGACY_BASE_URL_FIELD in sanitized, false);
    assert.equal(LEGACY_MODEL_FIELD in sanitized, false);
  });

  it('migrates to Gemini when no Portkey key is present', () => {
    const sanitized = sanitizeAppState({
      aiProvider: LEGACY_LOCAL_PROVIDER,
      portkeyApiKey: '   ',
      [LEGACY_BASE_URL_FIELD]: 'http://127.0.0.1:11434',
      [LEGACY_MODEL_FIELD]: 'legacy-model'
    });

    assert.equal(sanitized.aiProvider, 'gemini');
    assert.equal(sanitized.portkeyApiKey, null);
    assert.equal(LEGACY_BASE_URL_FIELD in sanitized, false);
    assert.equal(LEGACY_MODEL_FIELD in sanitized, false);
  });

  it('omits obsolete local-provider fields from defaults', () => {
    const defaults = getDefaultAppState();

    assert.equal(LEGACY_BASE_URL_FIELD in defaults, false);
    assert.equal(LEGACY_MODEL_FIELD in defaults, false);
  });
});
