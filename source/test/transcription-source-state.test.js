'use strict';

const fs = require('fs');
const path = require('path');
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const esbuild = require('esbuild');

function loadSourceState() {
  const sourcePath = path.join(
    __dirname,
    '..',
    'src',
    'windows',
    'assistant',
    'renderer',
    'features',
    'assembly-ai',
    'source-state.js'
  );
  const transformed = esbuild.transformSync(fs.readFileSync(sourcePath, 'utf8'), {
    format: 'cjs',
    loader: 'js',
    target: 'node20'
  });
  const loaded = { exports: {} };
  new Function('module', 'exports', 'require', transformed.code)(
    loaded,
    loaded.exports,
    require
  );
  return loaded.exports;
}

describe('transcription source defaults', () => {
  it('enables host and microphone capture so either speaker is transcribed', () => {
    const { createTranscriptionSourceState } = loadSourceState();
    const state = createTranscriptionSourceState();

    assert.deepEqual(state.getSelectedSources(), {
      system: true,
      mic: true
    });
  });
});
