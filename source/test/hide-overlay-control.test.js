'use strict';

const fs = require('fs');
const path = require('path');
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const {
  resolveHideOverlayControlState,
  HIDE_OVERLAY_LINUX_HELP,
  HIDE_OVERLAY_SUPPORTED_HELP
} = require('../src/windows/assistant/renderer/features/settings/hide-overlay-control');

const rendererHtml = fs.readFileSync(
  path.join(__dirname, '..', 'src', 'windows', 'assistant', 'renderer.html'),
  'utf8'
);

describe('hide overlay settings control', () => {
  it('enables the control on macOS and Windows', () => {
    assert.deepEqual(
      resolveHideOverlayControlState({
        platform: 'darwin',
        contentProtectionSupported: true,
        hideFromScreenCapture: true
      }),
      { enabled: true, checked: true, helperText: HIDE_OVERLAY_SUPPORTED_HELP }
    );
  });

  it('disables the control on Linux and explains the limit', () => {
    assert.deepEqual(
      resolveHideOverlayControlState({
        platform: 'linux',
        contentProtectionSupported: false,
        hideFromScreenCapture: true
      }),
      { enabled: false, checked: false, helperText: HIDE_OVERLAY_LINUX_HELP }
    );
  });

  it('places the labeled control next to window opacity', () => {
    assert.match(rendererHtml, /id="setting-hide-from-screen-capture"/);
    assert.match(rendererHtml, /Hide overlay from screen sharing/);
    const opacityIndex = rendererHtml.indexOf('setting-window-opacity');
    const hideIndex = rendererHtml.indexOf('setting-hide-from-screen-capture');
    assert.equal(hideIndex > opacityIndex, true);
  });
});
