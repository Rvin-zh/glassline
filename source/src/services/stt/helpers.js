'use strict';

function createSttDebugEmitter(sendToRenderer) {
  return function emitSttDebug({
    source = null,
    level = 'info',
    event = 'event',
    message = '',
    meta = null
  } = {}) {
    const payload = {
      ts: new Date().toISOString(),
      source: source === 'mic' || source === 'system' ? source : null,
      level,
      event,
      message,
      meta
    };

    sendToRenderer('stt-debug', payload);
  };
}

async function getDesktopSources(desktopCapturer) {
  try {
    const sources = await desktopCapturer.getSources({ types: ['screen'] });
    return sources.map((source) => ({ id: source.id, name: source.name }));
  } catch (error) {
    console.error('Error getting desktop sources:', error.message);
    return [];
  }
}

/**
 * Build a minimal mono 16-bit PCM WAV buffer.
 */
function pcm16ToWavBuffer(pcmBuffer, sampleRate) {
  const pcm = Buffer.isBuffer(pcmBuffer) ? pcmBuffer : Buffer.from(pcmBuffer);
  const numChannels = 1;
  const bitsPerSample = 16;
  const byteRate = sampleRate * numChannels * (bitsPerSample / 8);
  const blockAlign = numChannels * (bitsPerSample / 8);
  const dataSize = pcm.length;
  const header = Buffer.alloc(44);

  header.write('RIFF', 0);
  header.writeUInt32LE(36 + dataSize, 4);
  header.write('WAVE', 8);
  header.write('fmt ', 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(numChannels, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(byteRate, 28);
  header.writeUInt16LE(blockAlign, 32);
  header.writeUInt16LE(bitsPerSample, 34);
  header.write('data', 36);
  header.writeUInt32LE(dataSize, 40);

  return Buffer.concat([header, pcm]);
}

function sanitizeKeywords(keywords) {
  if (!Array.isArray(keywords)) {
    return [];
  }

  return keywords
    .map((value) => String(value || '').replace(/[<>\r\n]/g, ' ').trim())
    .filter(Boolean)
    .slice(0, 32);
}

function sanitizePrompt(prompt) {
  const trimmed = String(prompt || '').trim();
  if (!trimmed) {
    return '';
  }
  // Keep prompts bounded for Realtime session.update limits.
  return trimmed.slice(0, 1500);
}

module.exports = {
  createSttDebugEmitter,
  getDesktopSources,
  pcm16ToWavBuffer,
  sanitizeKeywords,
  sanitizePrompt
};
