'use strict';

const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const assert = require('node:assert/strict');

const REPO_ROOT = path.resolve(__dirname, '..');
const OUTPUT_FORMAT_STATE_PATH = path.join(
  REPO_ROOT,
  'src',
  'windows',
  'assistant',
  'renderer',
  'features',
  'settings',
  'output-format-state.js'
);

async function loadOutputFormatStateModule() {
  const source = fs.readFileSync(OUTPUT_FORMAT_STATE_PATH, 'utf8');
  const encoded = Buffer.from(source, 'utf8').toString('base64');
  return import(`data:text/javascript;base64,${encoded}`);
}

function createSelect() {
  return {
    value: 'quick',
    title: '',
    listeners: new Map(),
    addEventListener(type, listener) {
      this.listeners.set(type, listener);
    },
    dispatchChange() {
      this.listeners.get('change')?.({ target: this });
    }
  };
}

test('toolbar output format starts from the saved default and stays session-only', async () => {
  const { createOutputFormatState } = await loadOutputFormatStateModule();
  const select = createSelect();
  const state = createOutputFormatState({ toolbarSelect: select });

  state.initializeFromSettings({
    defaultOutputFormat: 'adaptive',
    outputFormats: ['quick', 'adaptive', 'detailed', 'custom']
  });
  assert.equal(state.getDefaultOutputFormat(), 'adaptive');
  assert.equal(state.getActiveOutputFormat(), 'adaptive');
  assert.equal(select.value, 'adaptive');

  select.value = 'detailed';
  select.dispatchChange();
  assert.equal(state.getActiveOutputFormat(), 'detailed');
  assert.deepEqual(state.buildRendererPayload(), { outputFormat: 'detailed' });
  assert.equal('customOutputTemplate' in state.buildRendererPayload(), false);
});

test('saving a new default updates only an override still matching the old default', async () => {
  const { createOutputFormatState } = await loadOutputFormatStateModule();

  const followingSelect = createSelect();
  const following = createOutputFormatState({ toolbarSelect: followingSelect });
  following.initializeFromSettings({ defaultOutputFormat: 'quick' });
  following.applySavedSettings({ defaultOutputFormat: 'adaptive' });
  assert.equal(following.getActiveOutputFormat(), 'adaptive');
  assert.equal(followingSelect.value, 'adaptive');

  const overriddenSelect = createSelect();
  const overridden = createOutputFormatState({ toolbarSelect: overriddenSelect });
  overridden.initializeFromSettings({ defaultOutputFormat: 'quick' });
  overriddenSelect.value = 'detailed';
  overriddenSelect.dispatchChange();
  overridden.applySavedSettings({ defaultOutputFormat: 'adaptive' });
  assert.equal(overridden.getDefaultOutputFormat(), 'adaptive');
  assert.equal(overridden.getActiveOutputFormat(), 'detailed');
  assert.equal(overriddenSelect.value, 'detailed');
});

test('toolbar and Settings expose accessible output-format controls', () => {
  const html = fs.readFileSync(
    path.join(REPO_ROOT, 'src', 'windows', 'assistant', 'renderer.html'),
    'utf8'
  );
  const renderer = fs.readFileSync(
    path.join(REPO_ROOT, 'src', 'windows', 'assistant', 'renderer.js'),
    'utf8'
  );

  assert.match(html, /id="output-format-select"/);
  assert.match(html, /aria-label="Current interview output format"/);
  assert.match(html, /title="Current interview output format"/);
  assert.match(html, /id="setting-default-output-format"/);
  assert.match(html, /id="setting-custom-output-template"/);
  assert.match(html, /maxlength="4000"/);
  assert.match(html, /id="setting-custom-output-status"/);
  assert.match(renderer, /outputFormatState\.buildRendererPayload\(\)/);
});
