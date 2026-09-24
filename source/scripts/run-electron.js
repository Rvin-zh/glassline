'use strict';

// Launcher that strips ELECTRON_RUN_AS_NODE before spawning the Electron binary.
// Without this, shells that already export ELECTRON_RUN_AS_NODE=1 (some IDE
// terminals do) cause `electron .` to start in pure-Node mode — no window, and
// `require('electron')` returns a path string instead of the Electron API.
//
// On Fedora/GNOME Wayland, Phase 1A defaults to the XWayland compatibility
// profile so window placement, opacity, and screenshot-desktop keep working.

const { spawn } = require('child_process');
const electronBinary = require('electron');
const {
  applyLinuxDisplayLaunchEnv,
  getLinuxDisplayLaunchArgs
} = require('../src/platform/capabilities');

const { env: launchEnv, capabilities } = applyLinuxDisplayLaunchEnv(process.env);
delete launchEnv.ELECTRON_RUN_AS_NODE;

console.log('[run-electron] Platform capabilities:', {
  platform: capabilities.platform,
  sessionType: capabilities.sessionType,
  desktopEnvironment: capabilities.desktopEnvironment,
  linuxDisplayProfile: capabilities.linuxDisplayProfile,
  screenshotBackend: capabilities.screenshotBackend,
  hostAudioBackend: capabilities.hostAudioBackend
});

if (capabilities.notes.length > 0) {
  for (const note of capabilities.notes) {
    console.log(`[run-electron] ${note}`);
  }
}

const forwardedArgs = process.argv.slice(2);
const hasExplicitOzonePlatform = forwardedArgs.some((arg) => (
  String(arg).startsWith('--ozone-platform=')
));
const displayArgs = hasExplicitOzonePlatform
  ? []
  : getLinuxDisplayLaunchArgs(capabilities);
const args = [...displayArgs, '.', ...forwardedArgs];

if (displayArgs.length > 0) {
  console.log(`[run-electron] Chromium display backend: ${displayArgs.join(' ')}`);
}

// Electron 28+ sandbox issues are common on Fedora without setuid chrome-sandbox.
if (process.platform === 'linux' && !args.includes('--no-sandbox')) {
  args.push('--no-sandbox');
}

const child = spawn(electronBinary, args, { stdio: 'inherit', env: launchEnv });

child.on('exit', (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal);
    return;
  }
  process.exit(code ?? 0);
});

child.on('error', (err) => {
  console.error('[run-electron] Failed to spawn Electron:', err.message);
  process.exit(1);
});
