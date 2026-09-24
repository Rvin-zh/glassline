'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const {
  classifyCapturePermissionError,
  MACOS_PRIVACY_HINT
} = require('../src/platform/capture-permission-error');

describe('capture permission errors', () => {
  it('maps macOS TCC and NotAllowed errors to a System Settings hint', () => {
    assert.deepEqual(
      classifyCapturePermissionError(new Error('NotAllowedError: Permission denied'), 'darwin'),
      { code: 'MACOS_PRIVACY_DENIED', hint: MACOS_PRIVACY_HINT }
    );
    assert.deepEqual(
      classifyCapturePermissionError(new Error('screen recording permission'), 'darwin'),
      { code: 'MACOS_PRIVACY_DENIED', hint: MACOS_PRIVACY_HINT }
    );
  });

  it('does not treat ordinary capture failures as privacy denials', () => {
    assert.deepEqual(
      classifyCapturePermissionError(new Error('desktop capturer returned an empty thumbnail'), 'darwin'),
      { code: 'CAPTURE_FAILED', hint: null }
    );
  });
});
