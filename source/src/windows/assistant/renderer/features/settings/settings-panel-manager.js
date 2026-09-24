function clamp(value, min, max) {
    return Math.min(Math.max(value, min), max);
}

const PROVIDER_LABELS = {
    gemini: 'Gemini',
    portkey: 'Portkey'
};

function escapeInterviewSessionHtml(value) {
    return String(value || '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

function formatInterviewSessionDate(value) {
    const timestamp = Date.parse(String(value || ''));
    return Number.isFinite(timestamp)
        ? new Date(timestamp).toISOString().slice(0, 10)
        : 'Unknown date';
}

export function buildPreviousInterviewsMarkup(sessions = []) {
    const entries = Array.isArray(sessions) ? sessions : [];
    if (entries.length === 0) {
        return '<div class="settings-helper-text previous-interviews-empty">No previous interviews</div>';
    }

    return entries.map((session) => {
        const id = escapeInterviewSessionHtml(session?.id || '');
        const title = escapeInterviewSessionHtml(session?.title || 'Interview');
        const archivedAt = escapeInterviewSessionHtml(session?.archivedAt || '');
        const date = escapeInterviewSessionHtml(
            formatInterviewSessionDate(session?.archivedAt)
        );
        const noteCount = Number.isSafeInteger(session?.noteCount) && session.noteCount >= 0
            ? session.noteCount
            : 0;
        const noteLabel = `${noteCount} ${noteCount === 1 ? 'note' : 'notes'}`;
        const checked = session?.selected === true ? ' checked' : '';

        return `
            <div class="previous-interview-item" data-interview-session-id="${id}">
                <label class="previous-interview-select">
                    <input type="checkbox" data-interview-session-select="${id}"${checked} />
                    <span class="previous-interview-copy">
                        <span class="previous-interview-title">${title}</span>
                        <span class="previous-interview-meta">
                            <time datetime="${archivedAt}">${date}</time> · ${noteLabel}
                        </span>
                    </span>
                </label>
                <button
                    type="button"
                    class="settings-input-toggle previous-interview-delete"
                    data-interview-session-delete="${id}"
                    aria-label="Delete ${title}"
                >Delete</button>
            </div>
        `;
    }).join('');
}

export function createSettingsPanelManager({
    settingsPanel,
    settingAiProvider,
    geminiSettingsGroup,
    portkeySettingsGroup,
    settingGeminiKey,
    toggleGeminiKeyVisibilityBtn,
    settingGeminiModel,
    settingPortkeyKey,
    togglePortkeyKeyVisibilityBtn,
    settingPortkeyProvider,
    settingPortkeyBaseUrl,
    settingPortkeyModel,
    settingProgrammingLanguage,
    settingAutoScreenInterval,
    settingAssemblyKey,
    toggleAssemblyKeyVisibilityBtn,
    settingAssemblyModel,
    settingWindowOpacity,
    settingWindowOpacityValue,
    settingHideFromScreenCapture,
    settingHideFromScreenCaptureHelp,
    settingWebSearchEnabled,
    settingWebSearchProvider,
    settingTavilyKey,
    toggleTavilyKeyVisibilityBtn,
    settingPromptCacheEnabled,
    settingRequestWebSearchEnabled,
    settingResumePaste,
    settingJobPaste,
    settingResumeEnabled,
    settingJobEnabled,
    pickResumeFileBtn,
    pickJobFileBtn,
    saveResumePasteBtn,
    saveJobPasteBtn,
    resumeDocStatus,
    jobDocStatus,
    durableNotesReviewList,
    previousInterviewsList,
    clearPreviousInterviewsBtn,
    clearSessionMemoryBtn,
    clearDocumentsBtn,
    clearDurableNotesBtn,
    settingsDiagnostics,
    refreshDiagnosticsBtn,
    applySettingsShortcutConfig,
    showFeedback,
    onSettingsSaved
}) {
    const settingSttProvider = document.getElementById('setting-stt-provider');
    const settingOpenaiKey = document.getElementById('setting-openai-key');
    const toggleOpenaiKeyVisibilityBtn = document.getElementById('toggle-openai-key-visibility');
    const settingOpenaiSttModel = document.getElementById('setting-openai-stt-model');
    const openaiSttSettingsGroup = document.getElementById('openai-stt-settings-group');
    const settingSttProviderHelp = document.getElementById('setting-stt-provider-help');
    const settingDefaultOutputFormat = document.getElementById('setting-default-output-format');
    const settingCustomOutputTemplate = document.getElementById('setting-custom-output-template');
    const settingCustomOutputStatus = document.getElementById('setting-custom-output-status');

    function normalizeWindowOpacityLevel(value) {
        const parsedValue = Number.parseInt(String(value ?? ''), 10);

        if (!Number.isFinite(parsedValue)) {
            return 10;
        }

        return clamp(parsedValue, 1, 10);
    }

    function updateWindowOpacityValueLabel(value) {
        if (!settingWindowOpacityValue) {
            return;
        }

        const opacityLevel = normalizeWindowOpacityLevel(value);
        settingWindowOpacityValue.textContent = `${opacityLevel}/10`;
    }

    async function refreshPlatformDiagnostics() {
        if (!settingsDiagnostics) {
            return;
        }
        if (!window.electronAPI?.getPlatformDiagnostics) {
            settingsDiagnostics.textContent = 'Platform diagnostics are unavailable.';
            return;
        }

        settingsDiagnostics.textContent = 'Loading diagnostics...';
        try {
            const result = await window.electronAPI.getPlatformDiagnostics();
            if (result?.error) {
                throw new Error(result.error);
            }
            settingsDiagnostics.textContent = JSON.stringify({
                capabilities: result?.capabilities || null,
                contentProtectionActive: result?.contentProtectionActive === true,
                capture: result?.capture || null,
                hostAudioCapture: result?.hostAudioCapture || null,
                backgroundMemory: result?.backgroundMemory
                    ? {
                        provider: result.backgroundMemory.provider || null,
                        model: result.backgroundMemory.model || null,
                        ready: result.backgroundMemory.ready === true,
                        lastSuccessAt: result.backgroundMemory.lastSuccessAt || null,
                        lastErrorCategory: result.backgroundMemory.lastErrorCategory || null,
                        lastErrorAt: result.backgroundMemory.lastErrorAt || null
                    }
                    : null,
                promptCache: result?.promptCache
                    ? {
                        enabled: result.promptCache.enabled === true,
                        provider: result.promptCache.provider === 'portkey'
                            ? 'portkey'
                            : 'gemini',
                        supported: result.promptCache.supported === true,
                        activeCount: Number(result.promptCache.activeCount || 0),
                        hasActiveName: result.promptCache.hasActiveName === true,
                        hitCount: Number(result.promptCache.hitCount || 0)
                    }
                    : null,
                shortcuts: result?.shortcuts || []
            }, null, 2);
        } catch (error) {
            settingsDiagnostics.textContent =
                `Diagnostics error: ${error?.message || 'unknown error'}`;
        }
    }

    function setApiKeyFieldVisibility(inputElement, toggleButton, providerName, visible) {
        if (!inputElement || !toggleButton) {
            return;
        }

        const shouldShow = Boolean(visible);
        inputElement.type = shouldShow ? 'text' : 'password';
        toggleButton.textContent = shouldShow ? 'Hide' : 'Show';
        toggleButton.setAttribute('aria-pressed', shouldShow ? 'true' : 'false');
        toggleButton.setAttribute(
            'aria-label',
            `${shouldShow ? 'Hide' : 'Show'} ${providerName} API key`
        );
    }

    function bindApiKeyVisibilityToggle(inputElement, toggleButton, providerName) {
        if (!inputElement || !toggleButton) {
            return;
        }

        setApiKeyFieldVisibility(inputElement, toggleButton, providerName, false);
        toggleButton.addEventListener('click', () => {
            const nextVisible = inputElement.type !== 'text';
            setApiKeyFieldVisibility(inputElement, toggleButton, providerName, nextVisible);
        });
    }

    function updateProviderVisibility(provider) {
        const isGemini = provider === 'gemini';
        const isPortkey = provider === 'portkey';

        if (geminiSettingsGroup) {
            geminiSettingsGroup.classList.toggle('hidden', !isGemini);
        }
        if (portkeySettingsGroup) {
            portkeySettingsGroup.classList.toggle('hidden', !isPortkey);
        }
    }

    function bindProviderToggle() {
        if (!settingAiProvider) {
            return;
        }

        settingAiProvider.addEventListener('change', () => {
            updateProviderVisibility(settingAiProvider.value);
        });
    }

    function populateAiProviderOptions(providers, selectedProvider) {
        if (!settingAiProvider) {
            return;
        }

        settingAiProvider.innerHTML = '';
        const configuredProviders = Array.isArray(providers) && providers.length > 0
            ? providers
            : ['gemini', 'portkey'];

        configuredProviders.forEach((providerName) => {
            const option = document.createElement('option');
            option.value = providerName;
            option.textContent = PROVIDER_LABELS[providerName] || providerName;
            settingAiProvider.appendChild(option);
        });

        settingAiProvider.value = configuredProviders.includes(selectedProvider)
            ? selectedProvider
            : configuredProviders[0];
    }

    function populateModelSelect(selectElement, models, selectedModel) {
        if (!selectElement) {
            return;
        }

        selectElement.innerHTML = '';

        const configuredModels = Array.isArray(models) ? models : [];
        if (configuredModels.length === 0) {
            throw new Error('Models are not configured.');
        }

        configuredModels.forEach((modelName) => {
            const option = document.createElement('option');
            option.value = modelName;
            option.textContent = modelName;
            selectElement.appendChild(option);
        });

        selectElement.value = configuredModels.includes(selectedModel)
            ? selectedModel
            : configuredModels[0];
    }

    function populateGeminiModelOptions(models, selectedModel) {
        populateModelSelect(settingGeminiModel, models, selectedModel);
    }

    function populatePortkeyModelOptions(models, selectedModel) {
        populateModelSelect(settingPortkeyModel, models, selectedModel);
    }

    function populateProgrammingLanguageOptions(languages, selectedLanguage) {
        if (!settingProgrammingLanguage) {
            return;
        }

        settingProgrammingLanguage.innerHTML = '';

        const configuredLanguages = Array.isArray(languages) ? languages : [];
        if (configuredLanguages.length === 0) {
            throw new Error('Programming languages are not configured.');
        }

        configuredLanguages.forEach((languageName) => {
            const option = document.createElement('option');
            option.value = languageName;
            option.textContent = languageName;
            settingProgrammingLanguage.appendChild(option);
        });

        settingProgrammingLanguage.value = configuredLanguages.includes(selectedLanguage)
            ? selectedLanguage
            : configuredLanguages[0];
    }

    function populateOutputFormatOptions(formats, labels, selectedFormat) {
        if (!settingDefaultOutputFormat) {
            return;
        }

        const configuredFormats = Array.isArray(formats) && formats.length > 0
            ? formats
            : ['quick', 'adaptive', 'detailed', 'custom'];
        const formatLabels = labels && typeof labels === 'object' ? labels : {};
        settingDefaultOutputFormat.innerHTML = '';
        configuredFormats.forEach((format) => {
            const option = document.createElement('option');
            option.value = format;
            option.textContent = formatLabels[format] ||
                `${format.slice(0, 1).toUpperCase()}${format.slice(1)}`;
            settingDefaultOutputFormat.appendChild(option);
        });
        settingDefaultOutputFormat.value = configuredFormats.includes(selectedFormat)
            ? selectedFormat
            : 'quick';
    }

    function updateCustomOutputStatus() {
        if (!settingCustomOutputStatus) {
            return;
        }
        const template = String(settingCustomOutputTemplate?.value || '');
        const length = template.length;
        const fallsBack =
            settingDefaultOutputFormat?.value === 'custom' &&
            template.trim().length === 0;
        settingCustomOutputStatus.textContent =
            `${length.toLocaleString()} / 4,000 characters${
                fallsBack ? ' · Empty Custom falls back to Quick' : ''
            }`;
    }

    function populateAutoScreenIntervalOptions(options, selectedInterval) {
        if (!settingAutoScreenInterval) {
            return;
        }

        const allowed = [5, 10, 15, 30];
        const configured = Array.isArray(options)
            ? options.map(Number).filter((value) => allowed.includes(value))
            : [];
        const intervals = configured.length > 0 ? [...new Set(configured)] : allowed;
        const selected = Number(selectedInterval);

        settingAutoScreenInterval.innerHTML = '';
        intervals.forEach((seconds) => {
            const option = document.createElement('option');
            option.value = String(seconds);
            option.textContent = `${seconds} seconds`;
            settingAutoScreenInterval.appendChild(option);
        });
        settingAutoScreenInterval.value = String(
            intervals.includes(selected) ? selected : 10
        );
    }

    function populateAssemblyAiSpeechModelOptions(models, selectedModel) {
        if (!settingAssemblyModel) {
            return;
        }

        settingAssemblyModel.innerHTML = '';

        const configuredModels = Array.isArray(models) ? models : [];
        if (configuredModels.length === 0) {
            throw new Error('AssemblyAI speech models are not configured.');
        }

        configuredModels.forEach((modelName) => {
            const option = document.createElement('option');
            option.value = modelName;
            option.textContent = modelName;
            settingAssemblyModel.appendChild(option);
        });

        settingAssemblyModel.value = configuredModels.includes(selectedModel)
            ? selectedModel
            : configuredModels[0];
    }

    function updateSttProviderVisibility(provider) {
        const resolved = String(provider || 'assemblyai').trim().toLowerCase();
        const showOpenai = resolved === 'openai';
        if (openaiSttSettingsGroup) {
            openaiSttSettingsGroup.classList.toggle('hidden', !showOpenai);
        }
        if (settingSttProviderHelp) {
            if (resolved === 'portkey-whisper') {
                settingSttProviderHelp.textContent =
                    'Portkey Whisper is non-realtime: audio is buffered in ~4s chunks and transcribed via whisper-1.';
            } else if (resolved === 'openai') {
                settingSttProviderHelp.textContent =
                    'OpenAI Realtime uses gpt-live-transcribe at 24 kHz with delay: minimal. It uses the direct OpenAI key when set, otherwise the Portkey @openai integration.';
            } else {
                settingSttProviderHelp.textContent =
                    'AssemblyAI streaming transcription at 16 kHz.';
            }
        }
    }

    function populateOpenAiSttModelOptions(models, selectedModel) {
        if (!settingOpenaiSttModel) {
            return;
        }

        const configuredModels = Array.isArray(models) && models.length > 0
            ? models
            : ['gpt-live-transcribe'];

        settingOpenaiSttModel.innerHTML = '';
        configuredModels.forEach((modelName) => {
            const option = document.createElement('option');
            option.value = modelName;
            option.textContent = modelName;
            settingOpenaiSttModel.appendChild(option);
        });

        settingOpenaiSttModel.value = configuredModels.includes(selectedModel)
            ? selectedModel
            : configuredModels[0];
    }

    async function openSettings() {
        if (!settingsPanel) {
            return;
        }

        try {
            const settings = await window.electronAPI.getSettings();
            if (settings && !settings.error) {
                applySettingsShortcutConfig?.(settings);

                const activeProvider = settings.aiProvider || 'gemini';
                populateAiProviderOptions(settings.aiProviders, activeProvider);
                updateProviderVisibility(activeProvider);

                if (settingGeminiKey) settingGeminiKey.value = settings.geminiApiKey || '';
                populateGeminiModelOptions(settings.geminiModels, settings.geminiModel || settings.defaultGeminiModel);

                if (settingPortkeyKey) settingPortkeyKey.value = settings.portkeyApiKey || '';
                if (settingPortkeyProvider) {
                    settingPortkeyProvider.value = settings.portkeyProvider || settings.defaultPortkeyProvider || '@vertex';
                }
                if (settingPortkeyBaseUrl) settingPortkeyBaseUrl.value = settings.portkeyBaseUrl || '';
                populatePortkeyModelOptions(settings.geminiModels, settings.geminiModel || settings.defaultGeminiModel);

                populateProgrammingLanguageOptions(
                    settings.programmingLanguages,
                    settings.programmingLanguage || settings.defaultProgrammingLanguage
                );
                populateOutputFormatOptions(
                    settings.outputFormats,
                    settings.outputFormatLabels,
                    settings.defaultOutputFormat
                );
                if (settingCustomOutputTemplate) {
                    settingCustomOutputTemplate.value = settings.customOutputTemplate || '';
                }
                updateCustomOutputStatus();
                populateAutoScreenIntervalOptions(
                    settings.autoScreenIntervalOptions,
                    settings.autoScreenIntervalSeconds
                );
                if (settingAssemblyKey) settingAssemblyKey.value = settings.assemblyAiApiKey || '';
                populateAssemblyAiSpeechModelOptions(
                    settings.assemblyAiSpeechModels,
                    settings.assemblyAiSpeechModel || settings.defaultAssemblyAiSpeechModel
                );
                if (settingSttProvider) {
                    const providers = Array.isArray(settings.sttProviders) && settings.sttProviders.length > 0
                        ? settings.sttProviders
                        : ['assemblyai', 'openai', 'portkey-whisper'];
                    settingSttProvider.innerHTML = '';
                    providers.forEach((providerId) => {
                        const option = document.createElement('option');
                        option.value = providerId;
                        if (providerId === 'portkey-whisper') {
                            option.textContent = 'Portkey Whisper (non-realtime)';
                        } else if (providerId === 'openai') {
                            option.textContent = 'OpenAI Realtime';
                        } else {
                            option.textContent = 'AssemblyAI';
                        }
                        settingSttProvider.appendChild(option);
                    });
                    settingSttProvider.value = settings.sttProvider || settings.defaultSttProvider || 'assemblyai';
                    updateSttProviderVisibility(settingSttProvider.value);
                }
                if (settingOpenaiKey) settingOpenaiKey.value = settings.openaiApiKey || '';
                populateOpenAiSttModelOptions(
                    settings.openAiSttModels,
                    settings.openaiSttModel || settings.defaultOpenAiSttModel || 'gpt-live-transcribe'
                );
                if (settingWindowOpacity) {
                    settingWindowOpacity.value = normalizeWindowOpacityLevel(settings.windowOpacityLevel);
                }
                updateWindowOpacityValueLabel(settings.windowOpacityLevel);

                const hideOverlayControl = settings.hideOverlayControl || {
                    enabled: settings.contentProtectionSupported === true,
                    checked: settings.hideFromScreenCapture === true,
                    helperText: ''
                };
                if (settingHideFromScreenCapture) {
                    settingHideFromScreenCapture.value = hideOverlayControl.checked ? 'true' : 'false';
                    settingHideFromScreenCapture.disabled = hideOverlayControl.enabled !== true;
                }
                if (settingHideFromScreenCaptureHelp) {
                    settingHideFromScreenCaptureHelp.textContent = hideOverlayControl.helperText || '';
                }

                if (settingWebSearchEnabled) {
                    settingWebSearchEnabled.value = settings.webSearchEnabled === true ? 'true' : 'false';
                }
                if (settingRequestWebSearchEnabled) {
                    settingRequestWebSearchEnabled.value = settings.requestWebSearchEnabled === true ? 'true' : 'false';
                }
                if (settingWebSearchProvider) {
                    settingWebSearchProvider.value = settings.webSearchProvider === 'tavily'
                        ? 'tavily'
                        : 'gemini-grounding';
                }
                if (settingTavilyKey) settingTavilyKey.value = settings.tavilyApiKey || '';
                if (settingPromptCacheEnabled) {
                    settingPromptCacheEnabled.value = settings.promptCacheEnabled === false ? 'false' : 'true';
                }
                updateDocumentStatus(settings.documents);
                if (settingResumeEnabled) {
                    settingResumeEnabled.checked = settings.documents?.resume?.enabled !== false;
                }
                if (settingJobEnabled) {
                    settingJobEnabled.checked = settings.documents?.jobDescription?.enabled !== false;
                }
                await refreshDurableNotesReview();
                await refreshPreviousInterviews();
                await refreshPlatformDiagnostics();
            }
        } catch (error) {
            console.error('Failed to load settings:', error);
        }

        setApiKeyFieldVisibility(settingGeminiKey, toggleGeminiKeyVisibilityBtn, 'Gemini', false);
        setApiKeyFieldVisibility(settingPortkeyKey, togglePortkeyKeyVisibilityBtn, 'Portkey', false);
        setApiKeyFieldVisibility(settingAssemblyKey, toggleAssemblyKeyVisibilityBtn, 'AssemblyAI', false);
        setApiKeyFieldVisibility(settingOpenaiKey, toggleOpenaiKeyVisibilityBtn, 'OpenAI', false);
        setApiKeyFieldVisibility(settingTavilyKey, toggleTavilyKeyVisibilityBtn, 'Tavily', false);

        settingsPanel.classList.remove('hidden');
    }

    function toDocumentStatusView(documents) {
        if (!documents) {
            return null;
        }

        const toEntry = (entry) => {
            if (!entry) {
                return null;
            }
            const text = typeof entry.text === 'string' ? entry.text : '';
            const hasText = entry.hasText === true || Boolean(text);
            const charCount = typeof entry.charCount === 'number'
                ? entry.charCount
                : text.length;
            return {
                hasText,
                charCount,
                enabled: entry.enabled !== false,
                source: entry.source || null,
                error: typeof entry.error === 'string' ? entry.error : null
            };
        };

        return {
            resume: toEntry(documents.resume),
            jobDescription: toEntry(documents.jobDescription)
        };
    }

    function formatDocumentStatus(label, entry, emptyMessage) {
        if (entry?.error) {
            return `${label} error: ${entry.error}`;
        }
        if (!entry?.hasText) {
            return emptyMessage;
        }

        const name = entry.source?.name ? ` from ${entry.source.name}` : '';
        const chars = Number.isFinite(entry.charCount) && entry.charCount > 0
            ? ` · ${entry.charCount.toLocaleString()} chars`
            : '';
        const enabled = entry.enabled === false ? 'disabled' : 'enabled';
        return `${label} stored${name}${chars} (${enabled}).`;
    }

    function updateDocumentStatus(documents, errorKind = null, errorMessage = null) {
        if (!errorKind || documents) {
            const view = toDocumentStatusView(documents) || {
                resume: { hasText: false },
                jobDescription: { hasText: false }
            };
            if (resumeDocStatus) {
                resumeDocStatus.textContent = formatDocumentStatus(
                    'Resume',
                    view.resume,
                    'No resume stored.'
                );
            }
            if (jobDocStatus) {
                jobDocStatus.textContent = formatDocumentStatus(
                    'Job description',
                    view.jobDescription,
                    'No job description stored.'
                );
            }
        }

        if (errorKind && errorMessage) {
            const label = errorKind === 'resume' ? 'Resume' : 'Job description';
            const target = errorKind === 'resume' ? resumeDocStatus : jobDocStatus;
            if (target) {
                target.textContent = `${label} error: ${errorMessage}`;
            }
        }
    }

    function escapeHtml(value) {
        return String(value || '')
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&#39;');
    }

    function renderDurableNotesReview(queue = []) {
        if (!durableNotesReviewList) {
            return;
        }

        const notes = Array.isArray(queue) ? queue : [];
        if (notes.length === 0) {
            durableNotesReviewList.innerHTML = '<div class="settings-helper-text">No pending notes.</div>';
            return;
        }

        durableNotesReviewList.innerHTML = notes.map((note) => {
            const id = escapeHtml(note.id || '');
            const text = escapeHtml(note.text || '');
            return `
                <div class="settings-review-item" data-note-id="${id}">
                    <div class="settings-review-item-text">${text}</div>
                    <div class="settings-review-item-actions">
                        <button type="button" class="settings-input-toggle" data-review-action="approve" data-note-id="${id}">Approve</button>
                        <button type="button" class="settings-input-toggle" data-review-action="reject" data-note-id="${id}">Reject</button>
                    </div>
                </div>
            `;
        }).join('');
    }

    async function refreshDurableNotesReview() {
        if (!window.electronAPI?.memoryGetReviewQueue) {
            renderDurableNotesReview([]);
            return;
        }

        try {
            const result = await window.electronAPI.memoryGetReviewQueue();
            if (result?.success === false) {
                if (durableNotesReviewList) {
                    durableNotesReviewList.innerHTML =
                        `<div class="settings-helper-text">Could not load review queue${result.error ? `: ${escapeHtml(result.error)}` : ''}.</div>`;
                }
                return;
            }
            renderDurableNotesReview(result?.queue || []);
        } catch (error) {
            console.error('Failed to load durable notes review queue:', error);
            if (durableNotesReviewList) {
                durableNotesReviewList.innerHTML =
                    '<div class="settings-helper-text">Could not load review queue.</div>';
            }
        }
    }

    function renderPreviousInterviews(sessions = []) {
        const entries = Array.isArray(sessions) ? sessions : [];
        if (previousInterviewsList) {
            previousInterviewsList.innerHTML = buildPreviousInterviewsMarkup(entries);
        }
        if (clearPreviousInterviewsBtn) {
            clearPreviousInterviewsBtn.disabled = entries.length === 0;
        }
    }

    async function refreshPreviousInterviews() {
        if (!window.electronAPI?.interviewSessionsList) {
            renderPreviousInterviews([]);
            return;
        }

        try {
            const result = await window.electronAPI.interviewSessionsList();
            if (result?.success === false) {
                throw new Error(result.error || 'Could not load previous interviews');
            }
            renderPreviousInterviews(result?.sessions || []);
        } catch (error) {
            console.error('Failed to load previous interviews:', error);
            if (previousInterviewsList) {
                previousInterviewsList.innerHTML =
                    '<div class="settings-helper-text previous-interviews-empty">Could not load previous interviews.</div>';
            }
            if (clearPreviousInterviewsBtn) {
                clearPreviousInterviewsBtn.disabled = true;
            }
        }
    }

    function selectedPreviousInterviewIds() {
        if (!previousInterviewsList) {
            return [];
        }
        return Array.from(
            previousInterviewsList.querySelectorAll('[data-interview-session-select]')
        )
            .filter((checkbox) => checkbox.checked === true)
            .map((checkbox) => checkbox.getAttribute('data-interview-session-select'))
            .filter(Boolean);
    }

    async function updatePreviousInterviewSelection() {
        if (!window.electronAPI?.interviewSessionsSetSelected) {
            showFeedback?.('Previous interview selection is unavailable', 'error');
            await refreshPreviousInterviews();
            return;
        }

        const result = await window.electronAPI.interviewSessionsSetSelected(
            selectedPreviousInterviewIds()
        );
        if (result?.success) {
            renderPreviousInterviews(result.sessions || []);
            showFeedback?.('Previous interview context updated', 'success');
            return;
        }

        showFeedback?.(result?.error || 'Failed to update previous interviews', 'error');
        await refreshPreviousInterviews();
    }

    async function deletePreviousInterview(id) {
        if (!window.electronAPI?.interviewSessionsDelete) {
            showFeedback?.('Previous interview deletion is unavailable', 'error');
            return;
        }

        const result = await window.electronAPI.interviewSessionsDelete(id);
        if (result?.success) {
            renderPreviousInterviews(result.sessions || []);
            showFeedback?.('Previous interview deleted', 'success');
            return;
        }

        showFeedback?.(result?.error || 'Failed to delete previous interview', 'error');
        await refreshPreviousInterviews();
    }

    async function clearPreviousInterviews() {
        if (!window.electronAPI?.interviewSessionsClear) {
            showFeedback?.('Previous interview clearing is unavailable', 'error');
            return;
        }

        const result = await window.electronAPI.interviewSessionsClear();
        if (result?.success) {
            renderPreviousInterviews([]);
            showFeedback?.('Previous interviews cleared', 'success');
            return;
        }

        showFeedback?.(result?.error || 'Failed to clear previous interviews', 'error');
        await refreshPreviousInterviews();
    }

    async function reviewDurableNote(action, noteId) {
        if (!window.electronAPI?.memoryReviewNote) {
            showFeedback?.('Durable note review is unavailable', 'error');
            return;
        }

        const result = await window.electronAPI.memoryReviewNote({
            action,
            id: noteId
        });

        if (result?.success) {
            showFeedback?.(
                action === 'approve' ? 'Durable note approved' : 'Durable note rejected',
                'success'
            );
            await refreshDurableNotesReview();
        } else {
            showFeedback?.(result?.error || 'Failed to review note', 'error');
            await refreshDurableNotesReview();
        }
    }

    function closeSettings() {
        if (settingsPanel) {
            settingsPanel.classList.add('hidden');
        }

        setApiKeyFieldVisibility(settingGeminiKey, toggleGeminiKeyVisibilityBtn, 'Gemini', false);
        setApiKeyFieldVisibility(settingPortkeyKey, togglePortkeyKeyVisibilityBtn, 'Portkey', false);
        setApiKeyFieldVisibility(settingAssemblyKey, toggleAssemblyKeyVisibilityBtn, 'AssemblyAI', false);
        setApiKeyFieldVisibility(settingOpenaiKey, toggleOpenaiKeyVisibilityBtn, 'OpenAI', false);
        setApiKeyFieldVisibility(settingTavilyKey, toggleTavilyKeyVisibilityBtn, 'Tavily', false);
    }

    async function saveSettings() {
        try {
            const aiProvider = settingAiProvider ? settingAiProvider.value : 'gemini';

            if (aiProvider === 'gemini') {
                if (!settingGeminiModel || settingGeminiModel.options.length === 0) {
                    throw new Error('Gemini models are not configured.');
                }
            }

            if (aiProvider === 'portkey') {
                if (!settingPortkeyModel || settingPortkeyModel.options.length === 0) {
                    throw new Error('Portkey models are not configured.');
                }
            }

            if (!settingProgrammingLanguage || settingProgrammingLanguage.options.length === 0) {
                throw new Error('Programming languages are not configured.');
            }

            if (!settingAssemblyModel || settingAssemblyModel.options.length === 0) {
                throw new Error('AssemblyAI speech models are not configured.');
            }

            const geminiModelValue = aiProvider === 'portkey'
                ? (settingPortkeyModel ? settingPortkeyModel.value : '')
                : (settingGeminiModel ? settingGeminiModel.value : '');

            const settings = {
                aiProvider,
                geminiApiKey: settingGeminiKey ? settingGeminiKey.value.trim() : '',
                assemblyAiApiKey: settingAssemblyKey ? settingAssemblyKey.value.trim() : '',
                geminiModel: geminiModelValue,
                portkeyApiKey: settingPortkeyKey ? settingPortkeyKey.value.trim() : '',
                portkeyProvider: settingPortkeyProvider ? settingPortkeyProvider.value.trim() : '@vertex',
                portkeyBaseUrl: settingPortkeyBaseUrl ? settingPortkeyBaseUrl.value.trim() : '',
                programmingLanguage: settingProgrammingLanguage.value,
                defaultOutputFormat: settingDefaultOutputFormat?.value || 'quick',
                customOutputTemplate: settingCustomOutputTemplate?.value || '',
                assemblyAiSpeechModel: settingAssemblyModel.value,
                sttProvider: settingSttProvider ? settingSttProvider.value : 'assemblyai',
                openaiApiKey: settingOpenaiKey ? settingOpenaiKey.value.trim() : '',
                openaiSttModel: settingOpenaiSttModel ? settingOpenaiSttModel.value : 'gpt-live-transcribe',
                windowOpacityLevel: normalizeWindowOpacityLevel(settingWindowOpacity?.value),
                hideFromScreenCapture: settingHideFromScreenCapture && !settingHideFromScreenCapture.disabled
                    ? settingHideFromScreenCapture.value === 'true'
                    : undefined,
                webSearchEnabled: settingWebSearchEnabled?.value === 'true',
                requestWebSearchEnabled: settingRequestWebSearchEnabled?.value === 'true',
                webSearchProvider: settingWebSearchProvider?.value === 'tavily' ? 'tavily' : 'gemini-grounding',
                tavilyApiKey: settingTavilyKey ? settingTavilyKey.value.trim() : '',
                promptCacheEnabled: settingPromptCacheEnabled?.value !== 'false',
                autoScreenIntervalSeconds: Number(settingAutoScreenInterval?.value || 10)
            };

            const result = await window.electronAPI.saveSettings(settings);

            if (result.success) {
                showFeedback?.('Settings saved. Latest AI settings are active now; voice model applies next session.', 'success');
                const appliedSettings = {
                    ...settings,
                    ...(result.settings || {}),
                    isAiReady: result.isAiReady
                };
                onSettingsSaved?.(appliedSettings);
                closeSettings();
                return { success: true, settings: appliedSettings };
            } else {
                showFeedback?.(`Failed to save: ${result.error}`, 'error');
                return { success: false, error: result.error || 'Failed to save settings' };
            }
        } catch (error) {
            console.error('Failed to save settings:', error);
            showFeedback?.('Failed to save settings', 'error');
            return { success: false, error: error.message || 'Failed to save settings' };
        }
    }

    async function savePastedDocument(kind) {
        const text = kind === 'resume'
            ? (settingResumePaste?.value || '')
            : (settingJobPaste?.value || '');
        const enabled = kind === 'resume'
            ? settingResumeEnabled?.checked !== false
            : settingJobEnabled?.checked !== false;

        if (!window.electronAPI?.documentsIngestPaste) {
            showFeedback?.('Document paste is unavailable', 'error');
            return;
        }

        const result = await window.electronAPI.documentsIngestPaste({
            kind,
            text,
            enabled
        });

        if (result?.success) {
            showFeedback?.(kind === 'resume' ? 'Resume saved' : 'Job description saved', 'success');
            updateDocumentStatus(result.documents || null);
        } else {
            showFeedback?.(result?.error || 'Failed to save document', 'error');
            updateDocumentStatus(null, kind, result?.error || 'Failed to save document');
        }
    }

    async function pickAndIngestDocument(kind) {
        if (!window.electronAPI?.documentsPickFile || !window.electronAPI?.documentsIngestFile) {
            showFeedback?.('Document file picker is unavailable', 'error');
            return;
        }

        const pickResult = await window.electronAPI.documentsPickFile();
        if (!pickResult?.success) {
            showFeedback?.(pickResult?.error || 'Failed to open file picker', 'error');
            updateDocumentStatus(null, kind, pickResult?.error || 'Failed to open file picker');
            return;
        }
        if (pickResult.canceled || !pickResult.filePath) {
            return;
        }

        const enabled = kind === 'resume'
            ? settingResumeEnabled?.checked !== false
            : settingJobEnabled?.checked !== false;

        const result = await window.electronAPI.documentsIngestFile({
            kind,
            filePath: pickResult.filePath,
            enabled
        });

        if (result?.success) {
            showFeedback?.(kind === 'resume' ? 'Resume loaded from file' : 'Job description loaded from file', 'success');
            updateDocumentStatus(result.documents || null);
        } else {
            showFeedback?.(result?.error || 'Failed to load document', 'error');
            updateDocumentStatus(null, kind, result?.error || 'Failed to load document');
        }
    }

    async function clearScoped(scope) {
        if (!window.electronAPI?.clearScopedData) {
            showFeedback?.('Clear action unavailable', 'error');
            return;
        }
        const result = await window.electronAPI.clearScopedData({ scope });
        if (result?.success) {
            showFeedback?.(`Cleared ${scope}`, 'success');
            if (scope === 'documents') {
                updateDocumentStatus({
                    resume: { hasText: false },
                    jobDescription: { hasText: false }
                });
            }
            if (scope === 'durable-notes' || scope === 'session-memory') {
                await refreshDurableNotesReview();
            }
        } else {
            showFeedback?.(result?.error || `Failed to clear ${scope}`, 'error');
        }
    }

    function bindDocumentActions() {
        pickResumeFileBtn?.addEventListener('click', () => {
            pickAndIngestDocument('resume');
        });
        pickJobFileBtn?.addEventListener('click', () => {
            pickAndIngestDocument('jobDescription');
        });
        saveResumePasteBtn?.addEventListener('click', () => {
            savePastedDocument('resume');
        });
        saveJobPasteBtn?.addEventListener('click', () => {
            savePastedDocument('jobDescription');
        });
        clearSessionMemoryBtn?.addEventListener('click', () => {
            clearScoped('session-memory');
        });
        clearDocumentsBtn?.addEventListener('click', () => {
            clearScoped('documents');
        });
        clearDurableNotesBtn?.addEventListener('click', () => {
            clearScoped('durable-notes');
        });
        durableNotesReviewList?.addEventListener('click', (event) => {
            const target = event.target;
            if (!(target instanceof HTMLElement)) {
                return;
            }
            const action = target.getAttribute('data-review-action');
            const noteId = target.getAttribute('data-note-id');
            if (!action || !noteId) {
                return;
            }
            reviewDurableNote(action, noteId);
        });
        previousInterviewsList?.addEventListener('change', (event) => {
            const target = event.target;
            if (!target?.hasAttribute?.('data-interview-session-select')) {
                return;
            }
            updatePreviousInterviewSelection();
        });
        previousInterviewsList?.addEventListener('click', (event) => {
            const target = event.target;
            const id = target?.getAttribute?.('data-interview-session-delete');
            if (!id) {
                return;
            }
            deletePreviousInterview(id);
        });
        clearPreviousInterviewsBtn?.addEventListener('click', () => {
            clearPreviousInterviews();
        });
        settingResumeEnabled?.addEventListener('change', async () => {
            if (!window.electronAPI?.documentsSetEnabled) {
                return;
            }
            const result = await window.electronAPI.documentsSetEnabled({
                kind: 'resume',
                enabled: settingResumeEnabled.checked
            });
            if (result?.success) {
                updateDocumentStatus(result.documents || null);
            } else if (result?.error) {
                showFeedback?.(result.error, 'error');
                settingResumeEnabled.checked = !settingResumeEnabled.checked;
            }
        });
        settingJobEnabled?.addEventListener('change', async () => {
            if (!window.electronAPI?.documentsSetEnabled) {
                return;
            }
            const result = await window.electronAPI.documentsSetEnabled({
                kind: 'jobDescription',
                enabled: settingJobEnabled.checked
            });
            if (result?.success) {
                updateDocumentStatus(result.documents || null);
            } else if (result?.error) {
                showFeedback?.(result.error, 'error');
                settingJobEnabled.checked = !settingJobEnabled.checked;
            }
        });
    }

    bindApiKeyVisibilityToggle(settingGeminiKey, toggleGeminiKeyVisibilityBtn, 'Gemini');
    bindApiKeyVisibilityToggle(settingPortkeyKey, togglePortkeyKeyVisibilityBtn, 'Portkey');
    bindApiKeyVisibilityToggle(settingAssemblyKey, toggleAssemblyKeyVisibilityBtn, 'AssemblyAI');
    bindApiKeyVisibilityToggle(settingOpenaiKey, toggleOpenaiKeyVisibilityBtn, 'OpenAI');
    bindApiKeyVisibilityToggle(settingTavilyKey, toggleTavilyKeyVisibilityBtn, 'Tavily');
    bindProviderToggle();
    bindDocumentActions();
    settingDefaultOutputFormat?.addEventListener('change', updateCustomOutputStatus);
    settingCustomOutputTemplate?.addEventListener('input', updateCustomOutputStatus);
    refreshDiagnosticsBtn?.addEventListener('click', refreshPlatformDiagnostics);
    if (window.electronAPI?.onMemoryReviewQueueUpdated) {
        window.electronAPI.onMemoryReviewQueueUpdated((payload) => {
            renderDurableNotesReview(payload?.queue || []);
        });
    }
    if (settingSttProvider) {
        settingSttProvider.addEventListener('change', () => {
            updateSttProviderVisibility(settingSttProvider.value);
        });
        updateSttProviderVisibility(settingSttProvider.value || 'assemblyai');
    }

    return {
        normalizeWindowOpacityLevel,
        updateWindowOpacityValueLabel,
        openSettings,
        closeSettings,
        saveSettings,
        refreshPreviousInterviews
    };
}
