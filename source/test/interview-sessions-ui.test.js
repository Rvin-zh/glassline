'use strict';

const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const assert = require('node:assert/strict');

const {
  createInvokeActions
} = require('../src/windows/assistant/preload/actions');

const SETTINGS_MANAGER_PATH = path.join(
  __dirname,
  '..',
  'src',
  'windows',
  'assistant',
  'renderer',
  'features',
  'settings',
  'settings-panel-manager.js'
);

async function loadSettingsManagerModule() {
  const source = fs.readFileSync(SETTINGS_MANAGER_PATH, 'utf8');
  const encoded = Buffer.from(source, 'utf8').toString('base64');
  return import(`data:text/javascript;base64,${encoded}`);
}

test('preload exposes list, multi-select, delete, clear, and context-preview actions', async () => {
  const calls = [];
  const ipcRenderer = {
    invoke(channel, ...args) {
      calls.push({ channel, args });
      return Promise.resolve({ success: true });
    }
  };
  const actions = createInvokeActions(ipcRenderer);

  await actions.interviewSessionsList();
  await actions.interviewSessionsSetSelected(['first', 'second']);
  await actions.interviewSessionsDelete('first');
  await actions.interviewSessionsClear();
  await actions.contextAssemblePreview({ audience: 'desktop' });

  assert.deepEqual(calls, [
    { channel: 'interview-sessions-list', args: [] },
    {
      channel: 'interview-sessions-set-selected',
      args: [{ ids: ['first', 'second'] }]
    },
    { channel: 'interview-sessions-delete', args: [{ id: 'first' }] },
    { channel: 'interview-sessions-clear', args: [] },
    {
      channel: 'context-assemble-preview',
      args: [{ audience: 'desktop' }]
    }
  ]);
});

test('Previous Interviews renderer shows empty state and safe multi-select metadata', async () => {
  const {
    buildPreviousInterviewsMarkup
  } = await loadSettingsManagerModule();

  assert.match(
    buildPreviousInterviewsMarkup([]),
    />No previous interviews</i
  );

  const markup = buildPreviousInterviewsMarkup([
    {
      id: 'interview-2026-09-09-aaaaaaaaaaaaaaaa',
      archivedAt: '2026-09-09T20:15:30.000Z',
      title: 'System <design> — 2026-09-09',
      noteCount: 2,
      selected: true
    },
    {
      id: 'interview-2026-09-08-bbbbbbbbbbbbbbbb',
      archivedAt: '2026-09-08T08:00:00.000Z',
      title: 'Behavioral — 2026-09-08',
      noteCount: 0,
      selected: false
    }
  ]);

  assert.equal((markup.match(/type="checkbox"/g) || []).length, 2);
  assert.equal((markup.match(/data-interview-session-delete=/g) || []).length, 2);
  assert.match(
    markup,
    /data-interview-session-select="interview-2026-09-09-aaaaaaaaaaaaaaaa" checked/
  );
  assert.match(
    markup,
    /data-interview-session-select="interview-2026-09-08-bbbbbbbbbbbbbbbb"/
  );
  assert.match(markup, /System &lt;design&gt; — 2026-09-09/);
  assert.doesNotMatch(markup, /System <design>/);
  assert.match(markup, /datetime="2026-09-09T20:15:30.000Z"/);
  assert.match(markup, />2026-09-09</);
  assert.match(markup, /2 notes/);
  assert.match(markup, /0 notes/);
});

test('Settings DOM and renderer wire Previous Interviews controls', () => {
  const html = fs.readFileSync(
    path.join(__dirname, '..', 'src', 'windows', 'assistant', 'renderer.html'),
    'utf8'
  );
  const renderer = fs.readFileSync(
    path.join(__dirname, '..', 'src', 'windows', 'assistant', 'renderer.js'),
    'utf8'
  );

  assert.match(html, />Previous Interviews</);
  assert.match(html, /id="previous-interviews-list"/);
  assert.match(html, /id="clear-previous-interviews-btn"/);
  assert.match(renderer, /previousInterviewsList/);
  assert.match(renderer, /clearPreviousInterviewsBtn/);
  assert.match(renderer, /previousInterviewsList,\s*clearPreviousInterviewsBtn,/);
});
