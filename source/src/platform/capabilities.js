'use strict';

const os = require('os');
const fs = require('fs');
const { execFileSync } = require('child_process');

function readEnv(name) {
  return String(process.env[name] || '').trim();
}

function detectSessionType() {
  const explicit = readEnv('OPEN_CLUELY_SESSION_TYPE').toLowerCase();
  if (explicit === 'wayland' || explicit === 'x11') {
    return explicit;
  }

  const xdgSession = readEnv('XDG_SESSION_TYPE').toLowerCase();
  if (xdgSession === 'wayland' || xdgSession === 'x11') {
    return xdgSession;
  }

  if (readEnv('WAYLAND_DISPLAY')) {
    return 'wayland';
  }

  if (readEnv('DISPLAY')) {
    return 'x11';
  }

  return 'unknown';
}

function detectDesktopEnvironment() {
  const desktop = (
    readEnv('XDG_CURRENT_DESKTOP') ||
    readEnv('DESKTOP_SESSION') ||
    readEnv('GDMSESSION')
  ).toLowerCase();

  if (desktop.includes('gnome')) return 'gnome';
  if (desktop.includes('kde') || desktop.includes('plasma')) return 'kde';
  if (desktop.includes('sway')) return 'sway';
  if (desktop.includes('hyprland')) return 'hyprland';
  if (desktop.includes('xfce')) return 'xfce';
  return desktop || 'unknown';
}

function hasCommand(commandName) {
  try {
    execFileSync('sh', ['-c', `command -v ${commandName}`], {
      stdio: ['ignore', 'pipe', 'ignore'],
      env: process.env
    });
    return true;
  } catch (_) {
    try {
      return fs.existsSync(`/usr/bin/${commandName}`) || fs.existsSync(`/bin/${commandName}`);
    } catch (__) {
      return false;
    }
  }
}

function resolveLinuxDisplayProfile() {
  const override = readEnv('OPEN_CLUELY_DISPLAY_PROFILE').toLowerCase();
  if (override === 'xwayland' || override === 'wayland' || override === 'x11') {
    return override;
  }

  const sessionType = detectSessionType();
  if (sessionType === 'wayland') {
    // Phase 1A default: prefer XWayland compatibility for window placement,
    // opacity, and existing screenshot tooling on GNOME Wayland.
    return 'xwayland';
  }

  if (sessionType === 'x11') {
    return 'x11';
  }

  return 'unknown';
}

function detectPlatformCapabilities(overrides = {}) {
  const platform = overrides.platform || process.platform;
  const sessionType = detectSessionType();
  const desktopEnvironment = detectDesktopEnvironment();
  const linuxDisplayProfile = platform === 'linux'
    ? resolveLinuxDisplayProfile()
    : null;

  const contentProtectionSupported = platform === 'win32' || platform === 'darwin';
  const alwaysOnTopReliable = platform !== 'linux' || linuxDisplayProfile !== 'wayland';
  const programmaticWindowMoveReliable = platform !== 'linux' || linuxDisplayProfile !== 'wayland';
  const screenshotBackend = (() => {
    if (platform === 'win32' || platform === 'darwin') {
      return 'screenshot-desktop';
    }

    if (
      platform === 'linux' &&
      (
        sessionType === 'wayland' ||
        linuxDisplayProfile === 'wayland' ||
        linuxDisplayProfile === 'xwayland'
      )
    ) {
      return 'xdg-screenshot-portal';
    }

    if (linuxDisplayProfile === 'x11') {
      return hasCommand('import') || hasCommand('scrot')
        ? 'screenshot-desktop-x11'
        : 'unavailable';
    }

    return 'unavailable';
  })();

  const hostAudioBackend = (() => {
    if (platform === 'win32' || platform === 'darwin') {
      return 'desktop-capturer-loopback';
    }

    if (hasCommand('pactl') || hasCommand('pw-cli')) {
      return 'pipewire-monitor';
    }

    return 'unavailable';
  })();

  return {
    platform,
    sessionType,
    desktopEnvironment,
    linuxDisplayProfile,
    contentProtectionSupported,
    alwaysOnTopReliable,
    programmaticWindowMoveReliable,
    globalShortcutsReliable: platform !== 'linux' || linuxDisplayProfile !== 'wayland' || desktopEnvironment !== 'unknown',
    screenshotBackend,
    hostAudioBackend,
    hasImageMagick: hasCommand('import') || hasCommand('magick'),
    hasXrandr: hasCommand('xrandr'),
    hasPipeWireTools: hasCommand('pw-cli') || hasCommand('pactl'),
    notes: [
      !contentProtectionSupported
        ? 'Screen-capture exclusion (setContentProtection) is unsupported on Linux.'
        : null,
      platform === 'darwin'
        ? 'Microphone and Screen Recording are granted in System Settings → Privacy & Security.'
        : null,
      linuxDisplayProfile === 'xwayland'
        ? 'Launching under XWayland for Fedora window placement and opacity compatibility; Wayland screenshots use the XDG portal.'
        : null,
      linuxDisplayProfile === 'wayland'
        ? 'Native Wayland mode: programmatic move/resize and always-on-top may be compositor-limited.'
        : null
    ].filter(Boolean)
  };
}

function getLinuxDisplayLaunchArgs(capabilities = detectPlatformCapabilities()) {
  if (!capabilities || capabilities.platform !== 'linux') {
    return [];
  }

  if (
    capabilities.linuxDisplayProfile === 'xwayland'
    || capabilities.linuxDisplayProfile === 'x11'
  ) {
    return ['--ozone-platform=x11'];
  }

  if (capabilities.linuxDisplayProfile === 'wayland') {
    return ['--ozone-platform=wayland'];
  }

  return [];
}

function applyLinuxDisplayLaunchEnv(env = process.env) {
  const nextEnv = { ...env };
  const capabilities = detectPlatformCapabilities();

  if (capabilities.platform !== 'linux') {
    return { env: nextEnv, capabilities };
  }

  if (capabilities.linuxDisplayProfile === 'xwayland') {
    nextEnv.GDK_BACKEND = nextEnv.GDK_BACKEND || 'x11';
  }

  return { env: nextEnv, capabilities };
}

module.exports = {
  applyLinuxDisplayLaunchEnv,
  detectDesktopEnvironment,
  detectPlatformCapabilities,
  detectSessionType,
  getLinuxDisplayLaunchArgs,
  resolveLinuxDisplayProfile
};
