'use strict';

const fs = require('fs');
const path = require('path');
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { buildPlatformDiagnosticsView } = require('../src/platform/platform-diagnostics');

describe('platform diagnostics view', () => {
  it('includes hide support and active state on every OS', () => {
    const view = buildPlatformDiagnosticsView({
      capabilities: {
        platform: 'darwin',
        contentProtectionSupported: true,
        screenshotBackend: 'screenshot-desktop',
        hostAudioBackend: 'desktop-capturer-loopback'
      },
      contentProtectionActive: true,
      capture: { lastBackend: 'screenshot-desktop' },
      hostAudioCapture: { backend: 'desktop-capturer-loopback' },
      backgroundMemory: null,
      promptCache: null,
      shortcuts: [],
      timestamp: '2026-09-10T00:00:00.000Z'
    });
    assert.equal(view.capabilities.contentProtectionSupported, true);
    assert.equal(view.contentProtectionActive, true);
    assert.equal(view.capabilities.screenshotBackend, 'screenshot-desktop');
    assert.equal(view.capabilities.hostAudioBackend, 'desktop-capturer-loopback');
  });

  it('documents macOS as first-class and keeps verify hooked to macos smoke', () => {
    const readme = fs.readFileSync(path.join(__dirname, '..', 'README.md'), 'utf8');
    const macDoc = fs.readFileSync(path.join(__dirname, '..', 'MAC.md'), 'utf8');
    const packageJson = JSON.parse(
      fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8')
    );
    assert.match(readme, /MAC\.md/);
    assert.match(readme, /macOS/);
    assert.match(macDoc, /npm start/);
    assert.match(macDoc, /setContentProtection/);
    assert.match(macDoc, /Gatekeeper/);
    assert.match(macDoc, /Screen Recording/);
    assert.match(macDoc, /npm run build:mac/);
    assert.match(packageJson.scripts.verify, /smoke:macos -- --no-write/);
  });
});
