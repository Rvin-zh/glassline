import { formatCapturePermissionMessage } from './capture-permission-message.js';

const MAX_MONITOR_LOG_ENTRIES = 80;
const DEFAULT_CAPTURE_TIMEOUT_MS = 8000;

export function createTranscriptionManager({
    transcriptionSourceState,
    normalizeSourceRule,
    sourceLabelRule,
    audioPipeline,
    transcriptBufferManager,
    chatMessagesElement,
    transcriptionToggle,
    sourceSystemToggle,
    sourceMicToggle,
    monitorMasterState,
    monitorStatusSystem,
    monitorStatusMic,
    monitorLiveSystem,
    monitorLiveMic,
    monitorLogList,
    addChatMessage,
    showFeedback,
    isAutoScrollEnabled = () => true,
    isChatNearBottom = () => true,
    captureTimeoutMs = DEFAULT_CAPTURE_TIMEOUT_MS
}) {
    let micAudioContext = null;
    let micMediaStream = null;
    let micScriptProcessor = null;
    let isMicActive = false;

    let systemAudioContext = null;
    let systemMediaStream = null;
    let systemScriptProcessor = null;
    let isSystemActive = false;

    let micPartialText = '';
    let micPartialDiv = null;
    let systemPartialText = '';
    let systemPartialDiv = null;

    const selectedSources = transcriptionSourceState.selectedSources;
    const sourceStatuses = transcriptionSourceState.sourceStatuses;
    const monitorLogEntries = [];
    const monitorLastText = {
        system: 'No transcript yet',
        mic: 'No transcript yet'
    };
    const normalizedCaptureTimeoutMs = (() => {
        const parsed = Number.parseInt(String(captureTimeoutMs ?? ''), 10);
        return Number.isFinite(parsed) && parsed > 0
            ? parsed
            : DEFAULT_CAPTURE_TIMEOUT_MS;
    })();

    function normalizeSource(source) {
        return normalizeSourceRule(source);
    }

    function sourceLabel(source) {
        return sourceLabelRule(normalizeSource(source));
    }

    function isSourceActive(source) {
        return source === 'system' ? isSystemActive : isMicActive;
    }

    function setMicActive(active) {
        isMicActive = !!active;
        transcriptionSourceState.setSourceActive('mic', isMicActive);
    }

    function setSystemActive(active) {
        isSystemActive = !!active;
        transcriptionSourceState.setSourceActive('system', isSystemActive);
    }

    function isAnyTranscriptionActive() {
        return isSystemActive || isMicActive;
    }

    function isAnySourceConnecting() {
        return transcriptionSourceState.isAnySourceConnecting();
    }

    function setSourceStatus(source, status, liveText) {
        const resolvedSource = normalizeSource(source);
        transcriptionSourceState.setSourceStatus(resolvedSource, status);

        if (typeof liveText === 'string' && liveText.trim().length > 0) {
            monitorLastText[resolvedSource] = liveText.trim();
        }

        renderMonitorState();
    }

    function updateTranscriptionUI() {
        const anyActive = isAnyTranscriptionActive();
        const anyConnecting = !anyActive && isAnySourceConnecting();

        if (transcriptionToggle) {
            transcriptionToggle.classList.toggle('active', anyActive);
            transcriptionToggle.classList.toggle('listening', anyActive);
            transcriptionToggle.classList.toggle('connecting', anyConnecting);
        }

        if (sourceSystemToggle) {
            sourceSystemToggle.classList.toggle('selected', selectedSources.system);
            sourceSystemToggle.classList.toggle('running', isSystemActive);
        }

        if (sourceMicToggle) {
            sourceMicToggle.classList.toggle('selected', selectedSources.mic);
            sourceMicToggle.classList.toggle('running', isMicActive);
        }
    }

    function renderMonitorState() {
        updateTranscriptionUI();

        const statusMap = {
            off: 'Off',
            connecting: 'Connecting',
            listening: 'Listening',
            error: 'Error'
        };

        if (monitorStatusSystem) {
            monitorStatusSystem.className = `monitor-status-badge ${sourceStatuses.system}`;
            monitorStatusSystem.textContent = statusMap[sourceStatuses.system] || 'Off';
        }

        if (monitorStatusMic) {
            monitorStatusMic.className = `monitor-status-badge ${sourceStatuses.mic}`;
            monitorStatusMic.textContent = statusMap[sourceStatuses.mic] || 'Off';
        }

        if (monitorLiveSystem) {
            monitorLiveSystem.textContent = monitorLastText.system || 'No transcript yet';
        }

        if (monitorLiveMic) {
            monitorLiveMic.textContent = monitorLastText.mic || 'No transcript yet';
        }

        if (monitorMasterState) {
            monitorMasterState.classList.remove('active', 'connecting');
            if (isAnyTranscriptionActive()) {
                monitorMasterState.textContent = 'Running';
                monitorMasterState.classList.add('active');
            } else if (isAnySourceConnecting()) {
                monitorMasterState.textContent = 'Connecting';
                monitorMasterState.classList.add('connecting');
            } else {
                monitorMasterState.textContent = 'Idle';
            }
        }
    }

    function formatMonitorTime(timestamp = Date.now()) {
        return new Date(timestamp).toLocaleTimeString('en-US', {
            hour: '2-digit',
            minute: '2-digit',
            second: '2-digit'
        });
    }

    function safeJson(value) {
        try {
            return JSON.stringify(value);
        } catch (_) {
            return '';
        }
    }

    function addMonitorLog(level, event, message, source = null, meta = null, timestamp = Date.now()) {
        const entry = {
            level: level || 'info',
            event: event || 'event',
            message: message || '',
            source: source ? normalizeSource(source) : null,
            meta,
            timestamp
        };

        monitorLogEntries.push(entry);
        if (monitorLogEntries.length > MAX_MONITOR_LOG_ENTRIES) {
            monitorLogEntries.shift();
        }

        if (!monitorLogList) {
            return;
        }

        monitorLogList.innerHTML = '';
        const entriesToRender = [...monitorLogEntries].reverse();
        for (const item of entriesToRender) {
            const row = document.createElement('div');
            row.className = `monitor-log-entry ${item.level === 'error' ? 'error' : ''}`.trim();

            const sourcePrefix = item.source ? `${sourceLabel(item.source)} ` : '';
            const metaText = item.meta ? ` ${safeJson(item.meta)}` : '';
            row.textContent = `${formatMonitorTime(item.timestamp)} ${sourcePrefix}${item.event}: ${item.message}${metaText}`;
            monitorLogList.appendChild(row);
        }
    }

    function resetFinalTranscriptBuffer(source) {
        transcriptBufferManager.resetFinalTranscriptBuffer(source);
    }

    function flushFinalTranscript(source, reason = 'pause-timeout') {
        transcriptBufferManager.flushFinalTranscript(source, reason);
    }

    function queueFinalTranscript(source, text) {
        transcriptBufferManager.queueFinalTranscript(source, text);
    }

    function flushAllFinalTranscripts(reason = 'flush-all') {
        transcriptBufferManager.flushAllFinalTranscripts(reason);
    }

    function setSourceSelected(source, enabled) {
        const resolvedSource = normalizeSource(source);
        transcriptionSourceState.setSourceSelected(resolvedSource, enabled);
        addMonitorLog('info', 'source-toggle', `${sourceLabel(resolvedSource)} ${enabled ? 'enabled' : 'disabled'}`, resolvedSource);
        updateTranscriptionUI();

        if (isAnyTranscriptionActive() || sourceStatuses[resolvedSource] === 'connecting') {
            ensureSourceRunning(resolvedSource, !!enabled).catch((error) => {
                console.error(`Failed to apply live source toggle for ${resolvedSource}:`, error);
                addMonitorLog('error', 'source-toggle-failed', error.message, resolvedSource);
            });
        }
    }

    async function ensureSourceRunning(source, shouldRun) {
        const resolvedSource = normalizeSource(source);
        if (shouldRun) {
            if (resolvedSource === 'system') {
                await startSystemAudioRecording();
            } else {
                await startMicRecording();
            }
        } else if (resolvedSource === 'system') {
            await stopSystemAudioRecording();
        } else {
            await stopMicRecording();
        }
    }

    async function withCaptureTimeout(operation, {
        code,
        message,
        stopLateStream = false
    }) {
        let timeoutHandle = null;
        let timedOut = false;
        const operationPromise = Promise.resolve().then(operation);

        if (stopLateStream) {
            operationPromise.then((stream) => {
                if (timedOut && typeof stream?.getTracks === 'function') {
                    stream.getTracks().forEach((track) => {
                        try {
                            track.stop();
                        } catch (_) {}
                    });
                }
            }).catch(() => {});
        }

        try {
            return await Promise.race([
                operationPromise,
                new Promise((_, reject) => {
                    timeoutHandle = setTimeout(() => {
                        timedOut = true;
                        const error = new Error(message);
                        error.code = code;
                        reject(error);
                    }, normalizedCaptureTimeoutMs);
                })
            ]);
        } finally {
            clearTimeout(timeoutHandle);
        }
    }

    async function startSelectedSources() {
        if (!selectedSources.system && !selectedSources.mic) {
            const message = 'Select at least one source (Host or Mic) before starting transcription.';
            showFeedback(message, 'error');
            addMonitorLog('error', 'start-blocked', message);
            return;
        }

        addMonitorLog('info', 'master-start', 'Starting selected transcription sources');

        const starts = [];
        // Start mic first and keep both starts independent so a portal wait
        // cannot prevent local microphone transcription.
        if (selectedSources.mic) {
            starts.push(ensureSourceRunning('mic', true));
        }
        if (selectedSources.system) {
            starts.push(ensureSourceRunning('system', true));
        }

        await Promise.allSettled(starts);
    }

    async function stopAllSources() {
        addMonitorLog('info', 'master-stop', 'Stopping all active transcription sources');
        if (isSystemActive || sourceStatuses.system === 'connecting') {
            await stopSystemAudioRecording();
        }
        if (isMicActive || sourceStatuses.mic === 'connecting') {
            await stopMicRecording();
        }
    }

    async function toggleMasterTranscription() {
        if (isAnyTranscriptionActive() || isAnySourceConnecting()) {
            await stopAllSources();
        } else {
            await startSelectedSources();
        }
        updateTranscriptionUI();
    }

    function isLikelyCameraTrack(trackLabel) {
        return audioPipeline.isLikelyCameraTrack(trackLabel);
    }

    async function getSystemAudioStream(sourceId) {
        return audioPipeline.getSystemAudioStream(sourceId);
    }

    function resetSourceSampleQueue(source) {
        audioPipeline.resetSourceSampleQueue(source);
    }

    function drainSourceSampleQueue(source, { flushPartial = false } = {}) {
        audioPipeline.drainSourceSampleQueue(source, { flushPartial });
    }

    async function buildAudioProcessor(context, stream, source, activeCheck) {
        return audioPipeline.buildAudioProcessor(context, stream, source, activeCheck);
    }

    function stopAudioResources(ctx, stream, processor) {
        audioPipeline.stopAudioResources(ctx, stream, processor);
    }

    function canUseDirectPipeWireCapture() {
        if (typeof navigator === 'undefined') {
            return false;
        }

        const platformText = [
            navigator.userAgentData?.platform,
            navigator.platform,
            navigator.userAgent
        ].filter(Boolean).join(' ');

        return (
            /\blinux\b/i.test(platformText)
            && typeof window.electronAPI?.startPipeWireMonitorCapture === 'function'
            && typeof window.electronAPI?.stopPipeWireMonitorCapture === 'function'
        );
    }

    // The browser-monitor fallback (getLinuxMonitorAudioStream) enumerates a
    // PipeWire/Pulse monitor device via getUserMedia. It is only meaningful on
    // Linux; on macOS/Windows it would prompt for a non-existent monitor
    // device, so gate it on the renderer platform.
    function isLinuxRendererPlatform() {
        if (typeof window !== 'undefined' && window.electronAPI && typeof window.electronAPI.platform === 'string') {
            return window.electronAPI.platform === 'linux';
        }
        if (typeof navigator === 'undefined') {
            return false;
        }
        const platformText = [
            navigator.userAgentData?.platform,
            navigator.platform,
            navigator.userAgent
        ].filter(Boolean).join(' ');
        return /\blinux\b/i.test(platformText);
    }

    async function stopDirectPipeWireCapture() {
        if (!canUseDirectPipeWireCapture()) {
            return;
        }

        try {
            const result = await window.electronAPI.stopPipeWireMonitorCapture();
            if (result?.success === false) {
                addMonitorLog(
                    'error',
                    'direct-stop-failed',
                    result.error || 'Direct host audio capture could not be stopped.',
                    'system'
                );
            }
        } catch (_) {
            addMonitorLog(
                'error',
                'direct-stop-failed',
                'Direct host audio capture could not be stopped.',
                'system'
            );
        }
    }

    async function startMicRecording() {
        if (isMicActive || sourceStatuses.mic === 'connecting') return;
        setSourceStatus('mic', 'connecting', 'Connecting to mic...');
        addMonitorLog('info', 'start-request', 'Starting mic source', 'mic');
        resetFinalTranscriptBuffer('mic');

        try {
            const result = await window.electronAPI.startVoiceRecognition('mic');
            if (result && result.error) throw new Error(result.error);

            if (result?.sampleRate) {
                audioPipeline.setTargetSampleRate(result.sampleRate);
                addMonitorLog('info', 'sample-rate', `Target PCM sample rate: ${result.sampleRate} Hz`, 'mic');
            }

            micMediaStream = await withCaptureTimeout(
                () => navigator.mediaDevices.getUserMedia({
                    audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true }
                }),
                {
                    code: 'MIC_CAPTURE_TIMEOUT',
                    message: 'Microphone capture timed out. Check microphone permission and try again.',
                    stopLateStream: true
                }
            );
            micAudioContext = new AudioContext();
            await micAudioContext.resume();
            resetSourceSampleQueue('mic');
            micScriptProcessor = await buildAudioProcessor(micAudioContext, micMediaStream, 'mic', () => isMicActive);

            setMicActive(true);
            addChatMessage('system', 'Mic listening...');
            showFeedback('Mic on', 'success');
            addMonitorLog('info', 'source-active', 'Mic source active', 'mic');
        } catch (error) {
            console.error('Failed to start mic:', error);
            const platform = window.electronAPI?.platform || '';
            const message = formatCapturePermissionMessage(error, platform);
            showFeedback(`Mic failed: ${message}`, 'error');
            addMonitorLog('error', 'source-failed', error.message, 'mic');
            stopAudioResources(micAudioContext, micMediaStream, micScriptProcessor);
            micAudioContext = null;
            micMediaStream = null;
            micScriptProcessor = null;
            setMicActive(false);
            resetSourceSampleQueue('mic');
            setSourceStatus('mic', 'error', `Mic error: ${error.message}`);
            try {
                await window.electronAPI.stopVoiceRecognition('mic');
            } catch (_) {}
        }

        updateTranscriptionUI();
    }

    async function stopMicRecording() {
        if (!isMicActive && sourceStatuses.mic !== 'connecting') return;
        drainSourceSampleQueue('mic', { flushPartial: true });
        flushFinalTranscript('mic', 'stop-request');
        stopAudioResources(micAudioContext, micMediaStream, micScriptProcessor);
        micAudioContext = null;
        micMediaStream = null;
        micScriptProcessor = null;
        if (micPartialDiv) {
            micPartialDiv.remove();
            micPartialDiv = null;
        }
        micPartialText = '';
        try {
            await window.electronAPI.stopVoiceRecognition('mic');
        } catch (error) {
            addMonitorLog('error', 'stop-failed', error.message || 'Failed to stop mic source', 'mic');
        }
        setMicActive(false);
        resetSourceSampleQueue('mic');
        audioPipeline.resetChunkCounter('mic');
        setSourceStatus('mic', 'off', 'Mic stopped');
        addMonitorLog('info', 'source-stopped', 'Mic source stopped', 'mic');
        showFeedback('Mic off', 'info');
    }

    async function startSystemAudioRecording() {
        if (isSystemActive || sourceStatuses.system === 'connecting') return;
        setSourceStatus('system', 'connecting', 'Connecting to host audio...');
        addMonitorLog('info', 'start-request', 'Starting host audio source', 'system');
        resetFinalTranscriptBuffer('system');

        try {
            const result = await window.electronAPI.startVoiceRecognition('system');
            if (result && result.error) throw new Error(result.error);

            if (result?.sampleRate) {
                audioPipeline.setTargetSampleRate(result.sampleRate);
                addMonitorLog('info', 'sample-rate', `Target PCM sample rate: ${result.sampleRate} Hz`, 'system');
            }

            if (canUseDirectPipeWireCapture()) {
                let directResult = null;
                try {
                    directResult = await window.electronAPI.startPipeWireMonitorCapture();
                } catch (_) {
                    directResult = {
                        success: false,
                        error: 'Direct PipeWire/Pulse monitor capture could not be started.'
                    };
                }

                if (directResult?.success && directResult?.sourceConfigured !== false) {
                    if (directResult.sampleRate) {
                        audioPipeline.setTargetSampleRate(directResult.sampleRate);
                    }
                    setSystemActive(true);
                    setSourceStatus('system', 'listening', 'Listening to host audio...');
                    addChatMessage('system', 'Listening to host audio (pipewire-monitor)...');
                    showFeedback('System audio on', 'success');
                    addMonitorLog(
                        'info',
                        'source-active',
                        'Host source active via pipewire-monitor',
                        'system'
                    );
                    return;
                }

                addMonitorLog(
                    'info',
                    'direct-capture-fallback',
                    `${directResult?.error || 'Direct monitor capture unavailable.'} Trying browser monitor capture.`,
                    'system'
                );
            }

            let captureMode = null;
            if (isLinuxRendererPlatform() && typeof audioPipeline.getLinuxMonitorAudioStream === 'function') {
                try {
                    systemMediaStream = await withCaptureTimeout(
                        () => audioPipeline.getLinuxMonitorAudioStream(),
                        {
                            code: 'MONITOR_CAPTURE_TIMEOUT',
                            message: 'PipeWire/Pulse monitor capture timed out.',
                            stopLateStream: true
                        }
                    );
                } catch (monitorError) {
                    addMonitorLog(
                        'info',
                        'monitor-fallback',
                        `${monitorError.message} Trying desktop capture portal.`,
                        'system'
                    );
                }
            }

            if (systemMediaStream) {
                captureMode = 'browser-monitor';
            } else {
                const sources = await withCaptureTimeout(
                    () => window.electronAPI.getDesktopSources(),
                    {
                        code: 'DESKTOP_PORTAL_TIMEOUT',
                        message: 'Desktop capture portal timed out. Complete the screen selection prompt or configure a PipeWire/Pulse monitor device.'
                    }
                );
                if (!sources || sources.length === 0) {
                    throw new Error('No desktop sources found. Configure a PipeWire/Pulse monitor device or allow desktop capture in the portal.');
                }
                const sourceId = sources[0].id;
                addMonitorLog('info', 'desktop-source', `Using desktop source: ${sources[0].name || sourceId}`, 'system');
                systemMediaStream = await withCaptureTimeout(
                    () => getSystemAudioStream(sourceId),
                    {
                        code: 'DESKTOP_AUDIO_TIMEOUT',
                        message: 'Desktop audio capture timed out. Complete the portal selection prompt or configure a PipeWire/Pulse monitor device.',
                        stopLateStream: true
                    }
                );
                captureMode = 'desktop-capturer';
            }
            const videoTrack = systemMediaStream.getVideoTracks()[0];
            if (videoTrack && isLikelyCameraTrack(videoTrack.label)) {
                throw new Error(`Desktop capture fell back to camera source (${videoTrack.label || 'unknown'}).`);
            }

            systemMediaStream.getVideoTracks().forEach((track) => track.stop());

            if (!systemMediaStream.getAudioTracks().length) {
                throw new Error('Host audio stream has no audio tracks');
            }

            systemAudioContext = new AudioContext();
            await systemAudioContext.resume();
            resetSourceSampleQueue('system');
            systemScriptProcessor = await buildAudioProcessor(systemAudioContext, systemMediaStream, 'system', () => isSystemActive);

            setSystemActive(true);
            addChatMessage('system', `Listening to host audio (${captureMode})...`);
            showFeedback('System audio on', 'success');
            addMonitorLog('info', 'source-active', `Host source active via ${captureMode}`, 'system');
        } catch (error) {
            console.error('Failed to start system audio:', error);
            const platform = window.electronAPI?.platform || '';
            const permissionMessage = formatCapturePermissionMessage(error, platform);
            const gracefulMessage = selectedSources.mic
                ? `Host audio unavailable (${permissionMessage}). Continuing with mic only.`
                : `System audio failed: ${permissionMessage}`;
            showFeedback(gracefulMessage, selectedSources.mic ? 'info' : 'error');
            addMonitorLog('error', 'source-failed', error.message, 'system');
            stopAudioResources(systemAudioContext, systemMediaStream, systemScriptProcessor);
            systemAudioContext = null;
            systemMediaStream = null;
            systemScriptProcessor = null;
            await stopDirectPipeWireCapture();
            setSystemActive(false);
            resetSourceSampleQueue('system');
            setSourceStatus('system', 'error', `Host error: ${error.message}`);
            try {
                await window.electronAPI.stopVoiceRecognition('system');
            } catch (_) {}
        }

        updateTranscriptionUI();
    }

    async function stopSystemAudioRecording() {
        if (!isSystemActive && sourceStatuses.system !== 'connecting') return;
        drainSourceSampleQueue('system', { flushPartial: true });
        flushFinalTranscript('system', 'stop-request');
        await stopDirectPipeWireCapture();
        stopAudioResources(systemAudioContext, systemMediaStream, systemScriptProcessor);
        systemAudioContext = null;
        systemMediaStream = null;
        systemScriptProcessor = null;
        if (systemPartialDiv) {
            systemPartialDiv.remove();
            systemPartialDiv = null;
        }
        systemPartialText = '';
        try {
            await window.electronAPI.stopVoiceRecognition('system');
        } catch (error) {
            addMonitorLog('error', 'stop-failed', error.message || 'Failed to stop host source', 'system');
        }
        setSystemActive(false);
        resetSourceSampleQueue('system');
        audioPipeline.resetChunkCounter('system');
        setSourceStatus('system', 'off', 'Host source stopped');
        addMonitorLog('info', 'source-stopped', 'Host source stopped', 'system');
        showFeedback('System audio off', 'info');
    }

    function createPartialDiv(icon) {
        const div = document.createElement('div');
        div.className = 'chat-message voice-message partial';
        const ts = new Date().toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' });
        div.innerHTML = `
        <div class="message-header">
            <span class="message-icon">${icon}</span>
            <span class="message-time">${ts}</span>
            <span class="partial-indicator">Live</span>
        </div>
        <div class="message-content partial-text"></div>
    `;
        return div;
    }

    function handleVoskPartial(data) {
        const source = normalizeSource(data?.source);
        const text = data?.text;
        if (!text || text.trim().length === 0) return;
        if (!isSourceActive(source)) return;

        const trimmed = text.trim();
        const icon = source === 'system' ? '\u{1F50A}' : '\u{1F3A4}';
        monitorLastText[source] = `Live: ${trimmed}`;
        renderMonitorState();

        if (source === 'mic') {
            micPartialText = trimmed;
            if (!micPartialDiv) {
                micPartialDiv = createPartialDiv(icon);
                chatMessagesElement.appendChild(micPartialDiv);
            }
            micPartialDiv.querySelector('.message-content').textContent = trimmed;
        } else {
            systemPartialText = trimmed;
            if (!systemPartialDiv) {
                systemPartialDiv = createPartialDiv(icon);
                chatMessagesElement.appendChild(systemPartialDiv);
            }
            systemPartialDiv.querySelector('.message-content').textContent = trimmed;
        }
        if (isAutoScrollEnabled() && isChatNearBottom()) {
            chatMessagesElement.scrollTop = chatMessagesElement.scrollHeight;
        }
    }

    function handleVoskFinal(data) {
        const source = normalizeSource(data?.source);
        const text = data?.text;
        if (!text || text.trim().length === 0) return;

        const finalText = text.trim();
        monitorLastText[source] = `Final: ${finalText}`;
        renderMonitorState();
        addMonitorLog('info', 'final', 'Final transcript received', source, {
            chars: finalText.length
        });

        if (source === 'mic') {
            if (micPartialDiv) {
                micPartialDiv.remove();
                micPartialDiv = null;
            }
            micPartialText = '';
        } else {
            if (systemPartialDiv) {
                systemPartialDiv.remove();
                systemPartialDiv = null;
            }
            systemPartialText = '';
        }
        queueFinalTranscript(source, finalText);
    }

    function handleVoskStatus(data) {
        const source = normalizeSource(data?.source);
        const status = data?.status;
        const message = data?.message || '';
        console.log(`STT status [${source}]:`, status, message);

        if (status === 'loading') {
            setSourceStatus(source, 'connecting', `Connecting (${sourceLabel(source)})...`);
            showFeedback(`Connecting (${sourceLabel(source)})...`, 'info');
            addMonitorLog('info', 'status-loading', message || 'Connection requested', source);
        } else if (status === 'listening') {
            setSourceStatus(source, 'listening', `Listening (${sourceLabel(source)})...`);
            showFeedback(`Listening (${sourceLabel(source)})...`, 'success');
            addMonitorLog('info', 'status-listening', message || 'Source listening', source);
        } else if (status === 'stopped') {
            setSourceStatus(source, 'off', `${sourceLabel(source)} stopped`);
            showFeedback(`Stopped (${sourceLabel(source)})`, 'info');
            addMonitorLog('info', 'status-stopped', message || 'Source stopped', source);
        }
    }

    function handleVoskError(data) {
        const source = normalizeSource(data?.source);
        const error = data?.error || 'Unknown transcription error';
        console.error(`STT error [${source}]:`, error);
        showFeedback(`Error (${sourceLabel(source)}): ${error}`, 'error');
        addChatMessage('system', `Transcription error (${sourceLabel(source)}): ${error}`);
        addMonitorLog('error', 'status-error', error, source);
        flushFinalTranscript(source, 'status-error');

        if (source === 'system') {
            stopAudioResources(systemAudioContext, systemMediaStream, systemScriptProcessor);
            systemAudioContext = null;
            systemMediaStream = null;
            systemScriptProcessor = null;
            void stopDirectPipeWireCapture();
            if (systemPartialDiv) {
                systemPartialDiv.remove();
                systemPartialDiv = null;
            }
            systemPartialText = '';
            setSystemActive(false);
            resetSourceSampleQueue('system');
            resetFinalTranscriptBuffer('system');
        } else {
            stopAudioResources(micAudioContext, micMediaStream, micScriptProcessor);
            micAudioContext = null;
            micMediaStream = null;
            micScriptProcessor = null;
            if (micPartialDiv) {
                micPartialDiv.remove();
                micPartialDiv = null;
            }
            micPartialText = '';
            setMicActive(false);
            resetSourceSampleQueue('mic');
            resetFinalTranscriptBuffer('mic');
        }

        setSourceStatus(source, 'error', `Error: ${error}`);
        updateTranscriptionUI();
    }

    function handleVoskStopped(data) {
        const source = normalizeSource(data?.source);
        console.log(`STT stopped [${source}]`);
        flushFinalTranscript(source, 'stopped-event');
        if (source === 'system') {
            stopAudioResources(systemAudioContext, systemMediaStream, systemScriptProcessor);
            systemAudioContext = null;
            systemMediaStream = null;
            systemScriptProcessor = null;
            void stopDirectPipeWireCapture();
            if (systemPartialDiv) {
                systemPartialDiv.remove();
                systemPartialDiv = null;
            }
            systemPartialText = '';
            setSystemActive(false);
            resetSourceSampleQueue('system');
            resetFinalTranscriptBuffer('system');
        } else {
            stopAudioResources(micAudioContext, micMediaStream, micScriptProcessor);
            micAudioContext = null;
            micMediaStream = null;
            micScriptProcessor = null;
            if (micPartialDiv) {
                micPartialDiv.remove();
                micPartialDiv = null;
            }
            micPartialText = '';
            setMicActive(false);
            resetSourceSampleQueue('mic');
            resetFinalTranscriptBuffer('mic');
        }
        setSourceStatus(source, 'off', `${sourceLabel(source)} stopped`);
        addMonitorLog('info', 'stopped-event', 'Stop acknowledged by backend', source);
    }

    return {
        selectedSources,
        sourceStatuses,
        normalizeSource,
        sourceLabel,
        addMonitorLog,
        updateTranscriptionUI,
        renderMonitorState,
        setSourceSelected,
        toggleMasterTranscription,
        flushAllFinalTranscripts,
        handleVoskPartial,
        handleVoskFinal,
        handleVoskStatus,
        handleVoskError,
        handleVoskStopped
    };
}
