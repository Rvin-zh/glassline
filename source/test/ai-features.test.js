'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { createAiRuntime } = require('../src/main-process/features/assistant/gemini-runtime');
const { validateMemorySummary } = require('../src/services/ai/memory-service');
const { assembleContext } = require('../src/services/ai/context-assembler');
const { createSearchService } = require('../src/services/search');

describe('ai readiness', () => {
  it('reports not ready for gemini without keys', () => {
    const runtime = createAiRuntime();
    runtime.setActiveAiProvider('gemini');
    runtime.setKeys('', 0);
    assert.equal(runtime.isAiReady(), false);
  });

  it('reports not ready for portkey without api key', () => {
    const runtime = createAiRuntime();
    runtime.setActiveAiProvider('portkey');
    runtime.setActivePortkeyApiKey('');
    assert.equal(runtime.isAiReady(), false);
  });
});

describe('memory schema', () => {
  it('validates structured memory JSON', () => {
    const summary = validateMemorySummary({
      currentTopic: 'System design',
      questions: ['Design a URL shortener'],
      facts: ['Candidate prefers Python'],
      candidateExamples: ['Built a cache layer'],
      strengthsGaps: ['Strong APIs', 'Weak concurrency'],
      commitments: ['Send follow-up'],
      proposedDurableNotes: ['Prefers Python for backend interviews']
    });

    assert.equal(summary.currentTopic, 'System design');
    assert.equal(summary.proposedDurableNotes[0].status, 'pending');
  });
});

describe('context assembler', () => {
  it('prioritizes pinned documents on desktop and excludes them for mobile', () => {
    const desktop = assembleContext({
      audience: 'desktop',
      resume: 'RESUME:' + 'A'.repeat(200),
      jobDescription: 'JOB:' + 'B'.repeat(200),
      durableNotes: [{ text: 'NOTE: durable', status: 'approved' }],
      sessionMemory: { currentTopic: 'Graphs' },
      transcript: 'You: hello\nHost: question',
      charBudget: 500
    });

    assert.ok(desktop.resume.includes('RESUME') || desktop.pinnedBlock.includes('RESUME'));
    assert.ok(desktop.sections.some((section) => section.pinned));

    const mobile = assembleContext({
      audience: 'mobile',
      resume: 'RESUME:secret',
      durableNotes: [{ text: 'NOTE: durable', status: 'approved' }],
      transcript: 'You: hello',
      charBudget: 500
    });

    assert.equal(mobile.contextString.includes('RESUME:secret'), false);
    assert.equal(mobile.contextString.includes('NOTE: durable'), false);
    assert.deepEqual(mobile.excludedForMobile, [
      'resume',
      'jobDescription',
      'durableNotes',
      'interviewSessions'
    ]);
  });

  it('never budget-evicts pinned resume/job content', () => {
    const assembled = assembleContext({
      audience: 'desktop',
      resume: 'PINNED_RESUME_' + 'R'.repeat(800),
      transcript: 'DROP_ME_' + 'T'.repeat(800),
      charBudget: 400
    });

    assert.ok(assembled.contextString.includes('PINNED_RESUME_'));
    assert.ok(assembled.sections.find((section) => section.label.includes('Resume'))?.pinned);
  });

  it('keeps current memory separate while pinning selected interview archives on desktop', () => {
    const selectedInterview = {
      id: 'interview-2026-09-08-aaaaaaaaaaaaaaaa',
      archivedAt: '2026-09-08T12:00:00.000Z',
      title: 'Distributed systems — 2026-09-08',
      summary: {
        currentTopic: 'SELECTED_ARCHIVE_TOPIC',
        questions: ['SELECTED_ARCHIVE_QUESTION'],
        facts: [],
        candidateExamples: [],
        strengthsGaps: [],
        commitments: []
      },
      notes: [{ text: 'SELECTED_ARCHIVE_NOTE' }]
    };
    const desktop = assembleContext({
      audience: 'desktop',
      memorySummary: { currentTopic: 'CURRENT_SESSION_TOPIC' },
      durableNotes: [{
        text: 'CURRENT_SESSION_NOTE',
        status: 'approved'
      }],
      selectedInterviewSessions: [selectedInterview],
      transcript: 'Current transcript'
    });

    assert.match(desktop.memorySummary, /CURRENT_SESSION_TOPIC/);
    assert.doesNotMatch(desktop.memorySummary, /SELECTED_ARCHIVE/);
    assert.deepEqual(
      desktop.durableNotes.map(({ text }) => text),
      ['CURRENT_SESSION_NOTE']
    );
    assert.match(desktop.previousInterviewContext, /SELECTED_ARCHIVE_TOPIC/);
    assert.match(desktop.previousInterviewContext, /SELECTED_ARCHIVE_QUESTION/);
    assert.match(desktop.previousInterviewContext, /SELECTED_ARCHIVE_NOTE/);
    assert.match(desktop.promptMemorySummary, /CURRENT_SESSION_TOPIC/);
    assert.match(desktop.promptMemorySummary, /SELECTED_ARCHIVE_TOPIC/);
    assert.deepEqual(
      desktop.promptDurableNotes.map(({ text }) => text),
      ['CURRENT_SESSION_NOTE', 'SELECTED_ARCHIVE_NOTE']
    );
    assert.ok(
      desktop.sections.some((section) => (
        section.label === 'Previous interviews (selected, pinned)' &&
        section.pinned === true
      ))
    );
  });

  it('excludes every archive field from mobile context and prompt fields', () => {
    const archiveMarker = 'MOBILE_MUST_NOT_RECEIVE_ARCHIVE';
    const mobile = assembleContext({
      audience: 'mobile',
      memorySummary: { currentTopic: 'CURRENT_MOBILE_MEMORY' },
      durableNotes: [{ text: 'CURRENT_SENSITIVE_NOTE', status: 'approved' }],
      selectedInterviewSessions: [{
        id: 'interview-2026-09-08-bbbbbbbbbbbbbbbb',
        archivedAt: '2026-09-08T12:00:00.000Z',
        title: `${archiveMarker} — 2026-09-08`,
        summary: {
          currentTopic: archiveMarker,
          questions: [archiveMarker],
          facts: [],
          candidateExamples: [],
          strengthsGaps: [],
          commitments: []
        },
        notes: [{ text: archiveMarker }]
      }],
      transcript: 'Safe mobile transcript'
    });

    assert.equal(JSON.stringify(mobile).includes(archiveMarker), false);
    assert.equal(JSON.stringify(mobile).includes('CURRENT_SENSITIVE_NOTE'), false);
    assert.deepEqual(mobile.promptDurableNotes, []);
    assert.equal(mobile.previousInterviewContext, '');
    assert.ok(mobile.excludedForMobile.includes('interviewSessions'));
  });
});

describe('search toggles', () => {
  it('makes no network calls when search is disabled', async () => {
    let called = false;
    const search = createSearchService({
      globalEnabled: false,
      provider: 'tavily',
      tavilyAdapter: {
        async search() {
          called = true;
          return { results: [], citations: [] };
        }
      }
    });

    const result = await search.search('react hooks', { enableSearch: true });
    assert.equal(called, false);
    assert.equal(result.enabled, false);
    assert.equal(result.skipped, true);
  });

  it('makes no network calls when per-request search is off', async () => {
    let called = false;
    const search = createSearchService({
      globalEnabled: true,
      provider: 'tavily',
      tavilyAdapter: {
        async search() {
          called = true;
          return { results: [{ title: 'x', url: 'https://example.com', snippet: 'y' }], citations: [] };
        }
      }
    });

    const result = await search.search('react hooks', { enableSearch: false });
    assert.equal(called, false);
    assert.equal(result.skipped, true);
    assert.equal(result.reason, 'request-disabled');
  });
});