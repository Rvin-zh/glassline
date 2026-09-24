'use strict';

// Platform diagnostics view builder.
//
// Consumes the raw diagnostics fields gathered by the main process
// (`platform-get-diagnostics` IPC handler in `start-application.js`) and
// returns a single plain object that the Settings panel renders as JSON.
//
// The view always surfaces `capabilities.contentProtectionSupported`
// (whether `setContentProtection` is available on this OS) and a top-level
// `contentProtectionActive` flag (whether the last apply actually turned
// hide on). Coercing `contentProtectionActive` to a boolean keeps the
// renderer output stable across platforms and across the
// "no window yet / unsupported" cases where the underlying value can be
// `undefined`.

function buildPlatformDiagnosticsView({
  capabilities,
  contentProtectionActive,
  capture,
  hostAudioCapture,
  backgroundMemory,
  promptCache,
  shortcuts,
  timestamp
} = {}) {
  return {
    capabilities: capabilities || null,
    contentProtectionActive: contentProtectionActive === true,
    capture: capture || null,
    hostAudioCapture: hostAudioCapture || null,
    backgroundMemory: backgroundMemory || null,
    promptCache: promptCache || null,
    shortcuts: Array.isArray(shortcuts) ? shortcuts : [],
    timestamp: timestamp || null
  };
}

module.exports = {
  buildPlatformDiagnosticsView
};
