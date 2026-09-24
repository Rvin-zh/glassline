'use strict';

function resolveHideFromScreenCapture(payloadValue, currentValue) {
  if (payloadValue == null || payloadValue === '') {
    return currentValue === true;
  }
  if (payloadValue === true || payloadValue === false) {
    return payloadValue;
  }
  const normalized = String(payloadValue).trim().toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(normalized)) {
    return true;
  }
  if (['0', 'false', 'no', 'off'].includes(normalized)) {
    return false;
  }
  return currentValue === true;
}

module.exports = {
  resolveHideFromScreenCapture
};
