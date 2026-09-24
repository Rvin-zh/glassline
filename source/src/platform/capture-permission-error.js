'use strict';

const MACOS_PRIVACY_HINT =
  'Open System Settings → Privacy & Security and allow Microphone or Screen Recording for Open-Cluely.';

function classifyCapturePermissionError(error, platform) {
  const message = String(error?.name ? `${error.name} ${error.message}` : error?.message || error || '');
  const isPermission = /notallowed|permission|denied|tcc|screen recording/i.test(message);
  if (!isPermission) {
    return { code: 'CAPTURE_FAILED', hint: null };
  }
  if (platform === 'darwin') {
    return { code: 'MACOS_PRIVACY_DENIED', hint: MACOS_PRIVACY_HINT };
  }
  return {
    code: 'CAPTURE_PERMISSION_DENIED',
    hint: 'Grant microphone or screen-capture permission and try again.'
  };
}

function formatCapturePermissionMessage(error, platform) {
  const classified = classifyCapturePermissionError(error, platform);
  const base = error?.message || 'Capture failed';
  return classified.hint ? `${base} ${classified.hint}` : base;
}

module.exports = {
  MACOS_PRIVACY_HINT,
  classifyCapturePermissionError,
  formatCapturePermissionMessage
};
