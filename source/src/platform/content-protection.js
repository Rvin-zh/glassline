'use strict';

function applyContentProtection(browserWindow, {
  hideFromScreenCapture,
  contentProtectionSupported
} = {}) {
  if (!browserWindow || (typeof browserWindow.isDestroyed === 'function' && browserWindow.isDestroyed())) {
    return { applied: false, active: false, reason: 'no-window' };
  }

  if (!contentProtectionSupported) {
    return { applied: false, active: false, reason: 'unsupported' };
  }

  try {
    const active = hideFromScreenCapture === true;
    browserWindow.setContentProtection(active);
    return { applied: true, active };
  } catch (error) {
    console.warn('setContentProtection failed:', error?.message || error);
    return { applied: false, active: false, reason: 'threw' };
  }
}

module.exports = {
  applyContentProtection
};
