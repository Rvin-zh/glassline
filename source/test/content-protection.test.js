'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { applyContentProtection } = require('../src/platform/content-protection');

function createFakeWindow({ throwOnCall = false } = {}) {
  const calls = [];
  return {
    calls,
    isDestroyed: () => false,
    setContentProtection(value) {
      if (throwOnCall) {
        throw new Error('unexpected platform');
      }
      calls.push(value);
    }
  };
}

describe('applyContentProtection', () => {
  it('enables and disables hide on supported platforms', () => {
    const window = createFakeWindow();
    assert.deepEqual(
      applyContentProtection(window, {
        hideFromScreenCapture: true,
        contentProtectionSupported: true
      }),
      { applied: true, active: true }
    );
    assert.deepEqual(
      applyContentProtection(window, {
        hideFromScreenCapture: false,
        contentProtectionSupported: true
      }),
      { applied: true, active: false }
    );
    assert.deepEqual(window.calls, [true, false]);
  });

  it('never calls setContentProtection on Linux', () => {
    const window = createFakeWindow();
    assert.deepEqual(
      applyContentProtection(window, {
        hideFromScreenCapture: true,
        contentProtectionSupported: false
      }),
      { applied: false, active: false, reason: 'unsupported' }
    );
    assert.deepEqual(window.calls, []);
  });

  it('logs a warning and continues when setContentProtection throws', () => {
    const window = createFakeWindow({ throwOnCall: true });
    const result = applyContentProtection(window, {
      hideFromScreenCapture: true,
      contentProtectionSupported: true
    });
    assert.deepEqual(result, { applied: false, active: false, reason: 'threw' });
  });
});
