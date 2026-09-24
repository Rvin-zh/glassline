const OUTPUT_FORMATS = Object.freeze(['quick', 'adaptive', 'detailed', 'custom']);
const OUTPUT_FORMAT_LABELS = Object.freeze({
    quick: 'Quick',
    adaptive: 'Adaptive',
    detailed: 'Detailed',
    custom: 'Custom'
});

function sanitizeOutputFormat(value) {
    const normalized = typeof value === 'string'
        ? value.trim().toLowerCase()
        : '';
    return OUTPUT_FORMATS.includes(normalized) ? normalized : 'quick';
}

export function createOutputFormatState({ toolbarSelect } = {}) {
    let defaultOutputFormat = 'quick';
    let activeOutputFormat = 'quick';

    function syncToolbar() {
        if (!toolbarSelect) {
            return;
        }
        toolbarSelect.value = activeOutputFormat;
        toolbarSelect.title =
            `Current interview output format: ${OUTPUT_FORMAT_LABELS[activeOutputFormat]}`;
    }

    function initializeFromSettings(settings = {}) {
        defaultOutputFormat = sanitizeOutputFormat(settings.defaultOutputFormat);
        activeOutputFormat = defaultOutputFormat;
        syncToolbar();
        return activeOutputFormat;
    }

    function setActiveOutputFormat(value) {
        activeOutputFormat = sanitizeOutputFormat(value);
        syncToolbar();
        return activeOutputFormat;
    }

    function applySavedSettings(settings = {}) {
        const previousDefault = defaultOutputFormat;
        const nextDefault = sanitizeOutputFormat(settings.defaultOutputFormat);
        const followedPreviousDefault = activeOutputFormat === previousDefault;

        defaultOutputFormat = nextDefault;
        if (followedPreviousDefault) {
            activeOutputFormat = nextDefault;
        }
        syncToolbar();
        return activeOutputFormat;
    }

    toolbarSelect?.addEventListener?.('change', () => {
        setActiveOutputFormat(toolbarSelect.value);
    });

    syncToolbar();

    return {
        initializeFromSettings,
        applySavedSettings,
        setActiveOutputFormat,
        getDefaultOutputFormat: () => defaultOutputFormat,
        getActiveOutputFormat: () => activeOutputFormat,
        buildRendererPayload: () => ({ outputFormat: activeOutputFormat })
    };
}
