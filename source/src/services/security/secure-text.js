'use strict';

const ENVELOPE_PREFIX = 'enc:v1:';

function isEncryptedEnvelope(value) {
  return typeof value === 'string' && value.startsWith(ENVELOPE_PREFIX);
}

function resolveSafeStorage() {
  try {
    // Lazy require so unit tests can run without Electron.
    // Outside Electron, `require('electron')` returns a path string.
    const electron = require('electron');
    if (!electron || typeof electron !== 'object' || !electron.safeStorage) {
      return null;
    }
    return electron.safeStorage;
  } catch {
    return null;
  }
}

function createSecureText(options = {}) {
  const warn = typeof options.warn === 'function' ? options.warn : console.warn;
  let warnedUnavailable = false;

  const isEncryptionAvailable = typeof options.isEncryptionAvailable === 'function'
    ? options.isEncryptionAvailable
    : () => {
      const safeStorage = resolveSafeStorage();
      try {
        return Boolean(safeStorage && typeof safeStorage.isEncryptionAvailable === 'function'
          && safeStorage.isEncryptionAvailable());
      } catch {
        return false;
      }
    };

  const encryptString = typeof options.encryptString === 'function'
    ? options.encryptString
    : (plaintext) => {
      const safeStorage = resolveSafeStorage();
      if (!safeStorage || typeof safeStorage.encryptString !== 'function') {
        throw new Error('safeStorage.encryptString is unavailable');
      }
      return safeStorage.encryptString(String(plaintext));
    };

  const decryptString = typeof options.decryptString === 'function'
    ? options.decryptString
    : (buffer) => {
      const safeStorage = resolveSafeStorage();
      if (!safeStorage || typeof safeStorage.decryptString !== 'function') {
        throw new Error('safeStorage.decryptString is unavailable');
      }
      return safeStorage.decryptString(buffer);
    };

  function warnUnavailable(reason) {
    if (warnedUnavailable) {
      return;
    }
    warnedUnavailable = true;
    warn(
      `[secure-text] Electron safeStorage encryption unavailable (${reason}); `
      + 'persisting sensitive document text as plaintext. '
      + 'On Linux, enable a secret service / keyring for at-rest encryption.'
    );
  }

  function encryptForStorage(value) {
    if (value == null) {
      return value;
    }
    if (typeof value !== 'string') {
      return value;
    }
    if (!value) {
      return value;
    }
    if (isEncryptedEnvelope(value)) {
      return value;
    }

    if (!isEncryptionAvailable()) {
      warnUnavailable('isEncryptionAvailable() returned false');
      return value;
    }

    try {
      const ciphertext = encryptString(value);
      const buffer = Buffer.isBuffer(ciphertext) ? ciphertext : Buffer.from(ciphertext);
      return `${ENVELOPE_PREFIX}${buffer.toString('base64')}`;
    } catch (error) {
      warnUnavailable(error && error.message ? error.message : 'encrypt failed');
      return value;
    }
  }

  function decryptFromStorage(value) {
    if (value == null) {
      return value;
    }
    if (typeof value !== 'string') {
      return value;
    }
    if (!value || !isEncryptedEnvelope(value)) {
      return value;
    }

    try {
      const encoded = value.slice(ENVELOPE_PREFIX.length);
      const buffer = Buffer.from(encoded, 'base64');
      return decryptString(buffer);
    } catch (error) {
      warn(
        `[secure-text] Failed to decrypt stored text; leaving envelope as-is: ${
          error && error.message ? error.message : 'decrypt failed'
        }`
      );
      return value;
    }
  }

  return {
    ENVELOPE_PREFIX,
    isEncryptedEnvelope,
    isEncryptionAvailable,
    encryptForStorage,
    decryptFromStorage
  };
}

const defaultSecureText = createSecureText();

module.exports = {
  ENVELOPE_PREFIX,
  isEncryptedEnvelope,
  createSecureText,
  encryptForStorage: (...args) => defaultSecureText.encryptForStorage(...args),
  decryptFromStorage: (...args) => defaultSecureText.decryptFromStorage(...args)
};
