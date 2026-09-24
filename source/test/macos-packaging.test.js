'use strict';

const path = require('path');
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const {
  evaluateMacPackagingContract,
  loadMacPackagingContract
} = require('../src/platform/macos-packaging-contract');

describe('macOS packaging contract', () => {
  it('requires icns, entitlements outside build/, and unsigned dmg+zip targets', () => {
    const contract = loadMacPackagingContract(path.join(__dirname, '..'));
    const result = evaluateMacPackagingContract(contract);
    assert.deepEqual(result.errors, []);
    assert.equal(result.ok, true);
    assert.equal(contract.icon, 'assets/open-cluely.icns');
    assert.equal(contract.identity, null);
    assert.equal(contract.hardenedRuntime, true);
    assert.equal(contract.entitlements.includes('build/'), false);
    assert.deepEqual(contract.targetNames.sort(), ['dmg', 'zip']);
    assert.deepEqual(contract.arches.sort(), ['arm64', 'x64']);
    assert.match(contract.microphoneUsage, /live interview transcription/);
    assert.match(contract.cameraUsage, /does not use the webcam/);
    assert.match(contract.audioCaptureUsage, /desktop-capturer loopback|Screen Recording/i);
    assert.equal(contract.hasCameraEntitlement, false);
  });
});
