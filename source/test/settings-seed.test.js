'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const {
  applySettingsSeed,
  buildSettingsSeed,
  currentStateNeedsSeed,
  hasUsableApiKey,
  writeSettingsSeed
} = require('../src/services/state/settings-seed');

describe('settings seed', () => {
  it('rejects leftover Linux safeStorage envelopes as unusable keys', () => {
    assert.equal(hasUsableApiKey(null), false);
    assert.equal(hasUsableApiKey(''), false);
    assert.equal(hasUsableApiKey('enc:v1:abcd'), false);
    assert.equal(hasUsableApiKey('sk-live-example'), true);
    assert.equal(currentStateNeedsSeed({
      portkeyApiKey: 'enc:v1:abcd',
      openaiApiKey: null
    }), true);
  });

  it('applies a seed only when the current state has no usable keys', () => {
    const seed = {
      version: 1,
      aiProvider: 'portkey',
      portkeyApiKey: 'pk-live-example',
      portkeyProvider: '@vertex',
      geminiModel: 'gemini-3.8-flash',
      sttProvider: 'openai',
      openaiApiKey: 'sk-live-example',
      openaiSttModel: 'gpt-live-transcribe'
    };

    const skipped = applySettingsSeed({
      portkeyApiKey: 'pk-already-set',
      openaiApiKey: null
    }, seed);
    assert.equal(skipped.applied, false);
    assert.equal(skipped.appState.portkeyApiKey, 'pk-already-set');

    const applied = applySettingsSeed({
      portkeyApiKey: 'enc:v1:from-linux',
      openaiApiKey: null
    }, seed);
    assert.equal(applied.applied, true);
    assert.equal(applied.appState.portkeyApiKey, 'pk-live-example');
    assert.equal(applied.appState.openaiApiKey, 'sk-live-example');
    assert.equal(applied.appState.portkeyProvider, '@vertex');
  });

  it('writes a seed without encrypted envelopes', () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'open-cluely-seed-'));
    const seedPath = path.join(tempDir, 'settings-seed.json');
    const result = writeSettingsSeed(seedPath, {
      aiProvider: 'portkey',
      portkeyApiKey: 'pk-live-example',
      openaiApiKey: 'enc:v1:should-omit',
      geminiModel: 'gemini-3.8-flash'
    }, {
      hideFromScreenCapture: true
    });

    assert.equal(result.hasPortkey, true);
    assert.equal(result.hasOpenAI, false);
    const written = JSON.parse(fs.readFileSync(seedPath, 'utf8'));
    assert.equal(written.portkeyApiKey, 'pk-live-example');
    assert.equal(written.openaiApiKey, undefined);
    assert.equal(written.hideFromScreenCapture, true);
    assert.equal(buildSettingsSeed({ portkeyApiKey: 'enc:v1:x' }).portkeyApiKey, undefined);
    fs.rmSync(tempDir, { recursive: true, force: true });
  });
});
