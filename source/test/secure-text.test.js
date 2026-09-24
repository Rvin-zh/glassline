'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const {
  ENVELOPE_PREFIX,
  isEncryptedEnvelope,
  createSecureText
} = require('../src/services/security/secure-text');
const {
  sealAppStateForDisk,
  unsealAppStateFromDisk
} = require('../src/services/state/app-state');

function createMockCrypto({ available = true } = {}) {
  const store = new Map();
  let nextId = 0;

  return {
    isEncryptionAvailable: () => available,
    encryptString(plaintext) {
      if (!available) {
        throw new Error('encryption unavailable');
      }
      const token = `tok-${nextId++}`;
      store.set(token, String(plaintext));
      return Buffer.from(token, 'utf8');
    },
    decryptString(buffer) {
      if (!available) {
        throw new Error('encryption unavailable');
      }
      const token = Buffer.from(buffer).toString('utf8');
      if (!store.has(token)) {
        throw new Error('unknown ciphertext');
      }
      return store.get(token);
    }
  };
}

describe('secure-text envelope helpers', () => {
  it('detects versioned envelopes and ignores plaintext', () => {
    assert.equal(isEncryptedEnvelope(`${ENVELOPE_PREFIX}abc`), true);
    assert.equal(isEncryptedEnvelope('plain resume text'), false);
    assert.equal(isEncryptedEnvelope(''), false);
    assert.equal(isEncryptedEnvelope(null), false);
  });

  it('encrypts with injectable deps and round-trips through the envelope', () => {
    const warnings = [];
    const crypto = createMockCrypto({ available: true });
    const secure = createSecureText({
      ...crypto,
      warn: (message) => warnings.push(message)
    });

    const encrypted = secure.encryptForStorage('CV plaintext');
    assert.equal(isEncryptedEnvelope(encrypted), true);
    assert.equal(encrypted.startsWith(ENVELOPE_PREFIX), true);
    assert.notEqual(encrypted, 'CV plaintext');
    assert.equal(secure.decryptFromStorage(encrypted), 'CV plaintext');
    assert.equal(warnings.length, 0);
  });

  it('falls back to plaintext and warns when encryption is unavailable', () => {
    const warnings = [];
    const crypto = createMockCrypto({ available: false });
    const secure = createSecureText({
      ...crypto,
      warn: (message) => warnings.push(String(message))
    });

    const stored = secure.encryptForStorage('JD plaintext');
    assert.equal(stored, 'JD plaintext');
    assert.equal(isEncryptedEnvelope(stored), false);
    assert.equal(secure.decryptFromStorage(stored), 'JD plaintext');
    assert.ok(warnings.some((message) => /encryption unavailable|safeStorage|keyring/i.test(message)));
  });

  it('reads legacy plaintext transparently and leaves empty values alone', () => {
    const crypto = createMockCrypto({ available: true });
    const secure = createSecureText(crypto);

    assert.equal(secure.decryptFromStorage('legacy plaintext CV'), 'legacy plaintext CV');
    assert.equal(secure.encryptForStorage(''), '');
    assert.equal(secure.encryptForStorage(null), null);
    assert.equal(secure.decryptFromStorage(''), '');
  });

  it('does not double-encrypt an existing envelope', () => {
    const crypto = createMockCrypto({ available: true });
    const secure = createSecureText(crypto);

    const once = secure.encryptForStorage('once');
    const twice = secure.encryptForStorage(once);
    assert.equal(twice, once);
    assert.equal(secure.decryptFromStorage(twice), 'once');
  });
});

describe('app-state seal/unseal for sensitive text', () => {
  it('encrypts API keys, documents, and durable notes for disk and restores plaintext', () => {
    const secure = createSecureText(createMockCrypto({ available: true }));
    const plaintextState = {
      resumeText: 'resume body',
      jobDescriptionText: 'jd body',
      documents: {
        resume: { text: 'resume body', enabled: true, source: null, hash: 'h1', updatedAt: null },
        jobDescription: { text: 'jd body', enabled: true, source: null, hash: 'h2', updatedAt: null }
      },
      durableNotes: [{ id: '1', text: 'approved note', status: 'approved' }],
      interviewSessions: [{
        id: 'interview-2026-09-09-deadbeefdeadbeef',
        archivedAt: '2026-09-09T20:15:30.000Z',
        title: 'System design — 2026-09-09',
        summary: {
          currentTopic: 'System design',
          questions: ['Design a queue'],
          facts: ['Used backpressure'],
          candidateExamples: ['Migrated a worker fleet'],
          strengthsGaps: ['Strong reliability reasoning'],
          commitments: ['Review capacity estimates']
        },
        notes: [{ text: 'Prefer concrete trade-offs' }]
      }],
      geminiApiKey: 'gemini-secret',
      portkeyApiKey: 'portkey-secret',
      openaiApiKey: 'openai-secret'
    };

    const sealed = sealAppStateForDisk(plaintextState, secure);
    assert.equal(isEncryptedEnvelope(sealed.resumeText), true);
    assert.equal(isEncryptedEnvelope(sealed.jobDescriptionText), true);
    assert.equal(isEncryptedEnvelope(sealed.documents.resume.text), true);
    assert.equal(isEncryptedEnvelope(sealed.documents.jobDescription.text), true);
    assert.equal(isEncryptedEnvelope(sealed.durableNotes[0].text), true);
    assert.equal(isEncryptedEnvelope(sealed.interviewSessions[0].title), true);
    assert.equal(
      isEncryptedEnvelope(sealed.interviewSessions[0].summary.currentTopic),
      true
    );
    assert.equal(
      isEncryptedEnvelope(sealed.interviewSessions[0].summary.questions[0]),
      true
    );
    assert.equal(
      isEncryptedEnvelope(sealed.interviewSessions[0].notes[0].text),
      true
    );
    assert.equal(isEncryptedEnvelope(sealed.geminiApiKey), true);
    assert.equal(isEncryptedEnvelope(sealed.portkeyApiKey), true);
    assert.equal(isEncryptedEnvelope(sealed.openaiApiKey), true);
    const serialized = JSON.stringify(sealed);
    assert.equal(serialized.includes('System design'), false);
    assert.equal(serialized.includes('Design a queue'), false);
    assert.equal(serialized.includes('Prefer concrete trade-offs'), false);

    const unsealed = unsealAppStateFromDisk(sealed, secure);
    assert.equal(unsealed.resumeText, 'resume body');
    assert.equal(unsealed.jobDescriptionText, 'jd body');
    assert.equal(unsealed.documents.resume.text, 'resume body');
    assert.equal(unsealed.documents.jobDescription.text, 'jd body');
    assert.equal(unsealed.durableNotes[0].text, 'approved note');
    assert.equal(unsealed.interviewSessions[0].title, 'System design — 2026-09-09');
    assert.equal(unsealed.interviewSessions[0].summary.currentTopic, 'System design');
    assert.equal(unsealed.interviewSessions[0].summary.questions[0], 'Design a queue');
    assert.equal(unsealed.interviewSessions[0].notes[0].text, 'Prefer concrete trade-offs');
    assert.equal(unsealed.geminiApiKey, 'gemini-secret');
    assert.equal(unsealed.portkeyApiKey, 'portkey-secret');
    assert.equal(unsealed.openaiApiKey, 'openai-secret');
  });

  it('loads legacy plaintext documents without requiring encryption', () => {
    const secure = createSecureText(createMockCrypto({ available: false }));
    const legacy = {
      documents: {
        resume: { text: 'legacy cv', enabled: true },
        jobDescription: { text: 'legacy jd', enabled: true }
      },
      durableNotes: [{ id: 'n1', text: 'legacy note' }]
    };

    const unsealed = unsealAppStateFromDisk(legacy, secure);
    assert.equal(unsealed.documents.resume.text, 'legacy cv');
    assert.equal(unsealed.documents.jobDescription.text, 'legacy jd');
    assert.equal(unsealed.durableNotes[0].text, 'legacy note');
  });
});
