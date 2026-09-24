'use strict';

const HIDE_OVERLAY_LINUX_HELP =
  'Linux cannot exclude a visible overlay from PipeWire or compositor capture.';
const HIDE_OVERLAY_SUPPORTED_HELP =
  'Keeps this overlay visible on your screen and excludes it from Zoom, Meet, and other screen sharing on macOS and Windows.';

function resolveHideOverlayControlState({
  platform,
  contentProtectionSupported,
  hideFromScreenCapture
} = {}) {
  const enabled = contentProtectionSupported === true || platform === 'darwin' || platform === 'win32';
  return {
    enabled,
    checked: enabled ? hideFromScreenCapture === true : false,
    helperText: enabled ? HIDE_OVERLAY_SUPPORTED_HELP : HIDE_OVERLAY_LINUX_HELP
  };
}

module.exports = {
  HIDE_OVERLAY_LINUX_HELP,
  HIDE_OVERLAY_SUPPORTED_HELP,
  resolveHideOverlayControlState
};
