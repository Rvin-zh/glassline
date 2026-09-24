'use strict';

const fs = require('fs');
const path = require('path');
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const esbuild = require('esbuild');

function loadChatUiManager() {
  const sourcePath = path.join(
    __dirname,
    '..',
    'src',
    'windows',
    'assistant',
    'renderer',
    'features',
    'chat',
    'chat-ui-manager.js'
  );
  const source = fs.readFileSync(sourcePath, 'utf8');
  const transformed = esbuild.transformSync(source, {
    format: 'cjs',
    loader: 'js',
    target: 'node20'
  });
  const loaded = { exports: {} };
  const evaluate = new Function('module', 'exports', 'require', transformed.code);
  evaluate(loaded, loaded.exports, require);
  return loaded.exports.createChatUiManager;
}

function createClassList() {
  const values = new Set();
  return {
    add: (...names) => names.forEach((name) => values.add(name)),
    contains: (name) => values.has(name)
  };
}

describe('manual chat submit', () => {
  it('submits the typed message to the AI callback after adding it to chat', async () => {
    const createChatUiManager = loadChatUiManager();
    const messages = [];
    const submitted = [];
    const input = {
      value: 'hello',
      scrollHeight: 24,
      style: {
        setProperty() {},
        removeProperty() {}
      },
      focus() {}
    };
    const sendButton = { disabled: false };
    const chatMessages = {
      scrollHeight: 0,
      clientHeight: 100,
      scrollTop: 0,
      appendChild() {}
    };
    const chatComposer = {
      getBoundingClientRect: () => ({ height: 32 })
    };
    const chatContainer = {
      style: {
        setProperty() {},
        removeProperty() {}
      }
    };
    const messageStore = {
      add(type, content, options = {}) {
        const record = {
          id: String(messages.length + 1),
          type,
          content,
          canToggleAi: options.canToggleAi !== false,
          includeInAi: options.includeInAi !== false
        };
        messages.push(record);
        return record;
      },
      getMessages: () => messages,
      findById: (id) => messages.find((message) => message.id === id)
    };

    const previousDocument = global.document;
    global.document = {
      createElement() {
        return {
          className: '',
          classList: createClassList(),
          dataset: {},
          innerHTML: ''
        };
      }
    };

    try {
      const manager = createChatUiManager({
        chatContainer,
        chatMessagesElement: chatMessages,
        chatComposer,
        chatManualInput: input,
        chatManualSend: sendButton,
        messageStore,
        maxChatInputHeight: 88,
        escapeHtml: (value) => String(value),
        onManualMessageSubmitted: async (payload) => {
          submitted.push(payload);
        }
      });

      await manager.submitManualContextMessage();

      assert.equal(messages.length, 1);
      assert.equal(messages[0].content, 'hello');
      assert.equal(submitted.length, 1);
      assert.equal(submitted[0].text, 'hello');
      assert.equal(input.value, '');
    } finally {
      global.document = previousDocument;
    }
  });
});
