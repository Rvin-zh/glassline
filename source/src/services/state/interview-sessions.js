'use strict';

const crypto = require('node:crypto');

const MAX_INTERVIEW_SESSIONS = 10;
const MAX_TOPIC_LENGTH = 160;
const MAX_SUMMARY_TEXT_LENGTH = 1000;
const MAX_LEGACY_SUMMARY_LENGTH = 4000;
const MAX_SUMMARY_ITEMS = 50;
const MAX_ARCHIVE_NOTES = 100;
const MAX_NOTE_TEXT_LENGTH = 2000;

const SUMMARY_ARRAY_FIELDS = Object.freeze([
  'questions',
  'facts',
  'candidateExamples',
  'strengthsGaps',
  'commitments'
]);

function sanitizeText(value, maximumLength) {
  if (typeof value !== 'string') {
    return '';
  }
  return value.trim().slice(0, maximumLength);
}

function sanitizeSummaryItem(value) {
  if (typeof value === 'string') {
    return sanitizeText(value, MAX_SUMMARY_TEXT_LENGTH);
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return '';
  }
  return sanitizeText(
    value.text ?? value.content ?? value.note,
    MAX_SUMMARY_TEXT_LENGTH
  );
}

function sanitizeSummaryItems(value) {
  if (!Array.isArray(value)) {
    return [];
  }

  const seen = new Set();
  const items = [];
  for (const entry of value) {
    const text = sanitizeSummaryItem(entry);
    if (!text || seen.has(text)) {
      continue;
    }
    seen.add(text);
    items.push(text);
    if (items.length >= MAX_SUMMARY_ITEMS) {
      break;
    }
  }
  return items;
}

function emptyArchiveSummary() {
  return {
    currentTopic: '',
    questions: [],
    facts: [],
    candidateExamples: [],
    strengthsGaps: [],
    commitments: []
  };
}

function sanitizeInterviewSummary(value) {
  const summary = emptyArchiveSummary();

  if (typeof value === 'string') {
    const legacyText = sanitizeText(value, MAX_LEGACY_SUMMARY_LENGTH);
    if (legacyText) {
      summary.facts = [legacyText];
    }
    return summary;
  }

  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return summary;
  }

  summary.currentTopic = sanitizeText(value.currentTopic, MAX_TOPIC_LENGTH);
  for (const field of SUMMARY_ARRAY_FIELDS) {
    summary[field] = sanitizeSummaryItems(value[field]);
  }
  return summary;
}

function hasInterviewSummaryContent(summary) {
  const sanitized = sanitizeInterviewSummary(summary);
  return Boolean(
    sanitized.currentTopic ||
    SUMMARY_ARRAY_FIELDS.some((field) => sanitized[field].length > 0)
  );
}

function sanitizeArchiveNotes(value) {
  if (!Array.isArray(value)) {
    return [];
  }

  const seen = new Set();
  const notes = [];
  for (const entry of value) {
    if (entry && typeof entry === 'object' && !Array.isArray(entry)) {
      const status = typeof entry.status === 'string'
        ? entry.status.trim().toLowerCase()
        : '';
      if (status && status !== 'approved') {
        continue;
      }
    }

    const text = typeof entry === 'string'
      ? sanitizeText(entry, MAX_NOTE_TEXT_LENGTH)
      : entry && typeof entry === 'object' && !Array.isArray(entry)
        ? sanitizeText(entry.text ?? entry.content ?? entry.note, MAX_NOTE_TEXT_LENGTH)
        : '';
    const identity = text.toLocaleLowerCase('en-US');
    if (!text || seen.has(identity)) {
      continue;
    }
    seen.add(identity);
    notes.push({ text });
    if (notes.length >= MAX_ARCHIVE_NOTES) {
      break;
    }
  }
  return notes;
}

function normalizeArchivedAt(value) {
  const timestamp = value instanceof Date
    ? value.getTime()
    : typeof value === 'number'
      ? value
      : Date.parse(String(value || ''));
  if (!Number.isFinite(timestamp)) {
    return null;
  }
  return new Date(timestamp).toISOString();
}

function canonicalSnapshot(summary, notes) {
  return JSON.stringify({
    summary: sanitizeInterviewSummary(summary),
    notes: sanitizeArchiveNotes(notes)
  });
}

function snapshotFingerprint(summary, notes) {
  return crypto
    .createHash('sha256')
    .update(canonicalSnapshot(summary, notes), 'utf8')
    .digest('hex');
}

function createInterviewSessionArchive({
  summary,
  notes,
  durableNotes,
  archivedAt
} = {}) {
  const sanitizedSummary = sanitizeInterviewSummary(summary);
  if (!hasInterviewSummaryContent(sanitizedSummary)) {
    return null;
  }

  const normalizedTimestamp = normalizeArchivedAt(archivedAt);
  if (!normalizedTimestamp) {
    return null;
  }

  const sanitizedNotes = sanitizeArchiveNotes(notes ?? durableNotes);
  const date = normalizedTimestamp.slice(0, 10);
  const fingerprint = snapshotFingerprint(sanitizedSummary, sanitizedNotes);
  const topic = sanitizedSummary.currentTopic || 'Interview';

  return {
    id: `interview-${date}-${fingerprint.slice(0, 16)}`,
    archivedAt: normalizedTimestamp,
    title: `${topic} — ${date}`,
    summary: sanitizedSummary,
    notes: sanitizedNotes
  };
}

function sanitizeInterviewSessionFields(state = {}) {
  const input = state && typeof state === 'object' && !Array.isArray(state)
    ? state
    : {};
  const archives = [];
  const seenSnapshots = new Set();

  if (Array.isArray(input.interviewSessions)) {
    for (const entry of input.interviewSessions) {
      if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
        continue;
      }
      const archive = createInterviewSessionArchive({
        summary: entry.summary,
        notes: entry.notes,
        archivedAt: entry.archivedAt
      });
      if (!archive) {
        continue;
      }
      const fingerprint = snapshotFingerprint(archive.summary, archive.notes);
      if (seenSnapshots.has(fingerprint)) {
        continue;
      }
      seenSnapshots.add(fingerprint);
      archives.push(archive);
    }
  }

  archives.sort((left, right) => (
    Date.parse(right.archivedAt) - Date.parse(left.archivedAt) ||
    left.id.localeCompare(right.id)
  ));
  const interviewSessions = archives.slice(0, MAX_INTERVIEW_SESSIONS);
  const knownIds = new Set(interviewSessions.map(({ id }) => id));
  const selectedInterviewSessionIds = [];
  const selectedSeen = new Set();

  if (Array.isArray(input.selectedInterviewSessionIds)) {
    for (const value of input.selectedInterviewSessionIds) {
      if (typeof value !== 'string') {
        continue;
      }
      const id = value.trim();
      if (!knownIds.has(id) || selectedSeen.has(id)) {
        continue;
      }
      selectedSeen.add(id);
      selectedInterviewSessionIds.push(id);
    }
  }

  return {
    interviewSessions,
    selectedInterviewSessionIds
  };
}

function resolveLaunchTimestamp(now) {
  const value = typeof now === 'function' ? now() : now;
  return normalizeArchivedAt(value ?? Date.now());
}

function rotateInterviewSessionOnLaunch(state = {}, options = {}) {
  const input = state && typeof state === 'object' && !Array.isArray(state)
    ? state
    : {};
  const existing = sanitizeInterviewSessionFields(input);
  const structuredSummary = sanitizeInterviewSummary(input.sessionMemory);
  const summary = hasInterviewSummaryContent(structuredSummary)
    ? structuredSummary
    : sanitizeInterviewSummary(input.sessionMemorySummary);
  let interviewSessions = existing.interviewSessions;

  if (hasInterviewSummaryContent(summary)) {
    const archive = createInterviewSessionArchive({
      summary,
      durableNotes: input.durableNotes,
      archivedAt: resolveLaunchTimestamp(options.now)
    });
    if (archive) {
      const fingerprint = snapshotFingerprint(archive.summary, archive.notes);
      const duplicate = interviewSessions.some((entry) => (
        snapshotFingerprint(entry.summary, entry.notes) === fingerprint
      ));
      if (!duplicate) {
        interviewSessions = [archive, ...interviewSessions]
          .sort((left, right) => (
            Date.parse(right.archivedAt) - Date.parse(left.archivedAt) ||
            left.id.localeCompare(right.id)
          ))
          .slice(0, MAX_INTERVIEW_SESSIONS);
      }
    }
  }

  return {
    ...input,
    sessionMemorySummary: null,
    sessionMemory: null,
    durableNotes: [],
    interviewSessions,
    selectedInterviewSessionIds: []
  };
}

function selectInterviewSessions(state = {}, requestedIds = []) {
  const sanitized = sanitizeInterviewSessionFields(state);
  const knownIds = new Set(sanitized.interviewSessions.map(({ id }) => id));
  const selectedInterviewSessionIds = [];
  const seen = new Set();

  if (Array.isArray(requestedIds)) {
    for (const value of requestedIds) {
      if (typeof value !== 'string') {
        continue;
      }
      const id = value.trim();
      if (!knownIds.has(id) || seen.has(id)) {
        continue;
      }
      seen.add(id);
      selectedInterviewSessionIds.push(id);
    }
  }

  return {
    ...state,
    interviewSessions: sanitized.interviewSessions,
    selectedInterviewSessionIds
  };
}

function getSelectedInterviewSessions(state = {}) {
  const sanitized = sanitizeInterviewSessionFields(state);
  const selectedIds = new Set(sanitized.selectedInterviewSessionIds);
  return sanitized.interviewSessions.filter(({ id }) => selectedIds.has(id));
}

function listInterviewSessions(state = {}) {
  const sanitized = sanitizeInterviewSessionFields(state);
  const selectedIds = new Set(sanitized.selectedInterviewSessionIds);
  return sanitized.interviewSessions.map((archive) => ({
    id: archive.id,
    archivedAt: archive.archivedAt,
    title: archive.title,
    noteCount: archive.notes.length,
    selected: selectedIds.has(archive.id)
  }));
}

function deleteInterviewSession(state = {}, interviewSessionId = '') {
  const sanitized = sanitizeInterviewSessionFields(state);
  const id = typeof interviewSessionId === 'string'
    ? interviewSessionId.trim()
    : '';

  return {
    ...state,
    interviewSessions: sanitized.interviewSessions.filter((entry) => entry.id !== id),
    selectedInterviewSessionIds: sanitized.selectedInterviewSessionIds.filter(
      (selectedId) => selectedId !== id
    )
  };
}

function clearInterviewSessions(state = {}) {
  return {
    ...state,
    interviewSessions: [],
    selectedInterviewSessionIds: []
  };
}

module.exports = {
  MAX_INTERVIEW_SESSIONS,
  clearInterviewSessions,
  createInterviewSessionArchive,
  deleteInterviewSession,
  getSelectedInterviewSessions,
  hasInterviewSummaryContent,
  listInterviewSessions,
  rotateInterviewSessionOnLaunch,
  sanitizeArchiveNotes,
  sanitizeInterviewSessionFields,
  sanitizeInterviewSummary,
  selectInterviewSessions
};
