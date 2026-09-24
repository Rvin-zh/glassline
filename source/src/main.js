const { app } = require('electron');
const { detectPlatformCapabilities } = require('./platform/capabilities');
const { acquireSingleInstance } = require('./main-process/single-instance');
const {
  configureE2ENetworkPolicy
} = require('./platform/e2e-network-guard');

if (acquireSingleInstance(app)) {
  configureE2ENetworkPolicy(app);

  // Chromium switches must be registered before app ready.
  app.commandLine.appendSwitch('enable-features', 'VaapiVideoDecoder');
  app.commandLine.appendSwitch('ignore-certificate-errors');
  app.commandLine.appendSwitch('allow-running-insecure-content');
  app.commandLine.appendSwitch('disable-web-security');
  app.commandLine.appendSwitch('enable-media-stream');

  const capabilities = detectPlatformCapabilities();
  if (capabilities.platform === 'linux') {
    if (typeof app.setDesktopName === 'function') {
      app.setDesktopName('com.opencluely.assistant.desktop');
    }

    // Keep media/capture paths available under Fedora.
    app.commandLine.appendSwitch('enable-features', 'WebRTCPipeWireCapturer,VaapiVideoDecoder');

    // Electron 44 on Fedora frequently fails when the GPU process cannot start
    // under sandbox/XWayland. Prefer software rendering for reliability.
    if (process.env.OPEN_CLUELY_ENABLE_GPU !== '1') {
      app.disableHardwareAcceleration();
      app.commandLine.appendSwitch('disable-gpu');
      app.commandLine.appendSwitch('disable-gpu-compositing');
      app.commandLine.appendSwitch('disable-gpu-sandbox');
      app.commandLine.appendSwitch('in-process-gpu');
    }
  }

  process.title = 'open-cluely';

  const { startApplication } = require('./main-process/start-application');
  startApplication().catch((error) => {
    console.error('Fatal startup failure:', error);
    process.exit(1);
  });
}
