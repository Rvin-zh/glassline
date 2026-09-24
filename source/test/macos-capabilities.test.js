'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { detectPlatformCapabilities } = require('../src/platform/capabilities');

describe('macOS capability matrix', () => {
  it('reports official hide, screenshot-desktop, and desktop-capturer loopback on darwin', () => {
    const capabilities = detectPlatformCapabilities({ platform: 'darwin' });
    assert.equal(capabilities.platform, 'darwin');
    assert.equal(capabilities.contentProtectionSupported, true);
    assert.equal(capabilities.screenshotBackend, 'screenshot-desktop');
    assert.equal(capabilities.hostAudioBackend, 'desktop-capturer-loopback');
    assert.equal(capabilities.linuxDisplayProfile, null);
    assert.equal(
      capabilities.notes.includes(
        'Microphone and Screen Recording are granted in System Settings → Privacy & Security.'
      ),
      true
    );
  });
});
