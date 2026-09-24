const path = require('path');
const { BrowserWindow } = require('electron');
const { detectPlatformCapabilities } = require('../../platform/capabilities');
const { applyContentProtection } = require('../../platform/content-protection');
const {
  installE2ESessionNetworkPolicy
} = require('../../platform/e2e-network-guard');

function createAssistantWindow({
  app,
  screen,
  defaultWidth,
  defaultHeight,
  minWidth,
  minHeight,
  hideFromScreenCapture,
  initialOpacity,
  launchHidden,
  nodeEnv,
  platformCapabilities = detectPlatformCapabilities()
}) {
  console.log('Creating assistant window...');
  const { width, height } = screen.getPrimaryDisplay().workAreaSize;
  const x = Math.floor((width - defaultWidth) / 2);
  const y = 40;
  const windowOpacity = Number.isFinite(initialOpacity) ? initialOpacity : 1;
  const isLinux = process.platform === 'linux';
  const nativeWayland = platformCapabilities.linuxDisplayProfile === 'wayland';

  console.log(`Window position: ${x}, ${y}, size: ${defaultWidth}x${defaultHeight}`);
  console.log('Linux display profile:', platformCapabilities.linuxDisplayProfile || 'n/a');

  const mainWindow = new BrowserWindow({
    width: defaultWidth,
    height: defaultHeight,
    minWidth,
    minHeight,
    maxWidth: width,
    maxHeight: height,
    x: nativeWayland ? undefined : x,
    y: nativeWayland ? undefined : y,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      preload: path.join(__dirname, 'preload.js'),
      backgroundThrottling: false,
      offscreen: false,
      webSecurity: false,
      allowRunningInsecureContent: true,
      experimentalFeatures: false,
      enableRemoteModule: false,
      sandbox: false
    },
    frame: false,
    transparent: true,
    alwaysOnTop: !nativeWayland,
    skipTaskbar: true,
    resizable: true,
    minimizable: false,
    maximizable: false,
    closable: isLinux,
    focusable: true,
    show: false,
    opacity: windowOpacity,
    // toolbar type is unreliable on Linux Wayland; use normal there.
    type: isLinux && nativeWayland ? 'normal' : 'toolbar',
    acceptFirstMouse: true,
    disableAutoHideCursor: true,
    enableLargerThanScreen: false,
    hasShadow: false,
    thickFrame: false,
    titleBarStyle: 'hidden',
    backgroundColor: '#00000000',
    title: 'Open-Cluely'
  });

  installE2ESessionNetworkPolicy(mainWindow.webContents.session);

  const htmlPath = path.join(__dirname, 'renderer.html');
  console.log('Loading HTML from:', htmlPath);
  mainWindow.loadFile(htmlPath);

  mainWindow.webContents.session.setPermissionRequestHandler((webContents, permission, callback) => {
    console.log('Permission requested:', permission);
    if (
      permission === 'microphone' ||
      permission === 'media' ||
      permission === 'display-capture' ||
      permission === 'mediaKeySystem'
    ) {
      console.log('Granting media/capture permission:', permission);
      callback(true);
    } else {
      console.log('Denying permission:', permission);
      callback(false);
    }
  });

  mainWindow.webContents.session.setPermissionCheckHandler((webContents, permission, requestingOrigin) => {
    console.log('Permission check:', permission, requestingOrigin);
    return (
      permission === 'microphone' ||
      permission === 'media' ||
      permission === 'display-capture' ||
      permission === 'mediaKeySystem'
    );
  });

  mainWindow.webContents.session.protocol.registerFileProtocol('file', (request, callback) => {
    const pathname = decodeURI(request.url.replace('file:///', ''));
    callback(pathname);
  });

  if (process.platform === 'darwin') {
    mainWindow.setVisibleOnAllWorkspaces(true, {
      visibleOnFullScreen: true,
      skipTransformProcessType: true
    });
    mainWindow.setAlwaysOnTop(true, 'pop-up-menu', 1);
    app.dock.hide();
    mainWindow.setHiddenInMissionControl(true);
    mainWindow.setMovable(true);
  } else if (process.platform === 'win32') {
    console.log('Applying Windows window settings');
    mainWindow.setSkipTaskbar(true);
    mainWindow.setAlwaysOnTop(true, 'pop-up-menu');
  } else if (process.platform === 'linux') {
    console.log('Applying Linux window settings');
    mainWindow.setSkipTaskbar(true);
    if (platformCapabilities.alwaysOnTopReliable) {
      try {
        mainWindow.setAlwaysOnTop(true);
      } catch (error) {
        console.warn('setAlwaysOnTop failed on Linux:', error.message);
      }
    } else {
      console.warn('alwaysOnTop is unreliable on native Wayland; skipping enforcement');
    }
  }

  applyContentProtection(mainWindow, {
    hideFromScreenCapture,
    contentProtectionSupported: platformCapabilities.contentProtectionSupported
  });

  mainWindow.setIgnoreMouseEvents(false);

  mainWindow.webContents.on('dom-ready', () => {
    console.log('DOM is ready');
  });

  mainWindow.webContents.on('did-finish-load', () => {
    console.log('HTML finished loading');

    mainWindow.webContents.executeJavaScript(`
      console.log('Content check...');
      console.log('Document title:', document.title);
      console.log('Body exists:', !!document.body);
      console.log('App element exists:', !!document.getElementById('app'));
      console.log('Glass container exists:', !!document.querySelector('.glass-container'));

      document.body.style.background = 'transparent';

      if (document.body) {
        document.body.style.visibility = 'visible';
        document.body.style.display = 'block';
        console.log('Body made visible');
      }

      const app = document.getElementById('app');
      if (app) {
        app.style.visibility = 'visible';
        app.style.display = 'flex';
        console.log('App container made visible');
      }

      'Content visibility check complete';
    `).then((result) => {
      console.log('JavaScript result:', result);
      if (launchHidden) {
        console.log('Window initialized in hidden launch mode');
        return;
      }

      mainWindow.showInactive();
      console.log('Window shown in inactive mode with transparent background');
    }).catch((error) => {
      console.log('JavaScript execution failed:', error);
      if (!launchHidden) {
        mainWindow.showInactive();
      }
    });
  });

  mainWindow.webContents.on('did-fail-load', (event, errorCode, errorDescription) => {
    console.error('Failed to load:', errorCode, errorDescription);
  });

  mainWindow.webContents.on('console-message', (event, level, message) => {
    console.log(`Renderer console.${level}: ${message}`);
  });

  if (nodeEnv === 'development') {
    mainWindow.webContents.openDevTools();
  }

  return mainWindow;
}

module.exports = {
  createAssistantWindow
};
