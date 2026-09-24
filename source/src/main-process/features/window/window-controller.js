const {
  WINDOW_DEFAULT_WIDTH,
  WINDOW_DEFAULT_HEIGHT,
  WINDOW_MIN_WIDTH,
  WINDOW_MIN_HEIGHT,
  WINDOW_OPACITY_LEVEL_MIN,
  WINDOW_OPACITY_LEVEL_MAX,
  DEFAULT_WINDOW_OPACITY_LEVEL,
  STEALTH_WINDOW_OPACITY
} = require('./window-constants');
const { getKeyboardShortcutAccelerator } = require('../../../config');
const { applyContentProtection } = require('../../../platform/content-protection');

function createWindowController({
  app,
  screen,
  globalShortcut,
  createAssistantWindow,
  getAppEnvironment,
  emitSttDebug,
  sendToRenderer,
  onTakeStealthScreenshot
}) {
  let mainWindow = null;
  let isVisible = true;
  let autoHideTimer = null;
  let isRecoveryReloadInProgress = false;
  let lastRecoveryReloadAt = 0;
  let activeWindowOpacityLevel = DEFAULT_WINDOW_OPACITY_LEVEL;
  let lastShortcutResults = [];
  let lastPlatformCapabilities = null;
  let lastContentProtectionActive = false;

  const RECOVERY_RELOAD_COOLDOWN_MS = 5000;

  function clamp(value, min, max) {
    return Math.min(Math.max(value, min), max);
  }

  function clampWindowOpacityLevel(level) {
    const parsedLevel = Number.parseInt(String(level ?? ''), 10);

    if (!Number.isFinite(parsedLevel)) {
      return DEFAULT_WINDOW_OPACITY_LEVEL;
    }

    return clamp(parsedLevel, WINDOW_OPACITY_LEVEL_MIN, WINDOW_OPACITY_LEVEL_MAX);
  }

  function setWindowOpacityLevel(level) {
    activeWindowOpacityLevel = clampWindowOpacityLevel(level);
    applyWindowOpacity();
    return activeWindowOpacityLevel;
  }

  function getWindowOpacityLevel() {
    return activeWindowOpacityLevel;
  }

  function getWindowOpacityFromLevel(level) {
    return clampWindowOpacityLevel(level) / 10;
  }

  function getVisibleWindowOpacity() {
    return getWindowOpacityFromLevel(activeWindowOpacityLevel);
  }

  function getStealthWindowOpacity() {
    return Math.min(getVisibleWindowOpacity(), STEALTH_WINDOW_OPACITY);
  }

  function getCurrentWindowOpacity() {
    return isVisible ? getVisibleWindowOpacity() : getStealthWindowOpacity();
  }

  function applyWindowOpacity() {
    if (!mainWindow || mainWindow.isDestroyed()) {
      return;
    }

    mainWindow.setOpacity(getCurrentWindowOpacity());
  }

  function recoverMainWindowVisibility(reason, { reload = false } = {}) {
    if (!mainWindow || mainWindow.isDestroyed()) {
      return;
    }

    console.warn(`Window recovery triggered: ${reason}`);
    if (typeof emitSttDebug === 'function') {
      emitSttDebug({
        level: 'error',
        event: 'window-recovery',
        message: reason
      });
    }

    try {
      if (autoHideTimer) {
        clearTimeout(autoHideTimer);
        autoHideTimer = null;
      }

      isVisible = true;
      mainWindow.setOpacity(getVisibleWindowOpacity());
      if (!mainWindow.isVisible()) {
        mainWindow.show();
      }
      sendToRenderer('set-stealth-mode', false);
    } catch (error) {
      console.error('Window visibility recovery failed:', error);
    }

    if (!reload || !mainWindow.webContents || mainWindow.webContents.isDestroyed()) {
      return;
    }

    const now = Date.now();
    if (isRecoveryReloadInProgress || now - lastRecoveryReloadAt < RECOVERY_RELOAD_COOLDOWN_MS) {
      return;
    }

    isRecoveryReloadInProgress = true;
    lastRecoveryReloadAt = now;
    try {
      mainWindow.webContents.reload();
      if (typeof emitSttDebug === 'function') {
        emitSttDebug({
          event: 'window-reload',
          message: 'Triggered guarded renderer reload'
        });
      }
    } catch (error) {
      console.error('Window recovery reload failed:', error);
      isRecoveryReloadInProgress = false;
      return;
    }

    setTimeout(() => {
      isRecoveryReloadInProgress = false;
    }, 1500);
  }

  function attachWindowRecoveryHandlers() {
    if (!mainWindow || mainWindow.isDestroyed()) {
      return;
    }

    mainWindow.on('unresponsive', () => {
      console.error('Main window became unresponsive');
      recoverMainWindowVisibility('window-unresponsive', { reload: true });
    });

    const contents = mainWindow.webContents;
    if (!contents || contents.isDestroyed()) {
      return;
    }

    contents.on('render-process-gone', (_event, details) => {
      console.error('Renderer process gone:', details);
      recoverMainWindowVisibility('render-process-gone', { reload: true });
    });

    contents.on('unresponsive', () => {
      console.error('WebContents became unresponsive');
      recoverMainWindowVisibility('webcontents-unresponsive', { reload: true });
    });

    contents.on('did-fail-load', (_event, errorCode, errorDescription, validatedURL, isMainFrame) => {
      console.error('WebContents did-fail-load:', {
        errorCode,
        errorDescription,
        validatedURL,
        isMainFrame
      });
      recoverMainWindowVisibility('did-fail-load', { reload: !!isMainFrame });
    });

    contents.on('did-finish-load', () => {
      isRecoveryReloadInProgress = false;
    });
  }

  function createWindow({ launchHidden = false, platformCapabilities = null } = {}) {
    const appEnvironment = getAppEnvironment();
    lastPlatformCapabilities = platformCapabilities;
    mainWindow = createAssistantWindow({
      app,
      screen,
      defaultWidth: WINDOW_DEFAULT_WIDTH,
      defaultHeight: WINDOW_DEFAULT_HEIGHT,
      minWidth: WINDOW_MIN_WIDTH,
      minHeight: WINDOW_MIN_HEIGHT,
      hideFromScreenCapture: appEnvironment.hideFromScreenCapture,
      initialOpacity: launchHidden ? getStealthWindowOpacity() : getVisibleWindowOpacity(),
      launchHidden,
      nodeEnv: appEnvironment.nodeEnv,
      platformCapabilities: platformCapabilities || undefined
    });

    attachWindowRecoveryHandlers();
    isVisible = !launchHidden;

    // Apply content protection immediately after the window is created so
    // `getContentProtectionActive()` reflects the launch hide state before
    // any diagnostics or settings save runs. This is best-effort: on
    // unsupported platforms `applyContentProtectionToWindow` is a no-op and
    // `lastContentProtectionActive` stays false.
    applyContentProtectionToWindow();

    return mainWindow;
  }

  function getMainWindow() {
    return mainWindow;
  }

  function getSafeWindowBounds(nextBounds = {}) {
    const currentBounds = mainWindow ? mainWindow.getBounds() : {
      x: 0,
      y: 0,
      width: WINDOW_DEFAULT_WIDTH,
      height: WINDOW_DEFAULT_HEIGHT
    };

    const rawBounds = {
      x: Number.isFinite(nextBounds.x) ? Math.round(nextBounds.x) : currentBounds.x,
      y: Number.isFinite(nextBounds.y) ? Math.round(nextBounds.y) : currentBounds.y,
      width: Number.isFinite(nextBounds.width) ? Math.round(nextBounds.width) : currentBounds.width,
      height: Number.isFinite(nextBounds.height) ? Math.round(nextBounds.height) : currentBounds.height
    };

    const display = screen.getDisplayMatching(rawBounds);
    const workArea = display && display.workArea ? display.workArea : screen.getPrimaryDisplay().workArea;

    const width = clamp(rawBounds.width, WINDOW_MIN_WIDTH, workArea.width);
    const height = clamp(rawBounds.height, WINDOW_MIN_HEIGHT, workArea.height);
    const x = clamp(rawBounds.x, workArea.x, workArea.x + workArea.width - width);
    const y = clamp(rawBounds.y, workArea.y, workArea.y + workArea.height - height);

    return { x, y, width, height };
  }

  function setWindowBounds(nextBounds) {
    if (!mainWindow || mainWindow.isDestroyed()) {
      return { error: 'Main window not available' };
    }

    const safeBounds = getSafeWindowBounds(nextBounds);
    mainWindow.setBounds(safeBounds, false);
    return mainWindow.getBounds();
  }

  function getWindowBounds() {
    if (!mainWindow || mainWindow.isDestroyed()) {
      return { error: 'Main window not available' };
    }

    return mainWindow.getBounds();
  }

  function toggleStealthMode() {
    if (autoHideTimer) {
      clearTimeout(autoHideTimer);
      autoHideTimer = null;
    }

    if (!mainWindow || mainWindow.isDestroyed()) {
      return;
    }

    const stealthModeEnabled = isVisible;
    isVisible = !stealthModeEnabled;
    if (isVisible && !mainWindow.isVisible()) {
      mainWindow.showInactive();
    }
    applyWindowOpacity();
    sendToRenderer('set-stealth-mode', stealthModeEnabled);
  }

  function emergencyHide() {
    if (autoHideTimer) {
      clearTimeout(autoHideTimer);
      autoHideTimer = null;
    }

    if (!mainWindow || mainWindow.isDestroyed()) {
      return;
    }

    mainWindow.setOpacity(0.01);
    sendToRenderer('emergency-clear');

    autoHideTimer = setTimeout(() => {
      if (mainWindow && !mainWindow.isDestroyed()) {
        isVisible = true;
        applyWindowOpacity();
        sendToRenderer('set-stealth-mode', false);
      }
      autoHideTimer = null;
    }, 2000);
  }

  function moveToPosition(position) {
    if (!mainWindow || mainWindow.isDestroyed()) {
      return;
    }

    const { width, height } = screen.getPrimaryDisplay().workAreaSize;
    const windowBounds = mainWindow.getBounds();

    let x;
    let y;

    switch (position) {
      case 'left':
        x = 20;
        y = windowBounds.y;
        break;
      case 'right':
        x = width - windowBounds.width - 20;
        y = windowBounds.y;
        break;
      case 'top':
        x = Math.floor((width - windowBounds.width) / 2);
        y = 40;
        break;
      case 'bottom':
        x = Math.floor((width - windowBounds.width) / 2);
        y = height - windowBounds.height - 40;
        break;
      default:
        return;
    }

    mainWindow.setPosition(x, y);
  }

  function clampWindowSizePreset(preset) {
    const parsedPreset = Number.parseInt(String(preset ?? ''), 10);
    if (!Number.isFinite(parsedPreset)) {
      return 1;
    }

    return clamp(parsedPreset, 1, 4);
  }

  function getWindowSizeScaleForPreset(preset) {
    const clampedPreset = clampWindowSizePreset(preset);
    return 1 + ((clampedPreset - 1) * 0.25);
  }

  function setWindowSizePreset(preset) {
    if (!mainWindow || mainWindow.isDestroyed()) {
      return { error: 'Main window not available' };
    }

    const clampedPreset = clampWindowSizePreset(preset);
    const scale = getWindowSizeScaleForPreset(clampedPreset);
    const currentBounds = mainWindow.getBounds();

    const width = Math.round(WINDOW_MIN_WIDTH * scale);
    const height = Math.round(WINDOW_MIN_HEIGHT * scale);

    const centerX = currentBounds.x + Math.round(currentBounds.width / 2);
    const centerY = currentBounds.y + Math.round(currentBounds.height / 2);

    const nextBounds = getSafeWindowBounds({
      x: centerX - Math.round(width / 2),
      y: centerY - Math.round(height / 2),
      width,
      height
    });

    mainWindow.setBounds(nextBounds, false);
    return {
      ...mainWindow.getBounds(),
      preset: clampedPreset
    };
  }

  function registerShortcuts() {
    const results = [];

    const registerShortcut = (shortcutId, handler) => {
      const accelerator = getKeyboardShortcutAccelerator(shortcutId);
      let isRegistered = false;
      try {
        isRegistered = globalShortcut.register(accelerator, handler);
      } catch (error) {
        console.warn(`Shortcut registration threw for "${shortcutId}":`, error.message);
      }

      if (!isRegistered) {
        console.warn(`Failed to register shortcut "${shortcutId}" (${accelerator})`);
      }

      results.push({
        id: shortcutId,
        accelerator,
        registered: Boolean(isRegistered)
      });
    };

    registerShortcut('toggleStealth', () => {
      toggleStealthMode();
    });

    registerShortcut('takeScreenshot', async () => {
      if (typeof onTakeStealthScreenshot === 'function') {
        await onTakeStealthScreenshot();
      }
    });

    registerShortcut('askAi', async () => {
      if (typeof emitSttDebug === 'function') {
        emitSttDebug({
          event: 'shortcut-ask-ai',
          message: 'Global Ask AI shortcut triggered'
        });
      }
      sendToRenderer('trigger-ask-ai');
    });

    registerShortcut('emergencyHide', () => {
      emergencyHide();
    });

    registerShortcut('toggleTranscription', () => {
      if (typeof emitSttDebug === 'function') {
        emitSttDebug({
          event: 'shortcut-toggle',
          message: 'Global transcription shortcut triggered'
        });
      }
      sendToRenderer('toggle-voice-recognition');
    });

    registerShortcut('moveWindowLeft', () => {
      moveToPosition('left');
    });

    registerShortcut('moveWindowRight', () => {
      moveToPosition('right');
    });

    registerShortcut('moveWindowUp', () => {
      moveToPosition('top');
    });

    registerShortcut('moveWindowDown', () => {
      moveToPosition('bottom');
    });

    registerShortcut('windowSizePreset1', () => {
      setWindowSizePreset(1);
    });

    registerShortcut('windowSizePreset2', () => {
      setWindowSizePreset(2);
    });

    registerShortcut('windowSizePreset3', () => {
      setWindowSizePreset(3);
    });

    registerShortcut('windowSizePreset4', () => {
      setWindowSizePreset(4);
    });

    lastShortcutResults = results;
    return results;
  }

  function setLastShortcutResults(results) {
    lastShortcutResults = Array.isArray(results) ? results : [];
  }

  function getShortcutRegistrationResults() {
    return lastShortcutResults.map((entry) => ({ ...entry }));
  }

  function getPlatformCapabilitiesSnapshot() {
    return lastPlatformCapabilities;
  }

  function applyContentProtectionToWindow() {
    const appEnvironment = getAppEnvironment();
    const capabilities = lastPlatformCapabilities || {};
    const result = applyContentProtection(mainWindow, {
      hideFromScreenCapture: appEnvironment.hideFromScreenCapture,
      contentProtectionSupported: capabilities.contentProtectionSupported === true
    });
    lastContentProtectionActive = result?.active === true;
    return result;
  }

  // Read-only accessor for the last `applyContentProtection` result's
    // `active` flag. Used by diagnostics so we do not re-call Electron's
    // `setContentProtection` just to read current hide state.
  function getContentProtectionActive() {
    return lastContentProtectionActive;
  }

  function unregisterShortcuts() {
    globalShortcut.unregisterAll();
  }

  function destroyWindow() {
    if (autoHideTimer) {
      clearTimeout(autoHideTimer);
      autoHideTimer = null;
    }

    if (!mainWindow || mainWindow.isDestroyed()) {
      return;
    }

    mainWindow.setClosable(true);
    mainWindow.destroy();
    mainWindow = null;
  }

  function hasWindow() {
    return !!mainWindow && !mainWindow.isDestroyed();
  }

  function markVisible() {
    isVisible = true;
    if (mainWindow && !mainWindow.isDestroyed() && !mainWindow.isVisible()) {
      mainWindow.showInactive();
    }
    applyWindowOpacity();
  }

  return {
    applyContentProtection: applyContentProtectionToWindow,
    applyWindowOpacity,
    clampWindowOpacityLevel,
    createWindow,
    destroyWindow,
    emergencyHide,
    getContentProtectionActive,
    getMainWindow,
    getPlatformCapabilitiesSnapshot,
    getShortcutRegistrationResults,
    getWindowBounds,
    getWindowOpacityLevel,
    hasWindow,
    markVisible,
    registerShortcuts,
    setLastShortcutResults,
    setWindowSizePreset,
    setWindowBounds,
    setWindowOpacityLevel,
    toggleStealthMode,
    unregisterShortcuts
  };
}

module.exports = {
  createWindowController
};
