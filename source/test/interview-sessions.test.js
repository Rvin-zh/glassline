'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const {
  getDefaultAppState,
  sanitizeAppState
} = require('../src/services/state/app-state');
const {
  MAX_INTERVIEW_SESSIONS,
  clearInterviewSessions,
  createInterviewSessionArchive,
  deleteInterviewSession,
  getSelectedInterviewSessions,
  listInterviewSessions,
  rotateInterviewSessionOnLaunch,
  sanitizeInterviewSessionFields,
  selectInterviewSessions
} = require('../src/services/state/interview-sessions');

const FIXED_NOW = '2026-09-09T20:15:30.000Z';

function createSummary(topic, overrides = {}) {
  return {
    currentTopic: topic,
    questions: ['How would you scale it?'],
    facts: ['Used a write-through cache'],
    candidateExamples: ['Migrated a queue'],
    strengthsGaps: ['Strong trade-off analysis'],
    commitments: ['Follow up on capacity math'],
    proposedDurableNotes: [{ text: 'pending note must not be archived' }],
    updatedAt: 123,
    transcript: 'raw transcript must not be archived',
    recentAnswers: 'AI answer must not be archived',
    ...overrides
  };
}

function createApprovedNote(id, text) {
  return {
    id,
    text,
    status: 'approved',
    updatedAt: 456,
    screenshotPath: '/tmp/private-screen.png',
    apiKey: 'never-copy-this'
  };
}

describe('interview launch rotation', () => {
  it('archives a non-empty summary and approved notes before starting empty', () => {
    const rotated = rotateInterviewSessionOnLaunch({
      sessionMemorySummary: 'legacy mirror',
      sessionMemory: createSummary('System design'),
      durableNotes: [
        createApprovedNote('keep', 'Prefer concrete capacity estimates'),
        { id: 'drop', text: 'Rejected note', status: 'rejected' },
        { id: 'pending', text: 'Pending durable note', status: 'pending' }
      ],
      interviewSessions: [],
      selectedInterviewSessionIds: ['stale-selection']
    }, { now: FIXED_NOW });

    assert.equal(rotated.sessionMemory, null);
    assert.equal(rotated.sessionMemorySummary, null);
    assert.deepEqual(rotated.durableNotes, []);
    assert.deepEqual(rotated.selectedInterviewSessionIds, []);
    assert.equal(rotated.interviewSessions.length, 1);

    const [archive] = rotated.interviewSessions;
    assert.match(archive.id, /^interview-2026-09-09-[a-f0-9]{16}$/);
    assert.equal(archive.archivedAt, FIXED_NOW);
    assert.equal(archive.title, 'System design — 2026-09-09');
    assert.deepEqual(Object.keys(archive).sort(), [
      'archivedAt',
      'id',
      'notes',
      'summary',
      'title'
    ]);
    assert.deepEqual(Object.keys(archive.summary).sort(), [
      'candidateExamples',
      'commitments',
      'currentTopic',
      'facts',
      'questions',
      'strengthsGaps'
    ]);
    assert.deepEqual(archive.notes, [
      { text: 'Prefer concrete capacity estimates' }
    ]);
    const serialized = JSON.stringify(archive);
    assert.equal(serialized.includes('raw transcript'), false);
    assert.equal(serialized.includes('AI answer'), false);
    assert.equal(serialized.includes('/tmp/private-screen.png'), false);
    assert.equal(serialized.includes('never-copy-this'), false);
    assert.equal(serialized.includes('pending note'), false);
    assert.equal(serialized.includes('Pending durable note'), false);
    assert.equal(serialized.includes('Rejected note'), false);
  });

  it('does not archive an empty/default summary and still clears launch state', () => {
    const rotated = rotateInterviewSessionOnLaunch({
      sessionMemory: createSummary('', {
        questions: [],
        facts: [],
        candidateExamples: [],
        strengthsGaps: [],
        commitments: []
      }),
      durableNotes: [createApprovedNote('orphan', 'Orphan note')],
      selectedInterviewSessionIds: ['stale-selection']
    }, { now: FIXED_NOW });

    assert.deepEqual(rotated.interviewSessions, []);
    assert.deepEqual(rotated.selectedInterviewSessionIds, []);
    assert.equal(rotated.sessionMemory, null);
    assert.deepEqual(rotated.durableNotes, []);
  });

  it('deduplicates an identical launch snapshot without changing its archive time', () => {
    const first = rotateInterviewSessionOnLaunch({
      sessionMemory: createSummary('Caching'),
      durableNotes: [createApprovedNote('one', 'Use bounded TTLs')]
    }, { now: FIXED_NOW });

    const second = rotateInterviewSessionOnLaunch({
      ...first,
      sessionMemory: createSummary('Caching'),
      durableNotes: [createApprovedNote('different-id', 'Use bounded TTLs')]
    }, { now: '2026-09-10T07:00:00.000Z' });

    assert.equal(second.interviewSessions.length, 1);
    assert.equal(second.interviewSessions[0].id, first.interviewSessions[0].id);
    assert.equal(second.interviewSessions[0].archivedAt, FIXED_NOW);
    assert.deepEqual(second.selectedInterviewSessionIds, []);
  });

  it('retains only the latest ten archives', () => {
    let state = {
      interviewSessions: [],
      selectedInterviewSessionIds: []
    };

    for (let index = 0; index < MAX_INTERVIEW_SESSIONS + 1; index += 1) {
      state = rotateInterviewSessionOnLaunch({
        ...state,
        sessionMemory: createSummary(`Topic ${index}`),
        durableNotes: [createApprovedNote(`note-${index}`, `Note ${index}`)]
      }, {
        now: new Date(Date.UTC(2026, 0, index + 1)).toISOString()
      });
    }

    assert.equal(state.interviewSessions.length, MAX_INTERVIEW_SESSIONS);
    assert.equal(state.interviewSessions[0].summary.currentTopic, 'Topic 10');
    assert.equal(state.interviewSessions.at(-1).summary.currentTopic, 'Topic 1');
  });

  it('migrates legacy summary text and durable notes into one archive', () => {
    const migrated = rotateInterviewSessionOnLaunch({
      sessionMemorySummary: 'Legacy interview focused on graph traversal',
      sessionMemory: null,
      durableNotes: [createApprovedNote('legacy-note', 'Practice BFS trade-offs')]
    }, { now: FIXED_NOW });

    assert.equal(migrated.interviewSessions.length, 1);
    assert.equal(
      migrated.interviewSessions[0].summary.facts[0],
      'Legacy interview focused on graph traversal'
    );
    assert.deepEqual(migrated.interviewSessions[0].notes, [
      { text: 'Practice BFS trade-offs' }
    ]);
    assert.equal(migrated.sessionMemorySummary, null);
    assert.deepEqual(migrated.durableNotes, []);
  });

  it('creates deterministic archive identifiers and titles', () => {
    const snapshot = {
      summary: createSummary('API design'),
      notes: [createApprovedNote('note-a', 'Mention idempotency')],
      archivedAt: FIXED_NOW
    };

    const first = createInterviewSessionArchive(snapshot);
    const second = createInterviewSessionArchive({
      ...snapshot,
      notes: [createApprovedNote('other-id', 'Mention idempotency')]
    });

    assert.deepEqual(second, first);
  });

  it('accepts the numeric clock value used by real application startup', () => {
    const timestamp = Date.parse(FIXED_NOW);
    const rotated = rotateInterviewSessionOnLaunch({
      sessionMemory: createSummary('Numeric startup clock'),
      durableNotes: [createApprovedNote('numeric-note', 'Numeric clock note')]
    }, { now: timestamp });

    assert.equal(rotated.interviewSessions.length, 1);
    assert.equal(rotated.interviewSessions[0].archivedAt, FIXED_NOW);
  });
});

describe('interview archive sanitization and actions', () => {
  it('integrates strict archive fields into app-state defaults and sanitization', () => {
    const archive = createInterviewSessionArchive({
      summary: createSummary('Sanitized topic'),
      notes: [createApprovedNote('note', 'Sanitized note')],
      archivedAt: FIXED_NOW
    });
    const defaults = getDefaultAppState();

    assert.deepEqual(defaults.interviewSessions, []);
    assert.deepEqual(defaults.selectedInterviewSessionIds, []);

    const sanitized = sanitizeAppState({
      interviewSessions: [{
        ...archive,
        transcript: 'remove transcript',
        screenshots: ['remove screenshot'],
        aiAnswers: ['remove answer']
      }],
      selectedInterviewSessionIds: [archive.id, archive.id, 'unknown']
    });

    assert.deepEqual(sanitized.interviewSessions, [archive]);
    assert.deepEqual(sanitized.selectedInterviewSessionIds, [archive.id]);
  });

  it('strictly sanitizes archives, caps retention, and filters selections', () => {
    const archives = Array.from({ length: 12 }, (_, index) => ({
      id: `attacker-controlled-${index}`,
      archivedAt: new Date(Date.UTC(2026, 0, index + 1)).toISOString(),
      title: `Injected title ${index}`,
      summary: createSummary(`Topic ${index}`),
      notes: [
        createApprovedNote(`approved-${index}`, `Approved ${index}`),
        { text: `Rejected ${index}`, status: 'rejected' }
      ],
      transcript: 'must be removed',
      screenshots: ['screen.png'],
      aiAnswers: ['must be removed'],
      key: 'must be removed',
      path: '/must/be/removed'
    }));

    const sanitized = sanitizeInterviewSessionFields({
      interviewSessions: archives,
      selectedInterviewSessionIds: [
        'attacker-controlled-11',
        'attacker-controlled-11',
        123,
        'unknown'
      ]
    });

    assert.equal(sanitized.interviewSessions.length, MAX_INTERVIEW_SESSIONS);
    assert.equal(
      sanitized.interviewSessions[0].summary.currentTopic,
      'Topic 11'
    );
    assert.deepEqual(sanitized.selectedInterviewSessionIds, []);
    for (const archive of sanitized.interviewSessions) {
      assert.deepEqual(Object.keys(archive).sort(), [
        'archivedAt',
        'id',
        'notes',
        'summary',
        'title'
      ]);
      assert.equal(archive.notes.length, 1);
      assert.deepEqual(Object.keys(archive.notes[0]), ['text']);
    }
  });

  it('lists metadata, multi-selects known IDs, deletes one, and clears all', () => {
    const first = createInterviewSessionArchive({
      summary: createSummary('First topic'),
      notes: [createApprovedNote('n1', 'First note')],
      archivedAt: '2026-09-08T12:00:00.000Z'
    });
    const second = createInterviewSessionArchive({
      summary: createSummary('Second topic'),
      notes: [
        createApprovedNote('n2', 'Second note'),
        createApprovedNote('n3', 'Third note')
      ],
      archivedAt: FIXED_NOW
    });
    const initial = {
      interviewSessions: [second, first],
      selectedInterviewSessionIds: []
    };

    const selected = selectInterviewSessions(initial, [
      first.id,
      'unknown-id',
      second.id,
      first.id
    ]);
    assert.deepEqual(selected.selectedInterviewSessionIds, [
      first.id,
      second.id
    ]);
    assert.deepEqual(
      getSelectedInterviewSessions(selected).map((session) => session.id),
      [second.id, first.id]
    );
    assert.deepEqual(listInterviewSessions(selected), [
      {
        id: second.id,
        archivedAt: second.archivedAt,
        title: second.title,
        noteCount: 2,
        selected: true
      },
      {
        id: first.id,
        archivedAt: first.archivedAt,
        title: first.title,
        noteCount: 1,
        selected: true
      }
    ]);

    const deleted = deleteInterviewSession(selected, second.id);
    assert.deepEqual(deleted.interviewSessions.map(({ id }) => id), [first.id]);
    assert.deepEqual(deleted.selectedInterviewSessionIds, [first.id]);

    const cleared = clearInterviewSessions(deleted);
    assert.deepEqual(cleared.interviewSessions, []);
    assert.deepEqual(cleared.selectedInterviewSessionIds, []);
  });
});

describe('main-process launch ordering', () => {
  it('rotates exactly once after state load and before context services initialize', () => {
    const source = fs.readFileSync(
      path.join(__dirname, '..', 'src', 'main-process', 'start-application.js'),
      'utf8'
    );
    const loadIndex = source.indexOf('appState = loadAppState(app);');
    const rotationIndex = source.indexOf('rotateInterviewSessionOnLaunch(');
    const contextIndex = source.indexOf('contextServices = registerContextServicesIpc({');
    const rotationCalls = source.match(/rotateInterviewSessionOnLaunch\(/g) || [];

    assert.ok(loadIndex >= 0);
    assert.ok(rotationIndex > loadIndex);
    assert.ok(contextIndex > rotationIndex);
    assert.equal(rotationCalls.length, 1);
  });
});
