'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const REPO_ROOT = path.join(__dirname, '..');
const SCREENSHOT_MANAGER_PATH = path.join(
  REPO_ROOT,
  'src',
  'main-process',
  'features',
  'assistant',
  'screenshot-manager.js'
);
const PORTAL_WRAPPER_PATH = path.join(
  REPO_ROOT,
  'src',
  'platform',
  'xdg-screenshot.js'
);
const PORTAL_HELPER_PATH = path.join(
  REPO_ROOT,
  'src',
  'platform',
  'xdg-screenshot.py'
);
const RENDERER_PATH = path.join(
  REPO_ROOT,
  'src',
  'windows',
  'assistant',
  'renderer.js'
);
const SETTINGS_MANAGER_PATH = path.join(
  REPO_ROOT,
  'src',
  'windows',
  'assistant',
  'renderer',
  'features',
  'settings',
  'settings-panel-manager.js'
);
const AUTO_SCREEN_CONTROLLER_PATH = path.join(
  REPO_ROOT,
  'src',
  'windows',
  'assistant',
  'renderer',
  'features',
  'auto-screen',
  'auto-screen-controller.js'
);
const MAIN_PATH = path.join(REPO_ROOT, 'src', 'main.js');
const DESKTOP_ENTRY_PATH = path.join(
  REPO_ROOT,
  'assets',
  'com.opencluely.assistant.desktop'
);
const PNG = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  Buffer.from('test-png')
]);

let capabilitiesImpl = () => ({
  platform: 'linux',
  sessionType: 'wayland',
  linuxDisplayProfile: 'xwayland',
  contentProtectionSupported: false,
  hasImageMagick: false
});
let screenshotDesktopImpl = async () => {
  throw new Error('screenshot-desktop test implementation not configured');
};
let execFileImpl = (_file, _args, _options, callback) => {
  callback(Object.assign(new Error('command unavailable'), { code: 'ENOENT' }));
};

function loadScreenshotManagerWithSafeFakes() {
  const screenshotModulePath = require.resolve('screenshot-desktop');
  const capabilitiesModulePath = require.resolve('../src/platform/capabilities');
  const screenshotCache = require.cache[screenshotModulePath];
  const capabilitiesCache = require.cache[capabilitiesModulePath];
  const childProcess = require('node:child_process');
  const originalExecFile = childProcess.execFile;

  require.cache[screenshotModulePath] = {
    id: screenshotModulePath,
    filename: screenshotModulePath,
    loaded: true,
    exports: (...args) => screenshotDesktopImpl(...args)
  };
  require.cache[capabilitiesModulePath] = {
    id: capabilitiesModulePath,
    filename: capabilitiesModulePath,
    loaded: true,
    exports: {
      detectPlatformCapabilities: (...args) => capabilitiesImpl(...args)
    }
  };
  childProcess.execFile = (...args) => execFileImpl(...args);
  delete require.cache[require.resolve(SCREENSHOT_MANAGER_PATH)];

  try {
    return require(SCREENSHOT_MANAGER_PATH);
  } finally {
    childProcess.execFile = originalExecFile;
    if (screenshotCache) {
      require.cache[screenshotModulePath] = screenshotCache;
    } else {
      delete require.cache[screenshotModulePath];
    }
    if (capabilitiesCache) {
      require.cache[capabilitiesModulePath] = capabilitiesCache;
    } else {
      delete require.cache[capabilitiesModulePath];
    }
  }
}

const { createScreenshotManager } = loadScreenshotManagerWithSafeFakes();

function writePng(outputPath) {
  fs.writeFileSync(outputPath, PNG);
}

function createManager(t, {
  capabilities = capabilitiesImpl(),
  portalCapture = async (outputPath) => {
    writePng(outputPath);
    return { backend: 'xdg-screenshot-portal' };
  },
  desktopCapturer = {
    async getSources() {
      throw new Error('desktop capture unavailable');
    }
  },
  screenshotCapture = async () => {
    throw new Error('screenshot-desktop unavailable');
  },
  command = (_file, _args, _options, callback) => {
    callback(Object.assign(new Error('command unavailable'), { code: 'ENOENT' }));
  },
  opacity = 0.43,
  visible = true,
  backendTimeoutMs = 20,
  maxScreenshots = 4
} = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'open-cluely-capture-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  const opacityCalls = [];
  const visibilityCalls = [];
  const rendererEvents = [];
  const mainWindow = {
    isDestroyed: () => false,
    isVisible: () => visible,
    hide: () => visibilityCalls.push('hide'),
    showInactive: () => visibilityCalls.push('showInactive'),
    getOpacity: () => opacity,
    setOpacity: (value) => opacityCalls.push(value)
  };

  capabilitiesImpl = () => capabilities;
  screenshotDesktopImpl = screenshotCapture;
  execFileImpl = command;

  const manager = createScreenshotManager({
    app: {
      isPackaged: true,
      getPath: () => root
    },
    getMainWindow: () => mainWindow,
    getAppEnvironment: () => ({
      screenshotDelay: 0,
      maxScreenshots
    }),
    sendToRenderer: (channel, payload) => {
      rendererEvents.push({ channel, payload });
    },
    desktopCapturer,
    captureXdgScreenshot: portalCapture,
    screenshotCapture,
    execFile: command,
    detectCapabilities: () => capabilities,
    backendTimeoutMs
  });

  return {
    manager,
    opacityCalls,
    visibilityCalls,
    rendererEvents,
    root
  };
}

function loadPortalWrapper() {
  assert.equal(
    fs.existsSync(PORTAL_WRAPPER_PATH),
    true,
    'expected the XDG screenshot Node wrapper to exist'
  );
  return require(PORTAL_WRAPPER_PATH);
}

function runPortalRetryProbe(outcomes) {
  const probe = spawnSync(
    '/usr/bin/python3',
    [
      '-c',
      `
import importlib.util
import json
import sys
import time

spec = importlib.util.spec_from_file_location("xdg_screenshot", sys.argv[1])
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
outcomes = json.loads(sys.argv[2])
connection = object()
deadline = time.monotonic() + 100
calls = []

def attempt(actual_connection, destination, interactive, actual_deadline):
    calls.append({
        "interactive": interactive,
        "same_connection": actual_connection is connection,
        "same_deadline": actual_deadline == deadline,
    })
    outcome = outcomes[len(calls) - 1]
    if outcome != "ok":
        raise module.PortalFailure(outcome)
    return "captured"

runner = getattr(module, "capture_with_permission_retry", None)
if runner is None:
    print(json.dumps({"missing": True, "calls": calls}))
else:
    try:
        result = runner(
            connection,
            None,
            deadline,
            attempt_capture=attempt,
        )
        print(json.dumps({"missing": False, "result": result, "calls": calls}))
    except module.PortalFailure as error:
        print(json.dumps({
            "missing": False,
            "error": error.code,
            "calls": calls,
        }))
`,
      PORTAL_HELPER_PATH,
      JSON.stringify(outcomes)
    ],
    {
      encoding: 'utf8',
      timeout: 3000
    }
  );

  assert.equal(probe.status, 0, probe.stderr || probe.stdout);
  return JSON.parse(probe.stdout);
}

describe('XDG Screenshot portal helper', () => {
  it('is packaged under src and encodes the same-connection request protocol', () => {
    assert.equal(fs.existsSync(PORTAL_HELPER_PATH), true);
    if (!fs.existsSync(PORTAL_HELPER_PATH)) return;

    const source = fs.readFileSync(PORTAL_HELPER_PATH, 'utf8');
    const subscribeIndex = source.indexOf('signal_subscribe');
    const screenshotCallIndex = source.indexOf('call_sync');

    assert.ok(subscribeIndex >= 0, 'helper must subscribe to Request.Response');
    assert.ok(screenshotCallIndex > subscribeIndex, 'helper must subscribe before calling Screenshot');
    assert.match(source, /handle_token/);
    assert.match(source, /interactive/);
    assert.match(source, /GLib\.Variant\(['"]b['"],\s*bool\(interactive\)\)/);
    assert.match(source, /signal_unsubscribe/);
    assert.match(source, /response_code\s*==\s*0|response_code\s*!=\s*0/);
  });

  it('rejects invalid destinations with one sanitized JSON status', () => {
    const result = spawnSync('/usr/bin/python3', [PORTAL_HELPER_PATH], {
      encoding: 'utf8'
    });

    assert.equal(result.status, 2);
    assert.equal(result.stderr, '');
    const lines = result.stdout.trim().split('\n');
    assert.equal(lines.length, 1);
    const status = JSON.parse(lines[0]);
    assert.equal(status.ok, false);
    assert.equal(status.code, 'invalid-arguments');
    assert.equal(Object.hasOwn(status, 'uri'), false);
  });

  it('retries permission denial exactly once with an interactive request', () => {
    const result = runPortalRetryProbe(['permission-denied', 'ok']);

    assert.equal(result.missing, false);
    assert.equal(result.result, 'captured');
    assert.deepEqual(
      result.calls.map(({ interactive }) => interactive),
      [false, true]
    );
    assert.equal(result.calls.every(({ same_connection }) => same_connection), true);
    assert.equal(result.calls.every(({ same_deadline }) => same_deadline), true);
  });

  it('does not enter a repeated permission retry loop', () => {
    const result = runPortalRetryProbe([
      'permission-denied',
      'permission-denied',
      'ok'
    ]);

    assert.equal(result.missing, false);
    assert.equal(result.error, 'permission-denied');
    assert.deepEqual(
      result.calls.map(({ interactive }) => interactive),
      [false, true]
    );
  });

  it('does not retry cancellation, timeout, invalid response, or unavailable portal', () => {
    for (const code of [
      'cancelled',
      'portal-timeout',
      'invalid-response',
      'portal-unavailable'
    ]) {
      const result = runPortalRetryProbe([code, 'ok']);

      assert.equal(result.missing, false);
      assert.equal(result.error, code);
      assert.deepEqual(
        result.calls.map(({ interactive }) => interactive),
        [false]
      );
    }
  });

  it('invokes system Python with a bounded kill timeout and verifies PNG output', async (t) => {
    const { captureXdgScreenshot } = loadPortalWrapper();
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'open-cluely-portal-wrapper-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const outputPath = path.join(root, 'capture.png');
    const calls = [];

    const result = await captureXdgScreenshot(outputPath, {
      helperPath: PORTAL_HELPER_PATH,
      portalTimeoutMs: 25,
      processTimeoutMs: 40,
      execFile(file, args, options, callback) {
        calls.push({ file, args, options });
        writePng(outputPath);
        callback(null, '{"ok":true,"backend":"xdg-screenshot-portal"}\n', '');
      }
    });

    assert.equal(result.backend, 'xdg-screenshot-portal');
    assert.equal(calls.length, 1);
    assert.equal(calls[0].file, '/usr/bin/python3');
    assert.equal(calls[0].args[0], PORTAL_HELPER_PATH);
    assert.equal(calls[0].args[1], outputPath);
    assert.equal(calls[0].args[2], '25');
    assert.equal(calls[0].options.timeout, 40);
    assert.equal(calls[0].options.killSignal, 'SIGKILL');
  });

  it('removes XWayland overrides from the portal helper environment', async (t) => {
    const { captureXdgScreenshot } = loadPortalWrapper();
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'open-cluely-portal-env-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const outputPath = path.join(root, 'capture.png');
    let childEnvironment = null;

    await captureXdgScreenshot(outputPath, {
      helperPath: PORTAL_HELPER_PATH,
      environment: {
        GDK_BACKEND: 'x11',
        ELECTRON_OZONE_PLATFORM: 'x11',
        ELECTRON_OZONE_PLATFORM_HINT: 'x11',
        XDG_SESSION_TYPE: 'wayland',
        WAYLAND_DISPLAY: 'wayland-0',
        DBUS_SESSION_BUS_ADDRESS: 'unix:path=/run/user/test/bus'
      },
      execFile(_file, _args, options, callback) {
        childEnvironment = options.env;
        writePng(outputPath);
        callback(null, '{"ok":true,"backend":"xdg-screenshot-portal"}\n', '');
      }
    });

    assert.equal(childEnvironment.GDK_BACKEND, undefined);
    assert.equal(childEnvironment.ELECTRON_OZONE_PLATFORM, undefined);
    assert.equal(childEnvironment.ELECTRON_OZONE_PLATFORM_HINT, undefined);
    assert.equal(childEnvironment.XDG_SESSION_TYPE, 'wayland');
    assert.equal(childEnvironment.WAYLAND_DISPLAY, 'wayland-0');
    assert.equal(
      childEnvironment.DBUS_SESSION_BUS_ADDRESS,
      'unix:path=/run/user/test/bus'
    );
  });

  it('materializes a packaged asar helper and removes the staged copy', (t) => {
    const { prepareXdgScreenshotHelper } = loadPortalWrapper();
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'open-cluely-asar-helper-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const asarHelper = path.join(
      root,
      'app.asar',
      'src',
      'platform',
      'xdg-screenshot.py'
    );
    const tempRoot = path.join(root, 'runtime-temp');
    fs.mkdirSync(path.dirname(asarHelper), { recursive: true });
    fs.mkdirSync(tempRoot, { recursive: true });
    fs.copyFileSync(PORTAL_HELPER_PATH, asarHelper);

    const prepared = prepareXdgScreenshotHelper({
      helperPath: asarHelper,
      app: {
        getPath(name) {
          assert.equal(name, 'temp');
          return tempRoot;
        }
      }
    });
    const stagedDirectory = path.dirname(prepared.helperPath);

    assert.equal(prepared.helperPath.startsWith(tempRoot), true);
    assert.equal(fs.readFileSync(prepared.helperPath, 'utf8').length > 0, true);
    prepared.cleanup();
    assert.equal(fs.existsSync(stagedDirectory), false);
  });

  it('maps timeout and permission failures without exposing child output or paths', async (t) => {
    const { captureXdgScreenshot } = loadPortalWrapper();
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'open-cluely-portal-errors-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const outputPath = path.join(root, 'private-capture-name.png');
    const privateMarker = 'private-uri-and-stack-marker';

    await assert.rejects(
      captureXdgScreenshot(outputPath, {
        helperPath: PORTAL_HELPER_PATH,
        execFile(_file, _args, _options, callback) {
          const error = Object.assign(new Error(privateMarker), {
            killed: true,
            signal: 'SIGKILL'
          });
          callback(error, '', privateMarker);
        }
      }),
      (error) => {
        assert.equal(error.code, 'PORTAL_TIMEOUT');
        assert.match(error.message, /portal.*timed out/i);
        assert.doesNotMatch(error.message, /private-uri|private-capture/i);
        return true;
      }
    );

    await assert.rejects(
      captureXdgScreenshot(outputPath, {
        helperPath: PORTAL_HELPER_PATH,
        execFile(_file, _args, _options, callback) {
          callback(
            Object.assign(new Error(privateMarker), { code: 4 }),
            '{"ok":false,"code":"permission-denied"}\n',
            privateMarker
          );
        }
      }),
      (error) => {
        assert.equal(error.code, 'PORTAL_PERMISSION_DENIED');
        assert.match(error.message, /permission/i);
        assert.doesNotMatch(error.message, /private-uri|private-capture/i);
        return true;
      }
    );
  });
});

describe('Fedora screenshot backend routing', () => {
  it('uses the in-process fixture only when both E2E screenshot gates are enabled', async (t) => {
    const previousE2E = process.env.OPEN_CLUELY_E2E;
    const previousFixture = process.env.OPEN_CLUELY_E2E_SCREENSHOT_FIXTURE;
    t.after(() => {
      if (previousE2E === undefined) {
        delete process.env.OPEN_CLUELY_E2E;
      } else {
        process.env.OPEN_CLUELY_E2E = previousE2E;
      }
      if (previousFixture === undefined) {
        delete process.env.OPEN_CLUELY_E2E_SCREENSHOT_FIXTURE;
      } else {
        process.env.OPEN_CLUELY_E2E_SCREENSHOT_FIXTURE = previousFixture;
      }
    });
    process.env.OPEN_CLUELY_E2E = '1';
    process.env.OPEN_CLUELY_E2E_SCREENSHOT_FIXTURE = '1';

    let externalCaptureCalls = 0;
    const { manager } = createManager(t, {
      portalCapture: async () => {
        externalCaptureCalls += 1;
        throw new Error('portal must not run');
      },
      screenshotCapture: async () => {
        externalCaptureCalls += 1;
        throw new Error('screenshot-desktop must not run');
      },
      command(_file, _args, _options, callback) {
        externalCaptureCalls += 1;
        callback(new Error('grim must not run'));
      },
      desktopCapturer: {
        async getSources() {
          externalCaptureCalls += 1;
          throw new Error('desktopCapturer must not run');
        }
      }
    });

    const result = await manager.takeStealthScreenshot('manual');

    assert.equal(result.success, true);
    assert.equal(result.backend, 'e2e-fixture');
    assert.equal(externalCaptureCalls, 0);
  });

  for (const linuxDisplayProfile of ['wayland', 'xwayland']) {
    it(`prefers the portal on a ${linuxDisplayProfile} Wayland session`, async (t) => {
      const calls = [];
      const { manager, opacityCalls, visibilityCalls } = createManager(t, {
        capabilities: {
          platform: 'linux',
          sessionType: 'wayland',
          linuxDisplayProfile,
          contentProtectionSupported: false,
          hasImageMagick: false
        },
        portalCapture: async (outputPath) => {
          calls.push('portal');
          writePng(outputPath);
          return { backend: 'xdg-screenshot-portal' };
        },
        screenshotCapture: async () => {
          calls.push('screenshot-desktop');
          throw new Error('must not run');
        },
        desktopCapturer: {
          async getSources() {
            calls.push('desktop-capturer');
            throw new Error('must not run');
          }
        }
      });

      const captureResult = await manager.takeStealthScreenshot('manual');

      assert.equal(captureResult.success, true);
      assert.equal(typeof captureResult.screenshotId, 'string');
      assert.equal(captureResult.count, 1);
      assert.equal(captureResult.backend, 'xdg-screenshot-portal');
      assert.equal(Object.hasOwn(captureResult, 'path'), false);
      assert.deepEqual(calls, ['portal']);
      assert.deepEqual(opacityCalls, []);
      assert.deepEqual(visibilityCalls, ['hide', 'showInactive']);
      assert.equal(
        manager.getCaptureDiagnostics().lastCaptureBackend,
        'xdg-screenshot-portal'
      );
    });
  }

  it('never invokes screenshot-desktop on Wayland when portal fallbacks fail', async (t) => {
    let screenshotDesktopCalls = 0;
    const { manager } = createManager(t, {
      portalCapture: async () => {
        throw Object.assign(new Error('portal denied'), {
          code: 'PORTAL_PERMISSION_DENIED'
        });
      },
      screenshotCapture: async () => {
        screenshotDesktopCalls += 1;
        throw new Error('must not run on Wayland');
      }
    });

    await assert.rejects(
      manager.takeStealthScreenshot(),
      (error) => {
        assert.equal(error.code, 'PORTAL_PERMISSION_DENIED');
        assert.match(error.message, /permission/i);
        return true;
      }
    );
    assert.equal(screenshotDesktopCalls, 0);
  });

  it('bounds a hung portal and falls back without leaving capture stuck', async (t) => {
    const calls = [];
    const { manager } = createManager(t, {
      backendTimeoutMs: 15,
      portalCapture: () => {
        calls.push('portal');
        return new Promise(() => {});
      },
      command(file, args, _options, callback) {
        calls.push(file);
        if (file === 'grim') {
          writePng(args[0]);
          callback(null, '', '');
          return;
        }
        callback(Object.assign(new Error('command unavailable'), { code: 'ENOENT' }));
      }
    });

    const captureResult = await manager.takeStealthScreenshot('manual');

    assert.equal(captureResult.success, true);
    assert.equal(captureResult.backend, 'grim');
    assert.equal(Object.hasOwn(captureResult, 'path'), false);
    assert.deepEqual(calls.slice(0, 2), ['portal', 'grim']);
    assert.equal(manager.getCaptureDiagnostics().lastCaptureBackend, 'grim');
    assert.equal(manager.getCaptureDiagnostics().inProgress, false);
  });

  it('restores the exact prior visibility after every backend fails', async (t) => {
    const { manager, opacityCalls, visibilityCalls } = createManager(t, {
      opacity: 0.27,
      portalCapture: async () => {
        throw new Error('portal unavailable');
      },
      desktopCapturer: {
        async getSources() {
          throw new Error('desktop unavailable');
        }
      },
      screenshotCapture: async () => {
        throw new Error('must be skipped');
      }
    });

    await assert.rejects(manager.takeStealthScreenshot());
    assert.deepEqual(opacityCalls, []);
    assert.deepEqual(visibilityCalls, ['hide', 'showInactive']);
    assert.equal(manager.getCaptureDiagnostics().inProgress, false);
  });

  it('does not show a Linux window that was already hidden', async (t) => {
    const { manager, visibilityCalls } = createManager(t, {
      visible: false
    });

    await manager.takeStealthScreenshot();

    assert.deepEqual(visibilityCalls, []);
  });

  it('returns a structured busy result and clears busy state afterward', async (t) => {
    let releasePortal;
    let markPortalStarted;
    const portalStarted = new Promise((resolve) => {
      markPortalStarted = resolve;
    });
    const { manager } = createManager(t, {
      portalCapture: (outputPath) => new Promise((resolve) => {
        releasePortal = () => {
          writePng(outputPath);
          resolve({ backend: 'xdg-screenshot-portal' });
        };
        markPortalStarted();
      })
    });

    const first = manager.takeStealthScreenshot();
    await portalStarted;
    const busy = await manager.takeStealthScreenshot();

    assert.deepEqual(busy, {
      success: false,
      busy: true,
      code: 'SCREENSHOT_BUSY',
      backend: null
    });

    releasePortal();
    await first;
    assert.equal(manager.getCaptureDiagnostics().inProgress, false);
  });

  it('returns only safe structured capture metadata and never a filesystem path', async (t) => {
    const { manager, rendererEvents, root } = createManager(t);

    const result = await manager.takeStealthScreenshot('manual');

    assert.deepEqual(
      Object.keys(result).sort(),
      [
        'backend',
        'count',
        'replacedScreenshotIds',
        'screenshotId',
        'success'
      ]
    );
    assert.equal(result.success, true);
    assert.equal(result.count, 1);
    assert.deepEqual(result.replacedScreenshotIds, []);
    assert.doesNotMatch(JSON.stringify(result), new RegExp(root));
    assert.equal(rendererEvents.length, 1);
    assert.equal(rendererEvents[0].channel, 'screenshot-taken-stealth');
    assert.doesNotMatch(JSON.stringify(rendererEvents[0].payload), new RegExp(root));
  });

  it('keeps capped manual captures while retaining only the newest auto capture', async (t) => {
    const { manager, rendererEvents } = createManager(t, {
      maxScreenshots: 2
    });

    const firstManual = await manager.takeStealthScreenshot('manual');
    const secondManual = await manager.takeStealthScreenshot('manual');
    const firstAuto = await manager.takeStealthScreenshot('auto');
    const secondAuto = await manager.takeStealthScreenshot('auto');

    assert.equal(manager.getScreenshotsCount(), 3);
    assert.equal(secondAuto.count, 3);
    assert.deepEqual(secondAuto.replacedScreenshotIds, [firstAuto.screenshotId]);
    const retained = await manager.buildImagePartsFromScreenshots({ strict: true });
    assert.deepEqual(
      retained.entries.map((entry) => entry.id),
      [
        firstManual.screenshotId,
        secondManual.screenshotId,
        secondAuto.screenshotId
      ]
    );
    assert.deepEqual(
      retained.entries.map((entry) => entry.origin),
      ['manual', 'manual', 'auto']
    );
    assert.deepEqual(
      rendererEvents.at(-1).payload.replacedScreenshotIds,
      [firstAuto.screenshotId]
    );
    assert.equal(rendererEvents.at(-1).payload.origin, 'auto');
  });

  it('applies MAX_SCREENSHOTS only to manual capture retention', async (t) => {
    const { manager } = createManager(t, { maxScreenshots: 2 });

    const firstManual = await manager.takeStealthScreenshot('manual');
    const auto = await manager.takeStealthScreenshot('auto');
    const secondManual = await manager.takeStealthScreenshot('manual');
    const thirdManual = await manager.takeStealthScreenshot('manual');

    assert.equal(thirdManual.count, 3);
    assert.deepEqual(thirdManual.replacedScreenshotIds, [firstManual.screenshotId]);
    const retained = await manager.buildImagePartsFromScreenshots({ strict: true });
    assert.deepEqual(
      new Set(retained.entries.map((entry) => entry.id)),
      new Set([auto.screenshotId, secondManual.screenshotId, thirdManual.screenshotId])
    );
  });

  it('keeps rapid captures isolated when the wall clock does not advance', async (t) => {
    const originalNow = Date.now;
    Date.now = () => 1_800_000_000_000;
    t.after(() => {
      Date.now = originalNow;
    });
    const { manager } = createManager(t, { maxScreenshots: 2 });

    const manual = await manager.takeStealthScreenshot('manual');
    await manager.takeStealthScreenshot('auto');
    const latestAuto = await manager.takeStealthScreenshot('auto');

    const retained = await manager.buildImagePartsFromScreenshots({ strict: true });
    assert.deepEqual(
      retained.entries.map((entry) => entry.id),
      [manual.screenshotId, latestAuto.screenshotId]
    );
    assert.equal(retained.imageParts.length, 2);
  });
});

describe('Fedora capability diagnostics', () => {
  it('reports the XDG screenshot portal for a Wayland session using XWayland', () => {
    const previousSession = process.env.OPEN_CLUELY_SESSION_TYPE;
    const previousProfile = process.env.OPEN_CLUELY_DISPLAY_PROFILE;
    process.env.OPEN_CLUELY_SESSION_TYPE = 'wayland';
    process.env.OPEN_CLUELY_DISPLAY_PROFILE = 'xwayland';
    delete require.cache[require.resolve('../src/platform/capabilities')];

    try {
      const { detectPlatformCapabilities } = require('../src/platform/capabilities');
      const capabilities = detectPlatformCapabilities();
      if (process.platform === 'linux') {
        assert.equal(capabilities.screenshotBackend, 'xdg-screenshot-portal');
      }
    } finally {
      if (previousSession === undefined) {
        delete process.env.OPEN_CLUELY_SESSION_TYPE;
      } else {
        process.env.OPEN_CLUELY_SESSION_TYPE = previousSession;
      }
      if (previousProfile === undefined) {
        delete process.env.OPEN_CLUELY_DISPLAY_PROFILE;
      } else {
        process.env.OPEN_CLUELY_DISPLAY_PROFILE = previousProfile;
      }
      delete require.cache[require.resolve('../src/platform/capabilities')];
    }
  });

  it('surfaces structured screenshot IPC failures in the renderer', () => {
    const renderer = fs.readFileSync(RENDERER_PATH, 'utf8');
    const autoScreenController = fs.readFileSync(
      AUTO_SCREEN_CONTROLLER_PATH,
      'utf8'
    );

    assert.match(renderer, /captureManualScreenshot\(\)/);
    assert.match(renderer, /result\?\.success\s*===\s*false/);
    assert.match(renderer, /result\.error/);
    assert.match(autoScreenController, /SCREENSHOT_BUSY/);
  });

  it('wires the Fedora diagnostics panel and refresh button', () => {
    const renderer = fs.readFileSync(RENDERER_PATH, 'utf8');
    const settingsManager = fs.readFileSync(SETTINGS_MANAGER_PATH, 'utf8');

    assert.match(renderer, /getElementById\('settings-diagnostics'\)/);
    assert.match(renderer, /getElementById\('refresh-diagnostics-btn'\)/);
    assert.match(settingsManager, /getPlatformDiagnostics/);
    assert.match(settingsManager, /refreshDiagnosticsBtn\?\.addEventListener/);
  });

  it('sets a matching portal desktop identity before application startup', () => {
    const main = fs.readFileSync(MAIN_PATH, 'utf8');
    const desktopEntry = fs.readFileSync(DESKTOP_ENTRY_PATH, 'utf8');
    const identityIndex = main.indexOf(
      "app.setDesktopName('com.opencluely.assistant.desktop')"
    );
    const startupIndex = main.indexOf("require('./main-process/start-application')");

    assert.ok(identityIndex >= 0);
    assert.ok(startupIndex > identityIndex);
    assert.match(desktopEntry, /^StartupWMClass=com\.opencluely\.assistant$/m);
  });
});
