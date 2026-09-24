#!/usr/bin/env node
'use strict';

/**
 * Opt-in OpenAI Realtime STT smoke test.
 *
 * Requires OPENAI_API_KEY or a Portkey key with an OpenAI virtual key.
 * Never prints credentials or transcript text.
 * Usage:
 *   OPENAI_API_KEY=... npm run smoke:stt
 *   PORTKEY_API_KEY=... npm run smoke:stt
 */

const WebSocket = require('ws');
const { createOpenAiRealtimeSttService } = require('../src/services/stt/openai-realtime');
const { getSttSampleRate } = require('../src/config');

function createDefaultIo() {
  return {
    log: (...args) => console.log(...args),
    error: (...args) => console.error(...args),
    write: (value) => process.stdout.write(value)
  };
}

function getConfiguredCredentials(env) {
  return [
    env?.OPENAI_API_KEY,
    env?.PORTKEY_API_KEY,
    env?.PORTKEY_OPENAI_VIRTUAL_KEY
  ]
    .map((value) => String(value || '').trim())
    .filter(Boolean);
}

function extractErrorMessage(error, fallback = 'Unknown error') {
  if (typeof error === 'string' && error) {
    return error;
  }
  if (!error || typeof error !== 'object') {
    return fallback;
  }
  if (error.error && error.error !== error) {
    return extractErrorMessage(error.error, fallback);
  }
  if (typeof error.message === 'string' && error.message) {
    return error.message;
  }
  return fallback;
}

function sanitizeSmokeError(error, credentialValues = [], fallback) {
  let message = extractErrorMessage(error, fallback);

  for (const credential of [...credentialValues].sort((a, b) => b.length - a.length)) {
    message = message.split(credential).join('[REDACTED]');
  }

  return message
    .replace(
      /(\bx-portkey-[a-z0-9-]+\s*[:=]\s*)(?:"[^"]*"|'[^']*'|[^\s,;]+)/gi,
      '$1[REDACTED]'
    )
    .replace(
      /\bBearer\s+(?:"[^"]*"|'[^']*'|[A-Za-z0-9._~+/=-]+)/gi,
      'Bearer [REDACTED]'
    )
    .replace(/\bsk-[A-Za-z0-9][A-Za-z0-9_-]*/g, '[REDACTED]');
}

function evaluateSttSmokeEvents(events) {
  const collectedEvents = Array.isArray(events) ? events : [];
  const sessionUpdated = collectedEvents.some((entry) => (
    entry?.channel === 'stt-debug'
    && entry?.data?.event === 'session.updated'
  ));
  const errorCount = collectedEvents.filter((entry) => (
    entry?.channel === 'vosk-error'
    || (
      entry?.channel === 'stt-debug'
      && entry?.data?.level === 'error'
    )
  )).length;
  const finalEvents = collectedEvents.filter((entry) => (
    entry?.channel === 'vosk-final'
  ));
  const finalCharacterCount = finalEvents.reduce(
    (total, entry) => total + String(entry?.data?.text || '').length,
    0
  );

  return {
    ok: sessionUpdated && errorCount === 0,
    eventCount: collectedEvents.length,
    sessionUpdated,
    errorCount,
    finalEventCount: finalEvents.length,
    finalCharacterCount
  };
}

function formatFinalTranscriptMetric(data) {
  return `vosk-final: events=1 chars=${String(data?.text || '').length}`;
}

async function main(options = {}) {
  const env = options.env || process.env;
  const io = options.io || createDefaultIo();
  const sleep = options.sleep || ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  const setExitCode = options.setExitCode || ((code) => {
    process.exitCode = code;
  });
  const createService = options.createService || createOpenAiRealtimeSttService;
  const credentials = getConfiguredCredentials(env);
  const printError = (prefix, error, fallback) => {
    io.error(prefix, sanitizeSmokeError(error, credentials, fallback));
  };
  const apiKey = String(env.OPENAI_API_KEY || '').trim();
  const portkeyApiKey = String(env.PORTKEY_API_KEY || '').trim();
  if (!apiKey && !portkeyApiKey) {
    io.error('smoke-stt: skipped — set OPENAI_API_KEY or PORTKEY_API_KEY to run this opt-in live test.');
    setExitCode(0);
    return;
  }

  const events = [];
  const sendToRenderer = (channel, data) => {
    events.push({ channel, data });
    if (channel === 'vosk-error') {
      printError('vosk-error:', data?.error ?? data, 'Unknown provider error');
    } else if (channel === 'vosk-status') {
      io.log(
        'vosk-status:',
        String(data?.status || ''),
        String(data?.message || '')
      );
    } else if (channel === 'vosk-partial') {
      io.write('.');
    } else if (channel === 'vosk-final') {
      io.log(`\n${formatFinalTranscriptMetric(data)}`);
    }
  };

  const service = createService({
    WebSocket: options.WebSocket || WebSocket,
    desktopCapturer: { getSources: async () => [] },
    getOpenaiApiKey: () => apiKey,
    getPortkeyApiKey: () => portkeyApiKey,
    getPortkeyRealtimeVirtualKey: () => env.PORTKEY_OPENAI_VIRTUAL_KEY || 'openai',
    getOpenaiSttModel: () => env.OPENAI_STT_MODEL || 'gpt-live-transcribe',
    getTranscriptionHints: () => ({
      prompt: 'Smoke test for Open-Cluely realtime transcription.',
      keywords: ['Open-Cluely', 'smoke']
    }),
    getGeminiService: () => null,
    sendToRenderer
  });

  const sampleRate = getSttSampleRate('openai');
  io.log(
    `smoke-stt: connecting OpenAI Realtime STT @ ${sampleRate} Hz via ${
      apiKey ? 'direct OpenAI' : 'Portkey'
    } (key present, not logged)`
  );

  const startResult = service.start('mic');
  if (!startResult?.success) {
    printError(
      'smoke-stt: start failed:',
      startResult?.error ?? startResult,
      'Unknown start failure'
    );
    service.dispose();
    setExitCode(1);
    return;
  }

  // Send ~1.5s of silence so the session establishes without requiring a mic.
  const silence = Buffer.alloc(Math.round(sampleRate * 1.5) * 2);
  const frameBytes = Math.round(sampleRate * 0.1) * 2;
  for (let offset = 0; offset < silence.length; offset += frameBytes) {
    service.handleAudioChunk({
      source: 'mic',
      data: silence.subarray(offset, Math.min(offset + frameBytes, silence.length))
    });
    await sleep(100);
  }

  await sleep(1500);
  let stopResult;
  try {
    stopResult = await service.stop({ source: 'mic' });
  } finally {
    service.dispose();
  }
  if (!stopResult?.success) {
    printError(
      'smoke-stt: stop failed:',
      stopResult?.error ?? stopResult,
      'Transcription drain failed'
    );
    setExitCode(1);
    return;
  }

  const summary = evaluateSttSmokeEvents(events);
  io.log(
    `\nsmoke-stt: events=${summary.eventCount}`
    + ` sessionUpdated=${summary.sessionUpdated}`
    + ` errors=${summary.errorCount}`
    + ` finalEvents=${summary.finalEventCount}`
    + ` finalChars=${summary.finalCharacterCount}`
  );

  if (!summary.ok) {
    setExitCode(1);
    return;
  }

  io.log('smoke-stt: ok');
}

async function runCli(options = {}) {
  try {
    return await main(options);
  } catch (error) {
    const env = options.env || process.env;
    const io = options.io || createDefaultIo();
    const setExitCode = options.setExitCode || ((code) => {
      process.exitCode = code;
    });
    io.error(
      'smoke-stt: failed:',
      sanitizeSmokeError(error, getConfiguredCredentials(env), 'Unknown top-level error')
    );
    setExitCode(1);
    return undefined;
  }
}

if (require.main === module) {
  runCli();
}

module.exports = {
  evaluateSttSmokeEvents,
  formatFinalTranscriptMetric,
  main,
  runCli,
  sanitizeSmokeError
};
