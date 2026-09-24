'use strict';

// macOS packaging contract.
//
// Consumes the `build.mac` block from package.json plus the on-disk
// packaging files (icns icon, entitlements plists) and exposes a plain
// object that smoke:macos and `run-build.js --mac` evaluate before
// invoking electron-builder. The contract intentionally does NOT require
// `npm run build:mac` to succeed on non-darwin hosts: darwin Electron
// binaries cannot always be downloaded on Fedora, so the contract and
// smoke are the gate, not the build itself.

const fs = require('fs');
const path = require('path');

const EXPECTED_ICON = 'assets/open-cluely.icns';
const EXPECTED_ENTITLEMENTS = 'packaging/macos/entitlements.mac.plist';
const EXPECTED_ENTITLEMENTS_INHERIT = 'packaging/macos/entitlements.mac.inherit.plist';
const CAMERA_ENTITLEMENT_KEY = 'com.apple.security.device.camera';

function readPackageJson(rootDir) {
  const pkgPath = path.join(rootDir, 'package.json');
  if (!fs.existsSync(pkgPath)) {
    throw new Error(`Missing package.json: ${pkgPath}`);
  }
  return JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
}

function collectTargetNames(macBlock) {
  const target = macBlock && macBlock.target;
  if (!Array.isArray(target)) {
    return [];
  }
  return target.map((entry) => {
    if (typeof entry === 'string') {
      return entry;
    }
    return entry && entry.target;
  }).filter(Boolean);
}

function collectArches(macBlock) {
  const target = macBlock && macBlock.target;
  if (!Array.isArray(target)) {
    return [];
  }
  const arches = new Set();
  for (const entry of target) {
    if (typeof entry === 'string') {
      continue;
    }
    const entryArches = entry && entry.arch;
    if (Array.isArray(entryArches)) {
      for (const arch of entryArches) {
        if (arch) {
          arches.add(arch);
        }
      }
    }
  }
  return [...arches];
}

function readPlistKeys(plistPath) {
  if (!fs.existsSync(plistPath)) {
    return [];
  }
  const contents = fs.readFileSync(plistPath, 'utf8');
  const keys = [];
  const keyRegex = /<key>([^<]+)<\/key>/g;
  let match;
  while ((match = keyRegex.exec(contents)) !== null) {
    keys.push(match[1]);
  }
  return keys;
}

function loadMacPackagingContract(rootDir) {
  const pkg = readPackageJson(rootDir);
  const macBlock = (pkg && pkg.build && pkg.build.mac) || {};
  const icon = macBlock.icon || null;
  const entitlements = macBlock.entitlements || null;
  const entitlementsInherit = macBlock.entitlementsInherit || null;
  const identity = Object.prototype.hasOwnProperty.call(macBlock, 'identity')
    ? macBlock.identity
    : undefined;
  const hardenedRuntime = macBlock.hardenedRuntime === true;
  const targetNames = collectTargetNames(macBlock);
  const arches = collectArches(macBlock);
  const extendInfo = macBlock.extendInfo || {};
  const microphoneUsage = extendInfo.NSMicrophoneUsageDescription || '';
  const cameraUsage = extendInfo.NSCameraUsageDescription || '';
  const audioCaptureUsage = extendInfo.NSAudioCaptureUsageDescription || '';
  const gatekeeperAssess = macBlock.gatekeeperAssess;

  let hasCameraEntitlement = false;
  if (entitlements) {
    const absEntitlements = path.isAbsolute(entitlements)
      ? entitlements
      : path.join(rootDir, entitlements);
    hasCameraEntitlement = readPlistKeys(absEntitlements).includes(CAMERA_ENTITLEMENT_KEY);
  }

  return {
    rootDir,
    icon,
    entitlements,
    entitlementsInherit,
    identity,
    hardenedRuntime,
    gatekeeperAssess,
    targetNames,
    arches,
    microphoneUsage,
    cameraUsage,
    audioCaptureUsage,
    hasCameraEntitlement
  };
}

function evaluateMacPackagingContract(contract) {
  const errors = [];
  const rootDir = contract && contract.rootDir;
  if (!rootDir) {
    errors.push('Missing Mac contract rootDir');
    return { ok: false, errors };
  }

  const resolveAbs = (relative) => {
    if (!relative) {
      return null;
    }
    return path.isAbsolute(relative) ? relative : path.join(rootDir, relative);
  };

  if (contract.icon !== EXPECTED_ICON) {
    errors.push(`Unexpected Mac icon: expected ${EXPECTED_ICON}, got ${String(contract.icon)}`);
  } else {
    const iconAbs = resolveAbs(contract.icon);
    if (!iconAbs || !fs.existsSync(iconAbs)) {
      errors.push(`Missing Mac icon: ${iconAbs || '(null)'}`);
    }
  }

  if (contract.identity !== null) {
    errors.push(`Mac identity must be null for unsigned builds, got ${String(contract.identity)}`);
  }

  if (contract.hardenedRuntime !== true) {
    errors.push('Mac hardenedRuntime must be true');
  }

  if (contract.gatekeeperAssess !== false) {
    errors.push('Mac gatekeeperAssess must be false');
  }

  if (!contract.entitlements) {
    errors.push('Missing Mac entitlements path');
  } else if (contract.entitlements.includes('build/')) {
    errors.push(`Mac entitlements must not live under build/: ${contract.entitlements}`);
  } else if (contract.entitlements !== EXPECTED_ENTITLEMENTS) {
    errors.push(`Unexpected Mac entitlements path: ${contract.entitlements}`);
  } else {
    const entAbs = resolveAbs(contract.entitlements);
    if (!entAbs || !fs.existsSync(entAbs)) {
      errors.push(`Missing Mac entitlements: ${entAbs || '(null)'}`);
    }
  }

  if (!contract.entitlementsInherit) {
    errors.push('Missing Mac entitlementsInherit path');
  } else if (contract.entitlementsInherit.includes('build/')) {
    errors.push(`Mac entitlementsInherit must not live under build/: ${contract.entitlementsInherit}`);
  } else if (contract.entitlementsInherit !== EXPECTED_ENTITLEMENTS_INHERIT) {
    errors.push(`Unexpected Mac entitlementsInherit path: ${contract.entitlementsInherit}`);
  } else {
    const entInheritAbs = resolveAbs(contract.entitlementsInherit);
    if (!entInheritAbs || !fs.existsSync(entInheritAbs)) {
      errors.push(`Missing Mac entitlementsInherit: ${entInheritAbs || '(null)'}`);
    }
  }

  const targetNames = (contract.targetNames || []).slice().sort();
  if (targetNames.join(',') !== ['dmg', 'zip'].join(',')) {
    errors.push(`Mac target must be dmg+zip, got ${JSON.stringify(contract.targetNames)}`);
  }

  const arches = (contract.arches || []).slice().sort();
  if (arches.join(',') !== ['arm64', 'x64'].join(',')) {
    errors.push(`Mac arches must be arm64+x64, got ${JSON.stringify(contract.arches)}`);
  }

  if (!/live interview transcription/.test(contract.microphoneUsage || '')) {
    errors.push('Mac NSMicrophoneUsageDescription must mention live interview transcription');
  }

  if (!/does not use the webcam/.test(contract.cameraUsage || '')) {
    errors.push('Mac NSCameraUsageDescription must state it does not use the webcam');
  }

  if (!/desktop-capturer loopback|Screen Recording/i.test(contract.audioCaptureUsage || '')) {
    errors.push('Mac NSAudioCaptureUsageDescription must mention desktop-capturer loopback / Screen Recording consent');
  }

  if (contract.hasCameraEntitlement) {
    errors.push(`Mac entitlements must not include ${CAMERA_ENTITLEMENT_KEY}`);
  }

  return {
    ok: errors.length === 0,
    errors
  };
}

module.exports = {
  loadMacPackagingContract,
  evaluateMacPackagingContract,
  EXPECTED_ICON,
  EXPECTED_ENTITLEMENTS,
  EXPECTED_ENTITLEMENTS_INHERIT,
  CAMERA_ENTITLEMENT_KEY
};
