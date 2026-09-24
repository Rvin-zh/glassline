'use strict';

// macOS packaging smoke. Evaluates the unsigned Mac packaging contract
// (icns icon, entitlements outside build/, dmg+zip for arm64+x64, identity
// null, no camera entitlement) and prints a JSON summary.
//
// Usage:
//   node scripts/smoke-macos.js            # writes report to cache/diagnostics
//   node scripts/smoke-macos.js --no-write # no report written; stdout only
//
// Exit 1 when the contract is not satisfied. Does NOT invoke
// electron-builder; darwin binaries cannot always be fetched on Fedora.

const fs = require('fs');
const path = require('path');
const {
  loadMacPackagingContract,
  evaluateMacPackagingContract
} = require('../src/platform/macos-packaging-contract');

const ROOT = path.join(__dirname, '..');

function ensureDir(dirPath) {
  fs.mkdirSync(dirPath, { recursive: true });
}

function main(args = process.argv.slice(2)) {
  const noWrite = args.includes('--no-write');
  const contract = loadMacPackagingContract(ROOT);
  const result = evaluateMacPackagingContract(contract);

  const summary = {
    ...(noWrite ? {} : { generatedAt: new Date().toISOString() }),
    platform: process.platform,
    ok: result.ok,
    errors: result.errors,
    icon: contract.icon,
    identity: contract.identity,
    hardenedRuntime: contract.hardenedRuntime,
    gatekeeperAssess: contract.gatekeeperAssess,
    entitlements: contract.entitlements,
    entitlementsInherit: contract.entitlementsInherit,
    targetNames: contract.targetNames,
    arches: contract.arches,
    microphoneUsage: contract.microphoneUsage,
    cameraUsage: contract.cameraUsage,
    hasCameraEntitlement: contract.hasCameraEntitlement
  };

  if (noWrite) {
    console.log('macOS smoke (no-write mode; no report written)');
  } else {
    const outDir = path.join(ROOT, 'cache', 'diagnostics');
    ensureDir(outDir);
    const outPath = path.join(outDir, `macos-smoke-${Date.now()}.json`);
    fs.writeFileSync(outPath, `${JSON.stringify(summary, null, 2)}\n`, 'utf8');
    console.log('macOS smoke written to:', outPath);
  }

  console.log(JSON.stringify(summary, null, 2));

  if (!result.ok) {
    process.exitCode = 1;
  }
}

main();
