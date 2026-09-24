const {
  classifyBackgroundMemoryError,
  createBackgroundMemoryGenerator
} = require('./background-memory-generator');

const DEFAULT_MEMORY_MODEL = 'gemini-3.5-flash-lite';
const DEFAULT_DEBOUNCE_MS = 2500;
const DEFAULT_THINKING_LEVEL = 'minimal';

const EMPTY_SUMMARY = Object.freeze({
  currentTopic: '',
  questions: [],
  facts: [],
  candidateExamples: [],
  strengthsGaps: [],
  commitments: [],
  proposedDurableNotes: []
});

function asStringArray(value) {
  if (!Array.isArray(value)) {
    return [];
  }
  return value
    .map((entry) => {
      if (typeof entry === 'string') {
        return entry.trim();
      }
      if (entry && typeof entry === 'object') {
        return String(entry.text || entry.content || entry.note || '').trim();
      }
      return '';
    })
    .filter(Boolean);
}

function validateMemorySummary(raw) {
  let parsed = raw;
  if (typeof raw === 'string') {
    const trimmed = raw.trim();
    const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
    const jsonText = fenced ? fenced[1].trim() : trimmed;
    parsed = JSON.parse(jsonText);
  }

  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('Memory summary must be a JSON object');
  }

  const proposedDurableNotes = Array.isArray(parsed.proposedDurableNotes)
    ? parsed.proposedDurableNotes
      .map((note) => {
        if (typeof note === 'string') {
          const text = note.trim();
          return text ? { id: null, text, status: 'pending' } : null;
        }
        if (note && typeof note === 'object') {
          const text = String(note.text || note.content || '').trim();
          if (!text) {
            return null;
          }
          return {
            id: typeof note.id === 'string' ? note.id : null,
            text,
            status: 'pending'
          };
        }
        return null;
      })
      .filter(Boolean)
    : [];

  return {
    currentTopic: typeof parsed.currentTopic === 'string' ? parsed.currentTopic.trim() : '',
    questions: asStringArray(parsed.questions),
    facts: asStringArray(parsed.facts),
    candidateExamples: asStringArray(parsed.candidateExamples),
    strengthsGaps: asStringArray(parsed.strengthsGaps),
    commitments: asStringArray(parsed.commitments),
    proposedDurableNotes
  };
}

function createNoteId(prefix = 'note') {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function buildMemoryPrompt({ transcript = '', recentAnswers = '', previousSummary = null } = {}) {
  const previous = previousSummary
    ? JSON.stringify(previousSummary, null, 2)
    : '(none)';

  return `
You maintain structured interview/session memory for a live assistant.
Return ONLY valid JSON with this exact shape:
{
  "currentTopic": "string",
  "questions": ["string"],
  "facts": ["string"],
  "candidateExamples": ["string"],
  "strengthsGaps": ["string"],
  "commitments": ["string"],
  "proposedDurableNotes": [{"text": "string"}]
}

Rules:
- Be concise and concrete.
- proposedDurableNotes are cross-interview candidates (stories, skills, weak spots, recurring questions). Keep them short.
- Do not invent details that are not grounded in the transcript/answers.
- Prefer updating prior memory rather than discarding useful facts.

Previous memory JSON:
${previous}

Recent transcript:
${String(transcript || '').trim() || '(empty)'}

Recent AI answers:
${String(recentAnswers || '').trim() || '(empty)'}
`.trim();
}

function createMemoryService(options = {}) {
  const modelName = String(options.modelName || DEFAULT_MEMORY_MODEL).trim() || DEFAULT_MEMORY_MODEL;
  const debounceMs = Number.isFinite(options.debounceMs) ? options.debounceMs : DEFAULT_DEBOUNCE_MS;
  const thinkingLevel = options.thinkingLevel || DEFAULT_THINKING_LEVEL;
  const generateText = typeof options.generateText === 'function' ? options.generateText : null;
  const ownedGenerator = generateText
    ? null
    : createBackgroundMemoryGenerator({
      provider: 'gemini',
      geminiApiKey: options.apiKey || ''
    });
  const getGenerationStatus = typeof options.getGenerationStatus === 'function'
    ? options.getGenerationStatus
    : () => ownedGenerator?.getStatus?.() || null;
  const onSummaryUpdated = typeof options.onSummaryUpdated === 'function'
    ? options.onSummaryUpdated
    : null;
  const onReviewQueueChanged = typeof options.onReviewQueueChanged === 'function'
    ? options.onReviewQueueChanged
    : null;
  const onBeforeSummaryChange = typeof options.onBeforeSummaryChange === 'function'
    ? options.onBeforeSummaryChange
    : null;
  const onBeforeDurableNotesChange = typeof options.onBeforeDurableNotesChange === 'function'
    ? options.onBeforeDurableNotesChange
    : null;
  const persistDurableNotes = typeof options.persistDurableNotes === 'function'
    ? options.persistDurableNotes
    : null;
  const loadDurableNotes = typeof options.loadDurableNotes === 'function'
    ? options.loadDurableNotes
    : () => [];

  let apiKey = String(options.apiKey || '').trim();
  let lastValidSummary = options.initialSummary
    ? validateMemorySummary(options.initialSummary)
    : { ...EMPTY_SUMMARY, proposedDurableNotes: [] };
  let reviewQueue = [];
  let durableNotes = normalizeDurableNotes(loadDurableNotes());
  let debounceTimer = null;
  let queue = Promise.resolve();
  let pendingPayload = null;
  let generation = 0;
  let busy = false;
  let lastSuccessAt = null;
  let lastErrorCategory = null;
  let lastErrorAt = null;

  function normalizeDurableNotes(notes) {
    if (!Array.isArray(notes)) {
      return [];
    }
    return notes
      .map((note) => {
        if (typeof note === 'string') {
          const text = note.trim();
          return text
            ? { id: createNoteId('durable'), text, status: 'approved', updatedAt: Date.now() }
            : null;
        }
        if (note && typeof note === 'object') {
          const text = String(note.text || note.content || '').trim();
          if (!text) {
            return null;
          }
          return {
            id: typeof note.id === 'string' && note.id ? note.id : createNoteId('durable'),
            text,
            status: note.status === 'rejected' ? 'rejected' : 'approved',
            updatedAt: note.updatedAt || Date.now()
          };
        }
        return null;
      })
      .filter((note) => note && note.status === 'approved');
  }

  function setApiKey(nextKey) {
    apiKey = String(nextKey || '').trim();
    ownedGenerator?.updateConfiguration?.({
      provider: 'gemini',
      geminiApiKey: apiKey
    });
  }

  async function defaultGenerateText(prompt) {
    return ownedGenerator.generateText(prompt);
  }

  function getSummary() {
    return {
      ...lastValidSummary,
      proposedDurableNotes: lastValidSummary.proposedDurableNotes.slice()
    };
  }

  function getReviewQueue() {
    return reviewQueue.map((note) => ({ ...note }));
  }

  function getDurableNotes() {
    return durableNotes.map((note) => ({ ...note }));
  }

  function mergeProposedIntoReviewQueue(proposed = []) {
    const existingTexts = new Set(reviewQueue.map((note) => note.text.toLowerCase()));
    for (const note of proposed) {
      const text = String(note.text || '').trim();
      if (!text) {
        continue;
      }
      const key = text.toLowerCase();
      if (existingTexts.has(key)) {
        continue;
      }
      existingTexts.add(key);
      reviewQueue.push({
        id: note.id || createNoteId('proposed'),
        text,
        status: 'pending',
        createdAt: Date.now()
      });
    }
    onReviewQueueChanged?.(getReviewQueue());
  }

  async function runUpdate(payload = {}) {
    const currentGeneration = ++generation;
    busy = true;

    try {
      const prompt = buildMemoryPrompt({
        transcript: payload.transcript || '',
        recentAnswers: payload.recentAnswers || '',
        previousSummary: lastValidSummary
      });

      const raw = await (generateText || defaultGenerateText)(prompt);
      if (currentGeneration !== generation) {
        return getSummary();
      }

      const nextSummary = validateMemorySummary(raw);
      const invalidation = onBeforeSummaryChange?.('session-memory-updated');
      lastValidSummary = nextSummary;
      lastSuccessAt = new Date().toISOString();
      lastErrorCategory = null;
      lastErrorAt = null;
      mergeProposedIntoReviewQueue(nextSummary.proposedDurableNotes);
      onSummaryUpdated?.(getSummary());
      await invalidation;
      return getSummary();
    } catch (error) {
      lastErrorCategory = classifyBackgroundMemoryError(error);
      lastErrorAt = new Date().toISOString();
      console.warn(
        `[memory-service] Update failed; preserving last valid summary (${lastErrorCategory})`
      );
      return getSummary();
    } finally {
      if (currentGeneration === generation) {
        busy = false;
      }
    }
  }

  function enqueueUpdate(payload = {}) {
    pendingPayload = {
      transcript: String(payload.transcript || ''),
      recentAnswers: String(payload.recentAnswers || '')
    };

    if (debounceTimer) {
      clearTimeout(debounceTimer);
    }

    debounceTimer = setTimeout(() => {
      const nextPayload = pendingPayload;
      pendingPayload = null;
      debounceTimer = null;
      queue = queue
        .catch(() => {})
        .then(() => runUpdate(nextPayload || {}));
    }, debounceMs);

    return {
      queued: true,
      debounceMs
    };
  }

  function triggerUpdate(payload = {}) {
    return enqueueUpdate(payload);
  }

  async function flush() {
    if (debounceTimer) {
      clearTimeout(debounceTimer);
      debounceTimer = null;
    }
    if (pendingPayload) {
      const nextPayload = pendingPayload;
      pendingPayload = null;
      queue = queue.catch(() => {}).then(() => runUpdate(nextPayload));
    }
    await queue;
    return getSummary();
  }

  async function reviewNote(action, payload = {}) {
    const noteId = String(payload.id || '').trim();
    const index = reviewQueue.findIndex((note) => note.id === noteId);
    if (index < 0) {
      throw new Error(`Review note not found: ${noteId}`);
    }

    const existing = reviewQueue[index];
    const normalizedAction = String(action || '').trim().toLowerCase();

    if (normalizedAction === 'reject') {
      reviewQueue.splice(index, 1);
      onReviewQueueChanged?.(getReviewQueue());
      return { success: true, action: 'reject', note: existing };
    }

    if (normalizedAction === 'edit' || normalizedAction === 'approve') {
      const text = typeof payload.text === 'string' && payload.text.trim()
        ? payload.text.trim()
        : existing.text;
      const approved = {
        id: existing.id,
        text,
        status: 'approved',
        updatedAt: Date.now()
      };
      const invalidation = onBeforeDurableNotesChange?.(
        normalizedAction === 'edit'
          ? 'durable-notes-edited'
          : 'durable-notes-approved'
      );

      reviewQueue.splice(index, 1);
      durableNotes = [
        ...durableNotes.filter((note) => note.id !== approved.id && note.text.toLowerCase() !== text.toLowerCase()),
        approved
      ];

      const persistence = persistDurableNotes?.(getDurableNotes());
      await Promise.all([persistence, invalidation]);

      onReviewQueueChanged?.(getReviewQueue());
      return { success: true, action: normalizedAction, note: approved, durableNotes: getDurableNotes() };
    }

    throw new Error(`Unsupported review action: ${action}`);
  }

  async function clearSessionMemory() {
    const invalidation = onBeforeSummaryChange?.('session-memory-cleared');
    generation += 1;
    lastValidSummary = {
      currentTopic: '',
      questions: [],
      facts: [],
      candidateExamples: [],
      strengthsGaps: [],
      commitments: [],
      proposedDurableNotes: []
    };
    pendingPayload = null;
    if (debounceTimer) {
      clearTimeout(debounceTimer);
      debounceTimer = null;
    }
    onSummaryUpdated?.(getSummary());
    await invalidation;
    return getSummary();
  }

  async function clearDurableNotes() {
    const invalidation = onBeforeDurableNotesChange?.('durable-notes-cleared');
    durableNotes = [];
    const persistence = persistDurableNotes?.([]);
    await Promise.all([persistence, invalidation]);
    return getDurableNotes();
  }

  function clearReviewQueue() {
    reviewQueue = [];
    onReviewQueueChanged?.(getReviewQueue());
    return getReviewQueue();
  }

  function getStatus() {
    const generationStatus = getGenerationStatus() || {};
    return {
      busy,
      modelName,
      thinkingLevel,
      debounceMs,
      reviewQueueCount: reviewQueue.length,
      durableNotesCount: durableNotes.length,
      hasSummary: Boolean(
        lastValidSummary.currentTopic ||
        lastValidSummary.questions.length ||
        lastValidSummary.facts.length
      ),
      provider: generationStatus.provider || 'gemini',
      model: generationStatus.model || modelName,
      ready: generationStatus.ready === true,
      lastSuccessAt,
      lastErrorCategory,
      lastErrorAt
    };
  }

  return {
    DEFAULT_MEMORY_MODEL,
    validateMemorySummary,
    setApiKey,
    triggerUpdate,
    flush,
    getSummary,
    getReviewQueue,
    getDurableNotes,
    reviewNote,
    clearSessionMemory,
    clearDurableNotes,
    clearReviewQueue,
    getStatus,
    enqueueUpdate
  };
}

module.exports = {
  DEFAULT_MEMORY_MODEL,
  DEFAULT_DEBOUNCE_MS,
  EMPTY_SUMMARY,
  validateMemorySummary,
  buildMemoryPrompt,
  createMemoryService
};
