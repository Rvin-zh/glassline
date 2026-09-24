'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFile: defaultExecFile } = require('node:child_process');

const PYTHON_PATH = '/usr/bin/python3';
const BACKEND = 'xdg-screenshot-portal';
const DEFAULT_PORTAL_TIMEOUT_MS = 10_000;
const DEFAULT_PROCESS_TIMEOUT_MS = 12_000;
const MAX_STATUS_BYTES = 8 * 1024;
const PNG_SIGNATURE = Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a
]);

class XdgScreenshotError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'XdgScreenshotError';
    this.code = code;
    this.backend = BACKEND;
  }
}

function normalizeTimeout(value, fallback) {
  const parsed = Number.parseInt(String(value ?? ''), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function isAsarPath(candidate) {
  return String(candidate || '')
    .split(path.sep)
    .some((segment) => segment.endsWith('.asar'));
}

function isReadableRegularFile(candidate, fsImpl = fs) {
  try {
    const fileStat = fsImpl.statSync(candidate);
    return fileStat.isFile();
  } catch (_) {
    return false;
  }
}

function materializeAsarHelper(sourcePath, {
  app,
  fsImpl = fs,
  osImpl = os
} = {}) {
  const tempBase = typeof app?.getPath === 'function'
    ? app.getPath('temp')
    : osImpl.tmpdir();
  const tempDirectory = fsImpl.mkdtempSync(
    path.join(path.resolve(tempBase), 'open-cluely-xdg-')
  );
  const stagedPath = path.join(tempDirectory, 'xdg-screenshot.py');

  try {
    fsImpl.writeFileSync(stagedPath, fsImpl.readFileSync(sourcePath), {
      mode: 0o600,
      flag: 'wx'
    });
  } catch (error) {
    fsImpl.rmSync(tempDirectory, { recursive: true, force: true });
    throw error;
  }

  return {
    helperPath: stagedPath,
    cleanup() {
      fsImpl.rmSync(tempDirectory, { recursive: true, force: true });
    }
  };
}

function prepareXdgScreenshotHelper({
  app = null,
  helperPath = '',
  resourcesPath = process.resourcesPath,
  fsImpl = fs,
  osImpl = os
} = {}) {
  const sourcePath = path.join(__dirname, 'xdg-screenshot.py');
  const candidates = helperPath
    ? [path.resolve(helperPath)]
    : [
        resourcesPath
          ? path.join(
              path.resolve(resourcesPath),
              'app.asar.unpacked',
              'src',
              'platform',
              'xdg-screenshot.py'
            )
          : '',
        sourcePath
      ].filter(Boolean);

  const selected = candidates.find((candidate) =>
    path.basename(candidate) === 'xdg-screenshot.py' &&
    isReadableRegularFile(candidate, fsImpl)
  );
  if (!selected) {
    throw new XdgScreenshotError(
      'PORTAL_UNAVAILABLE',
      'Screenshot portal helper is unavailable.'
    );
  }

  if (isAsarPath(selected)) {
    try {
      return materializeAsarHelper(selected, { app, fsImpl, osImpl });
    } catch (_) {
      throw new XdgScreenshotError(
        'PORTAL_UNAVAILABLE',
        'Screenshot portal helper is unavailable.'
      );
    }
  }

  return {
    helperPath: selected,
    cleanup() {}
  };
}

function validateOutputPath(outputPath, fsImpl = fs) {
  if (
    typeof outputPath !== 'string' ||
    outputPath.includes('\0') ||
    !path.isAbsolute(outputPath) ||
    path.extname(outputPath).toLowerCase() !== '.png'
  ) {
    throw new XdgScreenshotError(
      'PORTAL_INVALID_DESTINATION',
      'Screenshot destination is invalid.'
    );
  }

  const resolved = path.resolve(outputPath);
  try {
    if (!fsImpl.statSync(path.dirname(resolved)).isDirectory()) {
      throw new Error('not a directory');
    }
    if (fsImpl.existsSync(resolved)) {
      throw new Error('destination already exists');
    }
  } catch (_) {
    throw new XdgScreenshotError(
      'PORTAL_INVALID_DESTINATION',
      'Screenshot destination is invalid.'
    );
  }
  return resolved;
}

function readPortalStatus(stdout) {
  if (
    typeof stdout !== 'string' ||
    Buffer.byteLength(stdout, 'utf8') > MAX_STATUS_BYTES
  ) {
    return null;
  }

  try {
    const parsed = JSON.parse(stdout.trim());
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch (_) {
    return null;
  }
}

function mapPortalStatus(code) {
  switch (code) {
    case 'portal-timeout':
      return new XdgScreenshotError(
        'PORTAL_TIMEOUT',
        'Screenshot portal timed out. Ensure the desktop portal is running and try again.'
      );
    case 'permission-denied':
      return new XdgScreenshotError(
        'PORTAL_PERMISSION_DENIED',
        'Screenshot permission was denied. Allow screenshots in desktop portal settings and try again.'
      );
    case 'cancelled':
      return new XdgScreenshotError(
        'PORTAL_CANCELLED',
        'Screenshot request was cancelled.'
      );
    case 'portal-unavailable':
      return new XdgScreenshotError(
        'PORTAL_UNAVAILABLE',
        'Screenshot portal is unavailable. Ensure xdg-desktop-portal and its desktop backend are running.'
      );
    case 'invalid-destination':
    case 'invalid-arguments':
      return new XdgScreenshotError(
        'PORTAL_INVALID_DESTINATION',
        'Screenshot destination is invalid.'
      );
    case 'invalid-response':
      return new XdgScreenshotError(
        'PORTAL_INVALID_OUTPUT',
        'Screenshot portal returned invalid PNG output.'
      );
    default:
      return new XdgScreenshotError(
        'PORTAL_FAILED',
        'Screenshot portal capture failed.'
      );
  }
}

function buildPortalEnvironment(environment = process.env) {
  const childEnvironment = { ...(environment || {}) };
  delete childEnvironment.GDK_BACKEND;
  delete childEnvironment.ELECTRON_OZONE_PLATFORM;
  delete childEnvironment.ELECTRON_OZONE_PLATFORM_HINT;
  return childEnvironment;
}

function isNonEmptyPng(outputPath, fsImpl = fs) {
  try {
    const outputStat = fsImpl.lstatSync(outputPath);
    if (
      !outputStat.isFile() ||
      outputStat.isSymbolicLink() ||
      outputStat.size <= PNG_SIGNATURE.length
    ) {
      return false;
    }
    const descriptor = fsImpl.openSync(outputPath, 'r');
    try {
      const signature = Buffer.alloc(PNG_SIGNATURE.length);
      const bytesRead = fsImpl.readSync(
        descriptor,
        signature,
        0,
        signature.length,
        0
      );
      return bytesRead === signature.length && signature.equals(PNG_SIGNATURE);
    } finally {
      fsImpl.closeSync(descriptor);
    }
  } catch (_) {
    return false;
  }
}

function invokeHelper(execFile, helperPath, outputPath, {
  portalTimeoutMs,
  processTimeoutMs,
  environment
}) {
  return new Promise((resolve, reject) => {
    execFile(
      PYTHON_PATH,
      [helperPath, outputPath, String(portalTimeoutMs)],
      {
        encoding: 'utf8',
        maxBuffer: MAX_STATUS_BYTES,
        timeout: processTimeoutMs,
        killSignal: 'SIGKILL',
        windowsHide: true,
        env: buildPortalEnvironment(environment)
      },
      (error, stdout) => {
        const status = readPortalStatus(stdout);
        if (
          error?.killed ||
          error?.signal === 'SIGKILL' ||
          error?.code === 'ETIMEDOUT'
        ) {
          reject(mapPortalStatus('portal-timeout'));
          return;
        }
        if (error?.code === 'ENOENT') {
          reject(mapPortalStatus('portal-unavailable'));
          return;
        }
        if (error || status?.ok !== true) {
          reject(mapPortalStatus(status?.code));
          return;
        }
        resolve(status);
      }
    );
  });
}

async function captureXdgScreenshot(outputPath, {
  app = null,
  helperPath = '',
  resourcesPath = process.resourcesPath,
  portalTimeoutMs = DEFAULT_PORTAL_TIMEOUT_MS,
  processTimeoutMs = DEFAULT_PROCESS_TIMEOUT_MS,
  environment = process.env,
  execFile = defaultExecFile,
  fsImpl = fs,
  osImpl = os
} = {}) {
  const destination = validateOutputPath(outputPath, fsImpl);
  const portalTimeout = normalizeTimeout(
    portalTimeoutMs,
    DEFAULT_PORTAL_TIMEOUT_MS
  );
  const processTimeout = normalizeTimeout(
    processTimeoutMs,
    Math.max(DEFAULT_PROCESS_TIMEOUT_MS, portalTimeout + 2_000)
  );
  const preparedHelper = prepareXdgScreenshotHelper({
    app,
    helperPath,
    resourcesPath,
    fsImpl,
    osImpl
  });

  try {
    await invokeHelper(execFile, preparedHelper.helperPath, destination, {
      portalTimeoutMs: portalTimeout,
      processTimeoutMs: processTimeout,
      environment
    });
    if (!isNonEmptyPng(destination, fsImpl)) {
      throw mapPortalStatus('invalid-response');
    }
    return { backend: BACKEND };
  } catch (error) {
    try {
      fsImpl.rmSync(destination, { force: true });
    } catch (_) {
      // Best-effort cleanup of a partial portal output.
    }
    if (error instanceof XdgScreenshotError) {
      throw error;
    }
    throw mapPortalStatus('portal-failed');
  } finally {
    preparedHelper.cleanup();
  }
}

module.exports = {
  BACKEND,
  XdgScreenshotError,
  buildPortalEnvironment,
  captureXdgScreenshot,
  isNonEmptyPng,
  prepareXdgScreenshotHelper
};
