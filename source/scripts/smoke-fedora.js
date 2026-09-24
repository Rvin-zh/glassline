'use strict';

const fs = require('fs');
const path = require('path');
const { detectPlatformCapabilities } = require('../src/platform/capabilities');

function ensureDir(dirPath) {
  fs.mkdirSync(dirPath, { recursive: true });
}

function main(args = process.argv.slice(2)) {
  const noWrite = args.includes('--no-write');
  const capabilities = detectPlatformCapabilities();
  const checks = {
    packageJsonExists: fs.existsSync(path.join(__dirname, '..', 'package.json')),
    envExampleExists: fs.existsSync(path.join(__dirname, '..', '.env.example')),
    linuxIconExists: fs.existsSync(path.join(__dirname, '..', 'assets', 'open-cluely.png')),
    electronInstalled: fs.existsSync(path.join(__dirname, '..', 'node_modules', 'electron')),
    screenshotDesktopInstalled: fs.existsSync(path.join(__dirname, '..', 'node_modules', 'screenshot-desktop'))
  };

  if (!noWrite) {
    checks.envExists = fs.existsSync(path.join(__dirname, '..', '.env'));
  }

  const report = {
    ...(noWrite ? {} : { generatedAt: new Date().toISOString() }),
    node: process.version,
    platform: process.platform,
    arch: process.arch,
    capabilities,
    checks
  };

  if (noWrite) {
    console.log('Fedora smoke diagnostics (no-write mode; no report written)');
  } else {
    const outDir = path.join(__dirname, '..', 'cache', 'diagnostics');
    ensureDir(outDir);
    const outPath = path.join(outDir, `fedora-smoke-${Date.now()}.json`);
    fs.writeFileSync(outPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');

    console.log('Fedora smoke diagnostics written to:', outPath);
  }
  console.log(JSON.stringify({
    sessionType: capabilities.sessionType,
    linuxDisplayProfile: capabilities.linuxDisplayProfile,
    screenshotBackend: capabilities.screenshotBackend,
    hostAudioBackend: capabilities.hostAudioBackend,
    contentProtectionSupported: capabilities.contentProtectionSupported,
    checks: report.checks
  }, null, 2));

  const required = [
    report.checks.packageJsonExists,
    report.checks.linuxIconExists,
    report.checks.electronInstalled,
    ...(!noWrite ? [report.checks.envExists] : [])
  ];

  if (required.some((value) => !value)) {
    process.exitCode = 1;
  }
}

main();
