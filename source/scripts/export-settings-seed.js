'use strict';

const path = require('path');
const { app } = require('electron');
const { loadAppState } = require('../src/services/state/app-state');
const { loadApplicationEnvironment } = require('../src/bootstrap/environment');
const { writeSettingsSeed } = require('../src/services/state/settings-seed');

const DEFAULT_OUT = path.join(__dirname, '..', 'packaging', 'macos', 'settings-seed.json');

function resolveOutPath(argv) {
  const flagIndex = argv.indexOf('--out');
  if (flagIndex >= 0 && argv[flagIndex + 1]) {
    return path.resolve(argv[flagIndex + 1]);
  }
  return DEFAULT_OUT;
}

app.whenReady().then(() => {
  const appEnvironment = loadApplicationEnvironment(app);
  const appState = loadAppState(app);
  const outPath = resolveOutPath(process.argv);
  const result = writeSettingsSeed(outPath, appState, appEnvironment);
  console.log('[export-settings-seed] Wrote seed (values not logged):', {
    path: result.path,
    hasPortkey: result.hasPortkey,
    hasOpenAI: result.hasOpenAI,
    hasGemini: result.hasGemini
  });
  app.quit();
}).catch((error) => {
  console.error('[export-settings-seed] Failed:', error?.message || error);
  app.exit(1);
});
