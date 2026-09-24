'use strict';

const fs = require('fs');
const path = require('path');
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const platformCapabilities = require('../src/platform/capabilities');

const stylesPath = path.join(
  __dirname,
  '..',
  'src',
  'windows',
  'assistant',
  'styles.css'
);
const rendererHtmlPath = path.join(
  __dirname,
  '..',
  'src',
  'windows',
  'assistant',
  'renderer.html'
);
const rendererJsPath = path.join(
  __dirname,
  '..',
  'src',
  'windows',
  'assistant',
  'renderer.js'
);

function cssRule(source, selector) {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return source.match(new RegExp(`${escaped}\\s*\\{([^}]+)\\}`))?.[1] || '';
}

describe('Fedora launch policy', () => {
  it('provides an explicit Chromium ozone argument for each Linux display profile', () => {
    assert.equal(typeof platformCapabilities.getLinuxDisplayLaunchArgs, 'function');
    if (typeof platformCapabilities.getLinuxDisplayLaunchArgs !== 'function') {
      return;
    }

    assert.deepEqual(
      platformCapabilities.getLinuxDisplayLaunchArgs({
        platform: 'linux',
        linuxDisplayProfile: 'xwayland'
      }),
      ['--ozone-platform=x11']
    );
    assert.deepEqual(
      platformCapabilities.getLinuxDisplayLaunchArgs({
        platform: 'linux',
        linuxDisplayProfile: 'wayland'
      }),
      ['--ozone-platform=wayland']
    );
    assert.deepEqual(
      platformCapabilities.getLinuxDisplayLaunchArgs({
        platform: 'darwin',
        linuxDisplayProfile: null
      }),
      []
    );
  });

  it('prevents duplicate app instances and restores the existing window', () => {
    const modulePath = path.join(__dirname, '..', 'src', 'main-process', 'single-instance.js');
    assert.equal(fs.existsSync(modulePath), true);
    if (!fs.existsSync(modulePath)) {
      return;
    }

    const {
      acquireSingleInstance,
      revealExistingInstance
    } = require(modulePath);
    let quitCalls = 0;
    assert.equal(acquireSingleInstance({
      requestSingleInstanceLock: () => false,
      quit: () => { quitCalls += 1; }
    }), false);
    assert.equal(quitCalls, 1);

    const calls = [];
    const windowRef = {
      isDestroyed: () => false,
      isMinimized: () => true,
      restore: () => calls.push('restore'),
      show: () => calls.push('show'),
      focus: () => calls.push('focus')
    };
    assert.equal(revealExistingInstance({
      hasWindow: () => true,
      markVisible: () => calls.push('visible'),
      getMainWindow: () => windowRef
    }), true);
    assert.deepEqual(calls, ['visible', 'restore', 'show', 'focus']);
  });
});

describe('Fedora renderer performance contract', () => {
  it('enables reduced effects on Linux unless explicitly overridden', () => {
    const modulePath = path.join(__dirname, '..', 'src', 'platform', 'renderer-profile.js');
    assert.equal(fs.existsSync(modulePath), true);
    if (!fs.existsSync(modulePath)) {
      return;
    }

    const { resolveRendererProfile } = require(modulePath);
    assert.deepEqual(
      resolveRendererProfile({ platform: 'linux', fullEffects: '' }),
      { platformClass: 'platform-linux', reducedEffects: true }
    );
    assert.deepEqual(
      resolveRendererProfile({ platform: 'linux', fullEffects: '1' }),
      { platformClass: 'platform-linux', reducedEffects: false }
    );
    assert.deepEqual(
      resolveRendererProfile({ platform: 'darwin', fullEffects: '' }),
      { platformClass: 'platform-darwin', reducedEffects: false }
    );
  });

  it('defers the renderer profile until the document root exists', () => {
    const {
      installRendererProfile
    } = require('../src/platform/renderer-profile');
    assert.equal(typeof installRendererProfile, 'function');
    if (typeof installRendererProfile !== 'function') {
      return;
    }

    let onReady = null;
    const classes = new Set();
    const documentRef = {
      documentElement: null,
      addEventListener(event, listener) {
        assert.equal(event, 'DOMContentLoaded');
        onReady = listener;
      }
    };
    const profile = {
      platformClass: 'platform-linux',
      reducedEffects: true
    };

    assert.equal(installRendererProfile(documentRef, profile), 'deferred');
    documentRef.documentElement = {
      classList: {
        add: (name) => classes.add(name),
        toggle: (name, enabled) => enabled ? classes.add(name) : classes.delete(name)
      }
    };
    onReady();

    assert.equal(classes.has('platform-linux'), true);
    assert.equal(classes.has('reduced-effects'), true);
  });

  it('defines a reduced-effects profile without backdrop filters or animation', () => {
    const styles = fs.readFileSync(stylesPath, 'utf8');
    const reducedEffectsRule = cssRule(styles, 'html.reduced-effects *');

    assert.match(reducedEffectsRule, /backdrop-filter:\s*none\s*!important/);
    assert.match(reducedEffectsRule, /animation:\s*none\s*!important/);
  });

  it('keeps the interactive toolbar below the drag region', () => {
    const styles = fs.readFileSync(stylesPath, 'utf8');
    const toolbarRule = cssRule(styles, '.main-interface');

    assert.match(toolbarRule, /padding:\s*22px\s+0\s+0\s+0/);
    assert.match(toolbarRule, /margin-top:\s*0/);
  });

  it('keeps feedback visible and labels manual chat as Send', () => {
    const styles = fs.readFileSync(stylesPath, 'utf8');
    const html = fs.readFileSync(rendererHtmlPath, 'utf8');
    const statusRule = cssRule(styles, '.status-text');
    const top = Number.parseFloat(statusRule.match(/top:\s*(-?\d+(?:\.\d+)?)px/)?.[1]);

    assert.ok(Number.isFinite(top) && top >= 0, `expected visible status top, got ${top}`);
    assert.match(html, /id="chat-manual-send"[^>]*>Send<\/button>/);
  });

  it('allows OpenAI realtime STT to use the configured Portkey fallback', () => {
    const renderer = fs.readFileSync(rendererJsPath, 'utf8');
    assert.match(
      renderer,
      /activeSttProvider === 'openai'[\s\S]*return hasOpenaiApiKeyConfigured \|\| hasPortkeyApiKeyConfigured;/
    );
  });
});
