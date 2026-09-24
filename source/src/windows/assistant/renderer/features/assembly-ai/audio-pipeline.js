import { normalizeSource } from './source-state.js';

const DEFAULT_TARGET_SAMPLE_RATE = 16000;
const TARGET_FRAME_MS = 100;
const MIN_FRAME_MS = 50;
const WORKLET_MODULE_PATH = 'pcm-capture-worklet.js';

export function createAudioPipeline({ sendAudioChunk, addMonitorLog }) {
  let targetSampleRate = DEFAULT_TARGET_SAMPLE_RATE;
  let targetFrameSamples = Math.round((targetSampleRate * TARGET_FRAME_MS) / 1000);
  let minFrameSamples = Math.round((targetSampleRate * MIN_FRAME_MS) / 1000);

  const workletLoadedContexts = new WeakSet();
  const sourceSampleQueues = {
    mic: { chunks: [], length: 0 },
    system: { chunks: [], length: 0 }
  };
  const audioChunkCounters = { mic: 0, system: 0 };

  function setTargetSampleRate(sampleRate) {
    const nextRate = Number.parseInt(String(sampleRate ?? ''), 10);
    if (!Number.isFinite(nextRate) || nextRate <= 0) {
      return targetSampleRate;
    }
    targetSampleRate = nextRate;
    targetFrameSamples = Math.round((targetSampleRate * TARGET_FRAME_MS) / 1000);
    minFrameSamples = Math.round((targetSampleRate * MIN_FRAME_MS) / 1000);
    return targetSampleRate;
  }

  function getTargetSampleRate() {
    return targetSampleRate;
  }

  function convertToPCM16(float32Data) {
    const int16Data = new Int16Array(float32Data.length);
    for (let index = 0; index < float32Data.length; index += 1) {
      const sample = Math.max(-1, Math.min(1, float32Data[index]));
      int16Data[index] = sample < 0 ? sample * 0x8000 : sample * 0x7fff;
    }
    return int16Data;
  }

  function downsampleFloat32Buffer(input, inputSampleRate, outputSampleRate = targetSampleRate) {
    if (inputSampleRate <= 0 || outputSampleRate <= 0 || input.length === 0) {
      return input;
    }

    if (inputSampleRate === outputSampleRate) {
      return input;
    }

    const sampleRateRatio = inputSampleRate / outputSampleRate;
    const newLength = Math.max(1, Math.round(input.length / sampleRateRatio));
    const result = new Float32Array(newLength);
    let offsetResult = 0;
    let offsetInput = 0;

    while (offsetResult < result.length) {
      const nextOffsetInput = Math.min(input.length, Math.round((offsetResult + 1) * sampleRateRatio));
      let accum = 0;
      let count = 0;

      for (let index = offsetInput; index < nextOffsetInput; index += 1) {
        accum += input[index];
        count += 1;
      }

      result[offsetResult] = count > 0 ? accum / count : 0;
      offsetResult += 1;
      offsetInput = nextOffsetInput;
    }

    return result;
  }

  async function ensureWorkletModule(context) {
    if (workletLoadedContexts.has(context)) {
      return;
    }

    await context.audioWorklet.addModule(WORKLET_MODULE_PATH);
    workletLoadedContexts.add(context);
  }

  function isLikelyCameraTrack(trackLabel) {
    const label = String(trackLabel || '').toLowerCase();
    return label.includes('camera') || label.includes('webcam');
  }

  function isMonitorDeviceLabel(label) {
    const normalized = String(label || '').toLowerCase();
    return (
      normalized.endsWith('.monitor') ||
      normalized.includes('monitor of') ||
      /\bmonitor\b/.test(normalized)
    );
  }

  /**
   * Linux host-audio: prefer PipeWire/Pulse monitor devices enumerated as audioinput.
   * echoCancellation must be false so loopback audio is not treated as local speech.
   */
  async function getLinuxMonitorStream() {
    if (!navigator?.mediaDevices?.enumerateDevices || !navigator?.mediaDevices?.getUserMedia) {
      return null;
    }

    const devices = await navigator.mediaDevices.enumerateDevices();
    const inputs = devices.filter((device) => device.kind === 'audioinput');
    const monitor = inputs.find((device) => isMonitorDeviceLabel(device.label));

    if (!monitor?.deviceId) {
      addMonitorLog(
        'info',
        'monitor-device-missing',
        'No PipeWire/Pulse monitor device found among audioinput devices',
        'system'
      );
      return null;
    }

    addMonitorLog(
      'info',
      'monitor-device-selected',
      `Using monitor device: ${monitor.label || monitor.deviceId}`,
      'system'
    );

    return navigator.mediaDevices.getUserMedia({
      audio: {
        deviceId: { exact: monitor.deviceId },
        channelCount: 1,
        echoCancellation: false,
        noiseSuppression: false,
        autoGainControl: false
      }
    });
  }

  async function getSystemAudioStream(sourceId) {
    if (!sourceId) {
      throw new Error('Desktop source id is required for desktop capturer loopback');
    }

    const mandatoryConstraints = {
      audio: {
        mandatory: {
          chromeMediaSource: 'desktop',
          chromeMediaSourceId: sourceId
        }
      },
      video: {
        mandatory: {
          chromeMediaSource: 'desktop',
          chromeMediaSourceId: sourceId
        }
      }
    };

    const flatConstraints = {
      audio: { chromeMediaSource: 'desktop', chromeMediaSourceId: sourceId },
      video: { chromeMediaSource: 'desktop', chromeMediaSourceId: sourceId }
    };

    try {
      return await navigator.mediaDevices.getUserMedia(mandatoryConstraints);
    } catch (_mandatoryError) {
      addMonitorLog(
        'info',
        'desktop-constraints-fallback',
        'Mandatory desktop constraints failed; trying flat syntax',
        'system'
      );
      return navigator.mediaDevices.getUserMedia(flatConstraints);
    }
  }

  function resetSourceSampleQueue(source) {
    const resolvedSource = normalizeSource(source);
    sourceSampleQueues[resolvedSource] = { chunks: [], length: 0 };
  }

  function appendSourceSamples(source, samples) {
    if (!samples || samples.length === 0) {
      return;
    }

    const resolvedSource = normalizeSource(source);
    sourceSampleQueues[resolvedSource].chunks.push(samples);
    sourceSampleQueues[resolvedSource].length += samples.length;
  }

  function pullSourceSamples(source, count) {
    const resolvedSource = normalizeSource(source);
    const queue = sourceSampleQueues[resolvedSource];
    const output = new Float32Array(count);
    let written = 0;

    while (written < count && queue.chunks.length > 0) {
      const first = queue.chunks[0];
      const take = Math.min(first.length, count - written);
      output.set(first.subarray(0, take), written);
      written += take;

      if (take === first.length) {
        queue.chunks.shift();
      } else {
        queue.chunks[0] = first.subarray(take);
      }

      queue.length -= take;
    }

    if (written === count) {
      return output;
    }

    return output.subarray(0, written);
  }

  function sendPcmFrame(source, floatSamples) {
    if (!floatSamples || floatSamples.length < minFrameSamples) {
      return;
    }

    const resolvedSource = normalizeSource(source);
    const pcm = convertToPCM16(floatSamples);
    sendAudioChunk(resolvedSource, pcm.buffer);
    audioChunkCounters[resolvedSource] += 1;

    if (audioChunkCounters[resolvedSource] % 50 === 0) {
      addMonitorLog('info', 'chunk-heartbeat', `Chunks sent: ${audioChunkCounters[resolvedSource]}`, resolvedSource, {
        chunks: audioChunkCounters[resolvedSource],
        frameSamples: floatSamples.length,
        sampleRate: targetSampleRate
      });
    }
  }

  function drainSourceSampleQueue(source, { flushPartial = false } = {}) {
    const resolvedSource = normalizeSource(source);
    const queue = sourceSampleQueues[resolvedSource];

    while (queue.length >= targetFrameSamples) {
      const frame = pullSourceSamples(resolvedSource, targetFrameSamples);
      sendPcmFrame(resolvedSource, frame);
    }

    if (flushPartial && queue.length >= minFrameSamples) {
      const tailFrame = pullSourceSamples(resolvedSource, queue.length);
      sendPcmFrame(resolvedSource, tailFrame);
    }
  }

  async function buildAudioProcessor(context, stream, source, activeCheck) {
    await ensureWorkletModule(context);

    const src = context.createMediaStreamSource(stream);
    const node = new AudioWorkletNode(context, 'pcm-capture-processor', {
      numberOfInputs: 1,
      numberOfOutputs: 1,
      outputChannelCount: [1],
      processorOptions: {
        targetSampleRate
      }
    });

    const silentGain = context.createGain();
    silentGain.gain.value = 0;

    node.port.onmessage = (event) => {
      if (!activeCheck()) {
        return;
      }

      try {
        const chunk = event.data instanceof Float32Array ? event.data : new Float32Array(event.data || []);
        const normalizedChunk = downsampleFloat32Buffer(chunk, context.sampleRate, targetSampleRate);
        appendSourceSamples(source, normalizedChunk);
        drainSourceSampleQueue(source);
      } catch (error) {
        addMonitorLog('error', 'audio-process-failed', error.message || 'Audio processing failed', source);
      }
    };

    src.connect(node);
    node.connect(silentGain);
    silentGain.connect(context.destination);

    return {
      disconnect: () => {
        try {
          node.port.onmessage = null;
        } catch (_) {
          // no-op
        }
        try {
          src.disconnect();
        } catch (_) {
          // no-op
        }
        try {
          node.disconnect();
        } catch (_) {
          // no-op
        }
        try {
          silentGain.disconnect();
        } catch (_) {
          // no-op
        }
      }
    };
  }

  function stopAudioResources(context, stream, processor) {
    try {
      processor?.disconnect();
    } catch (_) {
      // no-op
    }

    try {
      context?.close();
    } catch (_) {
      // no-op
    }

    stream?.getTracks().forEach((track) => track.stop());
  }

  function resetChunkCounter(source) {
    audioChunkCounters[normalizeSource(source)] = 0;
  }

  return {
    buildAudioProcessor,
    drainSourceSampleQueue,
    getLinuxMonitorStream,
    getLinuxMonitorAudioStream: getLinuxMonitorStream,
    getSystemAudioStream,
    getTargetSampleRate,
    isLikelyCameraTrack,
    isMonitorDeviceLabel,
    resetChunkCounter,
    resetSourceSampleQueue,
    setTargetSampleRate,
    stopAudioResources
  };
}
