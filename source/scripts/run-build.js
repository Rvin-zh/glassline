'use strict';

// Build launcher. electron-builder spawns helpers that misbehave when
// ELECTRON_RUN_AS_NODE is inherited from the shell, so we strip it here too.
// Detects the current platform and picks a sensible default target.

const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');

const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;

const platformArgs = (() => {
  switch (os.platform()) {
    case 'win32':  return ['--win', 'portable'];
    case 'darwin': return ['--mac'];
    case 'linux':  return ['--linux'];
    default:       return [];
  }
})();

const userPlatformArgs = process.argv.slice(2).filter((arg) => (
  arg === '--mac' || arg === '--win' || arg === '--linux'
));
const args = userPlatformArgs.length > 0
  ? process.argv.slice(2)
  : [...platformArgs, ...process.argv.slice(2)];

// Before invoking electron-builder for macOS, evaluate the unsigned Mac
// packaging contract (icns, entitlements, dmg+zip targets, identity null).
// On Fedora we cannot rely on `npm run build:mac` succeeding — darwin
// Electron binaries may be unavailable — so the contract is the gate.

function ensureMacSettingsSeed(rootDir) {
  const seedPath = path.join(rootDir, 'packaging', 'macos', 'settings-seed.json');
  const examplePath = path.join(rootDir, 'packaging', 'macos', 'settings-seed.example.json');
  if (fs.existsSync(seedPath)) {
    return;
  }
  if (!fs.existsSync(examplePath)) {
    fs.mkdirSync(path.dirname(seedPath), { recursive: true });
    fs.writeFileSync(seedPath, `${JSON.stringify({ version: 1 }, null, 2)}\n`);
    return;
  }
  fs.copyFileSync(examplePath, seedPath);
}

if (args.includes('--mac')) {
  const {
    loadMacPackagingContract,
    evaluateMacPackagingContract
  } = require('../src/platform/macos-packaging-contract');
  const rootDir = path.join(__dirname, '..');
  ensureMacSettingsSeed(rootDir);
  const contract = loadMacPackagingContract(rootDir);
  const result = evaluateMacPackagingContract(contract);
  if (!result.ok) {
    console.error(result.errors.join('\n'));
    process.exit(1);
  }
}

// Invoke electron-builder via Node directly to avoid spawning the .cmd
// shim on Windows (which needs shell:true and triggers a deprecation
// warning). The CLI module path is stable across versions.
const builderCli = require.resolve('electron-builder/out/cli/cli.js');
const child = spawn(process.execPath, [builderCli, ...args], {
  stdio: 'inherit',
  env
});

child.on('exit', (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal);
    return;
  }
  process.exit(code ?? 0);
});

child.on('error', (err) => {
  console.error('[run-build] Failed to spawn electron-builder:', err.message);
  process.exit(1);
});
