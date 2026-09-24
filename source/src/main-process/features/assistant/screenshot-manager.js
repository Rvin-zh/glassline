const fs = require('fs');
const path = require('path');
const { execFile: defaultExecFile } = require('child_process');
const screenshot = require('screenshot-desktop');
const { detectPlatformCapabilities } = require('../../../platform/capabilities');
const {
  captureXdgScreenshot: defaultCaptureXdgScreenshot,
  isNonEmptyPng
} = require('../../../platform/xdg-screenshot');

const DEFAULT_BACKEND_TIMEOUT_MS = 12_000;
const E2E_SCREENSHOT_FIXTURE_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
  'base64'
);

function isE2EScreenshotFixtureEnabled(environment = process.env) {
  return (
    String(environment?.OPEN_CLUELY_E2E || '') === '1' &&
    String(environment?.OPEN_CLUELY_E2E_SCREENSHOT_FIXTURE || '') === '1'
  );
}

function normalizeCaptureOrigin(origin) {
  const requestedOrigin = origin && typeof origin === 'object'
    ? origin.origin
    : origin;
  return requestedOrigin === 'auto' ? 'auto' : 'manual';
}

function createScreenshotManager({
  app,
  getMainWindow,
  getAppEnvironment,
  sendToRenderer,
  desktopCapturer = null,
  captureXdgScreenshot = defaultCaptureXdgScreenshot,
  screenshotCapture = screenshot,
  execFile = defaultExecFile,
  detectCapabilities = detectPlatformCapabilities,
  backendTimeoutMs = DEFAULT_BACKEND_TIMEOUT_MS
}) {
  let screenshots = [];
  let screenshotSequence = 0;
  let screenshotInProgress = false;
  let portalCaptureSourceId = null;
  let lastCaptureBackend = null;
  let lastCaptureError = null;
  let lastCaptureErrorCode = null;
  let lastCaptureAttempts = [];

  const normalizedBackendTimeoutMs = (() => {
    const parsed = Number.parseInt(String(backendTimeoutMs ?? ''), 10);
    return Number.isFinite(parsed) && parsed > 0
      ? parsed
      : DEFAULT_BACKEND_TIMEOUT_MS;
  })();

  function nextScreenshotId() {
    screenshotSequence += 1;
    return `ss-${Date.now()}-${screenshotSequence}`;
  }

  function normalizeScreenshotEntry(entry) {
    if (!entry) return null;

    if (typeof entry === 'string') {
      return {
        id: null,
        path: entry,
        timestamp: null,
        backend: null,
        origin: 'manual'
      };
    }

    if (typeof entry.path === 'string') {
      return {
        id: typeof entry.id === 'string' ? entry.id : null,
        path: entry.path,
        timestamp: typeof entry.timestamp === 'string' ? entry.timestamp : null,
        backend: typeof entry.backend === 'string' ? entry.backend : null,
        origin: normalizeCaptureOrigin(entry.origin)
      };
    }

    return null;
  }

  function getScreenshotsDir() {
    return app.isPackaged
      ? path.join(app.getPath('userData'), '.stealth_screenshots')
      : path.join(__dirname, '..', '..', '..', '..', '.stealth_screenshots');
  }

  function ensureScreenshotsDir() {
    const screenshotsDir = getScreenshotsDir();
    if (!fs.existsSync(screenshotsDir)) {
      fs.mkdirSync(screenshotsDir, { recursive: true });
    }
    return screenshotsDir;
  }

  function cleanupScreenshotFile(entry) {
    const normalizedEntry = normalizeScreenshotEntry(entry);
    if (normalizedEntry && fs.existsSync(normalizedEntry.path)) {
      fs.unlinkSync(normalizedEntry.path);
    }
  }

  function createCaptureError(code, message, backend = null) {
    const error = new Error(message);
    error.code = code;
    error.backend = backend;
    return error;
  }

  function safeBackendError(error, backend) {
    const code = typeof error?.code === 'string'
      ? error.code
      : 'CAPTURE_BACKEND_FAILED';

    if (code === 'CAPTURE_TIMEOUT' || code === 'PORTAL_TIMEOUT') {
      return {
        code: backend === 'xdg-screenshot-portal' ? 'PORTAL_TIMEOUT' : code,
        message: `${backend} timed out`
      };
    }
    if (code === 'PORTAL_PERMISSION_DENIED') {
      return {
        code,
        message: 'Screenshot portal permission was denied'
      };
    }
    if (code === 'PORTAL_CANCELLED') {
      return {
        code,
        message: 'Screenshot portal request was cancelled'
      };
    }
    if (code === 'PORTAL_UNAVAILABLE') {
      return {
        code,
        message: 'Screenshot portal is unavailable'
      };
    }
    if (code === 'CAPTURE_INVALID_OUTPUT' || code === 'PORTAL_INVALID_OUTPUT') {
      return {
        code,
        message: `${backend} returned invalid PNG output`
      };
    }
    return {
      code: 'CAPTURE_BACKEND_FAILED',
      message: `${backend} failed`
    };
  }

  async function withBackendTimeout(backend, operation) {
    let timeoutHandle = null;
    try {
      return await Promise.race([
        Promise.resolve().then(operation),
        new Promise((_, reject) => {
          timeoutHandle = setTimeout(() => {
            reject(createCaptureError(
              'CAPTURE_TIMEOUT',
              `${backend} timed out`,
              backend
            ));
          }, normalizedBackendTimeoutMs);
        })
      ]);
    } finally {
      clearTimeout(timeoutHandle);
    }
  }

  function invokeExecFile(file, args, options) {
    return new Promise((resolve, reject) => {
      execFile(file, args, options, (error, stdout, stderr) => {
        if (error) {
          reject(error);
          return;
        }
        resolve({ stdout, stderr });
      });
    });
  }

  function isLinuxWaylandSession(capabilities) {
    return (
      capabilities?.platform === 'linux' &&
      (
        capabilities?.sessionType === 'wayland' ||
        capabilities?.linuxDisplayProfile === 'wayland' ||
        capabilities?.linuxDisplayProfile === 'xwayland'
      )
    );
  }

  async function captureWithXdgScreenshot(screenshotPath) {
    const processTimeoutMs = Math.max(10, normalizedBackendTimeoutMs - 100);
    const portalTimeoutMs = Math.max(10, processTimeoutMs - 500);
    await captureXdgScreenshot(screenshotPath, {
      app,
      portalTimeoutMs,
      processTimeoutMs
    });
    return 'xdg-screenshot-portal';
  }

  async function captureWithScreenshotDesktop(screenshotPath) {
    await screenshotCapture({ filename: screenshotPath });
    return 'screenshot-desktop';
  }

  async function captureWithDesktopCapturer(screenshotPath) {
    if (!desktopCapturer || typeof desktopCapturer.getSources !== 'function') {
      throw new Error('desktopCapturer is unavailable');
    }

    const sources = await desktopCapturer.getSources({
      types: ['screen'],
      thumbnailSize: { width: 1920, height: 1080 }
    });

    if (!Array.isArray(sources) || sources.length === 0) {
      throw new Error('No desktop capture sources available');
    }

    let source = sources[0];
    if (portalCaptureSourceId) {
      const remembered = sources.find((entry) => entry.id === portalCaptureSourceId);
      if (remembered) {
        source = remembered;
      }
    } else {
      portalCaptureSourceId = source.id;
    }

    const pngBuffer = source.thumbnail.toPNG();
    if (!pngBuffer || pngBuffer.length === 0) {
      throw new Error('desktopCapturer returned an empty thumbnail');
    }

    fs.writeFileSync(screenshotPath, pngBuffer);
    return 'desktop-capturer';
  }

  async function captureWithGrim(screenshotPath) {
    await invokeExecFile(
      'grim',
      [screenshotPath],
      {
        timeout: Math.max(10, normalizedBackendTimeoutMs - 100),
        killSignal: 'SIGKILL',
        windowsHide: true
      }
    );
    return 'grim';
  }

  async function captureWithE2EFixture(screenshotPath) {
    fs.writeFileSync(screenshotPath, E2E_SCREENSHOT_FIXTURE_PNG, {
      mode: 0o600
    });
    return 'e2e-fixture';
  }

  function buildCaptureAttempts(capabilities) {
    if (isE2EScreenshotFixtureEnabled()) {
      return [{
        backend: 'e2e-fixture',
        capture: captureWithE2EFixture
      }];
    }

    if (isLinuxWaylandSession(capabilities)) {
      return [
        {
          backend: 'xdg-screenshot-portal',
          capture: captureWithXdgScreenshot
        },
        {
          backend: 'grim',
          capture: captureWithGrim
        },
        {
          backend: 'desktop-capturer',
          capture: captureWithDesktopCapturer
        }
      ];
    }

    if (capabilities?.platform === 'linux') {
      const linuxAttempts = [];
      if (capabilities.hasImageMagick === false) {
        linuxAttempts.push({
          backend: 'desktop-capturer',
          capture: captureWithDesktopCapturer
        });
      }
      linuxAttempts.push({
        backend: 'screenshot-desktop',
        capture: captureWithScreenshotDesktop
      });
      if (!linuxAttempts.some(({ backend }) => backend === 'desktop-capturer')) {
        linuxAttempts.push({
          backend: 'desktop-capturer',
          capture: captureWithDesktopCapturer
        });
      }
      return linuxAttempts;
    }

    return [{
      backend: 'screenshot-desktop',
      capture: captureWithScreenshotDesktop
    }];
  }

  function createAttemptPath(screenshotPath, backend, attemptIndex) {
    const safeBackend = backend.replace(/[^a-z0-9-]/gi, '-');
    return path.join(
      path.dirname(screenshotPath),
      `.${path.basename(screenshotPath)}.${attemptIndex}-${safeBackend}.png`
    );
  }

  async function captureScreenshotFile(screenshotPath) {
    const capabilities = detectCapabilities();
    const attempts = buildCaptureAttempts(capabilities);
    lastCaptureBackend = null;
    lastCaptureError = null;
    lastCaptureErrorCode = null;
    lastCaptureAttempts = [];

    let portalError = null;
    for (let index = 0; index < attempts.length; index += 1) {
      const attempt = attempts[index];
      const attemptPath = createAttemptPath(
        screenshotPath,
        attempt.backend,
        index + 1
      );
      try {
        fs.rmSync(attemptPath, { force: true });
      } catch (_) {
        // Best-effort cleanup before a fresh backend attempt.
      }

      try {
        await withBackendTimeout(
          attempt.backend,
          () => attempt.capture(attemptPath)
        );
        if (!isNonEmptyPng(attemptPath)) {
          throw createCaptureError(
            'CAPTURE_INVALID_OUTPUT',
            `${attempt.backend} returned invalid PNG output`,
            attempt.backend
          );
        }
        fs.rmSync(screenshotPath, { force: true });
        fs.renameSync(attemptPath, screenshotPath);
        lastCaptureBackend = attempt.backend;
        lastCaptureError = null;
        lastCaptureErrorCode = null;
        lastCaptureAttempts.push({
          backend: attempt.backend,
          status: 'success',
          code: null
        });
        return attempt.backend;
      } catch (error) {
        const safeError = safeBackendError(error, attempt.backend);
        if (attempt.backend === 'xdg-screenshot-portal') {
          portalError = safeError;
        }
        lastCaptureError = safeError.message;
        lastCaptureErrorCode = safeError.code;
        lastCaptureAttempts.push({
          backend: attempt.backend,
          status: 'failed',
          code: safeError.code
        });
      } finally {
        try {
          fs.rmSync(attemptPath, { force: true });
        } catch (_) {
          // Best-effort cleanup after each backend attempt.
        }
      }
    }

    const primaryBackend = attempts[0]?.backend || null;
    const portalFailure = isLinuxWaylandSession(capabilities)
      ? portalError
      : null;
    const failureDetails = (() => {
      if (portalFailure?.code === 'PORTAL_PERMISSION_DENIED') {
        return {
          code: 'PORTAL_PERMISSION_DENIED',
          message: 'Screenshot permission was denied by the XDG screenshot portal and no fallback backend succeeded.'
        };
      }
      if (portalFailure?.code === 'PORTAL_CANCELLED') {
        return {
          code: 'PORTAL_CANCELLED',
          message: 'The XDG screenshot portal request was cancelled and no fallback backend succeeded.'
        };
      }
      if (portalFailure?.code === 'PORTAL_TIMEOUT') {
        return {
          code: 'PORTAL_TIMEOUT',
          message: 'The XDG screenshot portal timed out and no fallback backend succeeded.'
        };
      }
      if (portalFailure?.code === 'PORTAL_UNAVAILABLE') {
        return {
          code: 'PORTAL_UNAVAILABLE',
          message: 'The XDG screenshot portal is unavailable and no fallback backend succeeded.'
        };
      }
      return {
        code: isLinuxWaylandSession(capabilities)
          ? 'WAYLAND_SCREENSHOT_FAILED'
          : 'SCREENSHOT_FAILED',
        message: isLinuxWaylandSession(capabilities)
          ? 'Screenshot capture failed. Check XDG screenshot portal availability and screenshot permissions.'
          : 'Screenshot capture failed. No supported screenshot backend succeeded.'
      };
    })();
    const finalError = createCaptureError(
      failureDetails.code,
      failureDetails.message,
      primaryBackend
    );
    lastCaptureError = failureDetails.message;
    lastCaptureErrorCode = failureDetails.code;
    throw finalError;
  }

  async function takeStealthScreenshot(origin = 'manual') {
    if (screenshotInProgress) {
      return {
        success: false,
        busy: true,
        code: 'SCREENSHOT_BUSY',
        backend: null
      };
    }

    const mainWindow = getMainWindow();
    const appEnvironment = getAppEnvironment();
    const captureOrigin = normalizeCaptureOrigin(origin);

    if (!mainWindow || mainWindow.isDestroyed()) {
      throw new Error('Main window not available');
    }

    screenshotInProgress = true;
    let currentOpacity = null;
    let hasCurrentOpacity = false;
    let hiddenForCapture = false;
    let wasVisible = false;
    try {
      console.log('Taking stealth screenshot...');
      const configuredDelay = Number(appEnvironment?.screenshotDelay);
      const screenshotDelay = Number.isFinite(configuredDelay)
        ? Math.max(0, configuredDelay)
        : 300;
      const capabilities = detectCapabilities();

      if (capabilities.platform === 'linux') {
        wasVisible = typeof mainWindow.isVisible === 'function'
          ? mainWindow.isVisible()
          : true;
        if (wasVisible) {
          mainWindow.hide();
          hiddenForCapture = true;
        }
      } else {
        currentOpacity = mainWindow.getOpacity();
        hasCurrentOpacity = true;
        mainWindow.setOpacity(0.01);
      }

      await new Promise((resolve) => setTimeout(resolve, screenshotDelay));

      const screenshotsDir = ensureScreenshotsDir();
      const screenshotId = nextScreenshotId();
      const screenshotPath = path.join(screenshotsDir, `stealth-${screenshotId}.png`);

      const backend = await captureScreenshotFile(screenshotPath);

      const screenshotEntry = {
        id: screenshotId,
        path: screenshotPath,
        timestamp: new Date().toISOString(),
        backend,
        origin: captureOrigin
      };

      const replacedScreenshotIds = [];
      if (captureOrigin === 'auto') {
        const retained = [];
        for (const entry of screenshots) {
          if (normalizeCaptureOrigin(entry?.origin) === 'auto') {
            cleanupScreenshotFile(entry);
            if (typeof entry?.id === 'string') {
              replacedScreenshotIds.push(entry.id);
            }
          } else {
            retained.push(entry);
          }
        }
        screenshots = retained;
      } else {
        const configuredMax = Number.parseInt(
          String(appEnvironment?.maxScreenshots ?? ''),
          10
        );
        const maxManualScreenshots =
          Number.isFinite(configuredMax) && configuredMax > 0
            ? configuredMax
            : 50;
        while (
          screenshots.filter((entry) => (
            normalizeCaptureOrigin(entry?.origin) === 'manual'
          )).length >= maxManualScreenshots
        ) {
          const oldestManualIndex = screenshots.findIndex((entry) => (
            normalizeCaptureOrigin(entry?.origin) === 'manual'
          ));
          if (oldestManualIndex < 0) {
            break;
          }
          const [removed] = screenshots.splice(oldestManualIndex, 1);
          cleanupScreenshotFile(removed);
          if (typeof removed?.id === 'string') {
            replacedScreenshotIds.push(removed.id);
          }
        }
      }

      screenshots.push(screenshotEntry);
      console.log(`Screenshot captured via ${backend}`);
      console.log(`Total screenshots: ${screenshots.length}`);
      if (!capabilities.contentProtectionSupported) {
        console.warn('Linux cannot exclude a visible overlay from third-party screen sharing.');
      }

      sendToRenderer('screenshot-taken-stealth', {
        count: screenshots.length,
        screenshotId: screenshotEntry.id,
        timestamp: screenshotEntry.timestamp,
        backend,
        origin: captureOrigin,
        replacedScreenshotIds
      });

      return {
        success: true,
        screenshotId: screenshotEntry.id,
        count: screenshots.length,
        backend,
        replacedScreenshotIds
      };
    } catch (error) {
      console.error('Stealth screenshot failed:', {
        code: error?.code || 'SCREENSHOT_FAILED',
        backend: error?.backend || null
      });
      throw error;
    } finally {
      if (
        hiddenForCapture &&
        wasVisible &&
        !mainWindow.isDestroyed() &&
        typeof mainWindow.showInactive === 'function'
      ) {
        mainWindow.showInactive();
      } else if (hasCurrentOpacity) {
        try {
          mainWindow.setOpacity(currentOpacity);
        } catch (_) {
          console.warn('Failed to restore prior window opacity after screenshot');
        }
      }
      screenshotInProgress = false;
    }
  }

  async function buildImagePartsFromScreenshots({ strict = true, includeIds = null } = {}) {
    const includeIdSet = Array.isArray(includeIds)
      ? new Set(includeIds.filter((id) => typeof id === 'string' && id.trim().length > 0))
      : null;

    const usableEntries = [];

    for (const entry of screenshots) {
      const normalizedEntry = normalizeScreenshotEntry(entry);
      if (!normalizedEntry) continue;

      if (includeIdSet && (!normalizedEntry.id || !includeIdSet.has(normalizedEntry.id))) {
        continue;
      }

      if (fs.existsSync(normalizedEntry.path)) {
        usableEntries.push(normalizedEntry);
        continue;
      }

      console.error(`Screenshot file not found: ${normalizedEntry.path}`);
      if (strict) {
        throw new Error(`Screenshot file not found: ${normalizedEntry.path}`);
      }
    }

    const imageParts = usableEntries.map((entry) => {
      const imageData = fs.readFileSync(entry.path);
      return {
        inlineData: {
          data: imageData.toString('base64'),
          mimeType: 'image/png'
        }
      };
    });

    return {
      imageParts,
      entries: usableEntries
    };
  }

  function clearStealth() {
    screenshots.forEach((entry) => {
      cleanupScreenshotFile(entry);
    });

    screenshots = [];
    screenshotSequence = 0;

    console.log('All screenshots and context cleared');
    return { success: true };
  }

  function cleanupTransientResources() {
    screenshots.forEach((entry) => {
      cleanupScreenshotFile(entry);
    });

    screenshots = [];
    screenshotSequence = 0;
  }

  function getScreenshotsCount() {
    return screenshots.length;
  }

  function hasScreenshots() {
    return screenshots.length > 0;
  }

  function getCaptureDiagnostics() {
    return {
      lastCaptureBackend,
      lastCaptureError,
      lastCaptureErrorCode,
      attempts: lastCaptureAttempts.map((attempt) => ({ ...attempt })),
      portalCaptureSourceId,
      count: screenshots.length,
      inProgress: screenshotInProgress
    };
  }

  return {
    buildImagePartsFromScreenshots,
    cleanupTransientResources,
    clearStealth,
    getCaptureDiagnostics,
    getScreenshotsCount,
    hasScreenshots,
    takeStealthScreenshot
  };
}

module.exports = {
  createScreenshotManager,
  isE2EScreenshotFixtureEnabled,
  normalizeCaptureOrigin
};
