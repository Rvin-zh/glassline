'use strict';

const PIPEWIRE_MONITOR_BACKEND = 'pipewire-monitor';

function registerSttIpc({
  ipcMain,
  sttService,
  pipewireMonitorCapture = null,
  platform = process.platform
}) {
  ipcMain.handle('start-voice-recognition', (_event, { source } = {}) => {
    const resolvedSource = source === 'system' ? 'system' : 'mic';
    console.log(`IPC: start-voice-recognition [${resolvedSource}]`);
    sttService.emitSttDebug({
      source: resolvedSource,
      event: 'ipc-start',
      message: 'Renderer requested source start'
    });

    const result = sttService.start(resolvedSource);
    if (result && result.success !== false) {
      return {
        ...result,
        sampleRate: result.sampleRate || sttService.getSampleRate?.() || undefined,
        sttProvider: sttService.getActiveProviderId?.() || undefined
      };
    }
    return result;
  });

  ipcMain.on('audio-chunk', (_event, payload = {}) => {
    sttService.handleAudioChunk(payload);
  });

  ipcMain.handle('stop-voice-recognition', (_event, { source } = {}) => {
    console.log(`IPC: stop-voice-recognition [${source}]`);
    return sttService.stop({ source });
  });

  ipcMain.handle('get-desktop-sources', async () => {
    return sttService.getDesktopSources();
  });

  ipcMain.handle('transcribe-audio', async (_event, base64Audio) => {
    console.log('IPC: transcribe-audio called, size:', base64Audio?.length || 0);
    return sttService.transcribeAudio(base64Audio);
  });

  ipcMain.handle('get-stt-config', () => {
    const providerId = sttService.getActiveProviderId?.() || 'assemblyai';
    return {
      sttProvider: providerId,
      sampleRate: sttService.getSampleRate?.() || 16000,
      realtime: providerId !== 'portkey-whisper'
    };
  });

  ipcMain.handle('start-pipewire-monitor-capture', async () => {
    const sampleRate = sttService.getSampleRate?.() || 16000;
    if (
      platform !== 'linux'
      || !pipewireMonitorCapture
      || typeof pipewireMonitorCapture.start !== 'function'
    ) {
      return {
        success: false,
        backend: PIPEWIRE_MONITOR_BACKEND,
        sampleRate,
        sourceConfigured: false,
        code: 'PIPEWIRE_MONITOR_UNAVAILABLE',
        error: 'Direct PipeWire/Pulse monitor capture is unavailable.'
      };
    }

    try {
      const result = await pipewireMonitorCapture.start(sampleRate);
      if (result?.success) {
        return {
          success: true,
          backend: PIPEWIRE_MONITOR_BACKEND,
          sampleRate: result.sampleRate || sampleRate,
          sourceConfigured: true
        };
      }
      return {
        success: false,
        backend: PIPEWIRE_MONITOR_BACKEND,
        sampleRate: result?.sampleRate || sampleRate,
        sourceConfigured: Boolean(result?.sourceConfigured),
        code: result?.code || 'PIPEWIRE_MONITOR_START_FAILED',
        error: result?.error || 'Direct PipeWire/Pulse monitor capture could not be started.'
      };
    } catch (_) {
      return {
        success: false,
        backend: PIPEWIRE_MONITOR_BACKEND,
        sampleRate,
        sourceConfigured: false,
        code: 'PIPEWIRE_MONITOR_START_FAILED',
        error: 'Direct PipeWire/Pulse monitor capture could not be started.'
      };
    }
  });

  ipcMain.handle('stop-pipewire-monitor-capture', async () => {
    if (
      !pipewireMonitorCapture
      || typeof pipewireMonitorCapture.stop !== 'function'
    ) {
      return {
        success: true,
        backend: PIPEWIRE_MONITOR_BACKEND
      };
    }

    try {
      const result = await pipewireMonitorCapture.stop();
      if (result?.success !== false) {
        return {
          success: true,
          backend: PIPEWIRE_MONITOR_BACKEND
        };
      }
      return {
        success: false,
        backend: PIPEWIRE_MONITOR_BACKEND,
        code: result?.code || 'PIPEWIRE_MONITOR_STOP_FAILED',
        error: result?.error || 'Direct PipeWire/Pulse monitor capture could not be stopped.'
      };
    } catch (_) {
      return {
        success: false,
        backend: PIPEWIRE_MONITOR_BACKEND,
        code: 'PIPEWIRE_MONITOR_STOP_FAILED',
        error: 'Direct PipeWire/Pulse monitor capture could not be stopped.'
      };
    }
  });
}

module.exports = {
  registerSttIpc,
  // Back-compat alias used by older call sites
  registerAssemblyAiIpc: registerSttIpc
};
