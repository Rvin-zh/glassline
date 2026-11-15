'use strict';

const fs = require('fs');
const path = require('path');
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const {
  PRACTICE_DOMAINS,
  PRACTICE_DIFFICULTIES,
  resolvePracticeDomain,
  resolvePracticeDifficulty,
  buildPracticeQuestionPrompt,
  buildPracticeEvaluationPrompt,
  createInterviewPracticeService
} = require('../src/services/ai/interview-practice');
const { createAssistantFacade } = require('../src/services/ai/assistant-facade');
const { registerAssistantIpc } = require('../src/main-process/features/assistant/ipc');

function createMockAdapter({ ready = true, replyText = '' } = {}) {
  const calls = [];
  const adapter = {
    model: 'mock-model',
    modelName: 'mock-model',
    programmingLanguage: 'TypeScript',
    conversationHistory: [],
    capabilities: {
      supportsMultimodal: false,
      supportsStreaming: true,
      supportsGoogleSearch: false,
      supportsThinkingLevels: false,
      provider: 'gemini'
    },
    isReady: () => ready,
    generateText: async (prompt, options = {}) => {
      calls.push({ prompt, options });
      const text = typeof replyText === 'function' ? replyText(prompt, calls.length) : replyText;
      if (typeof options.onChunk === 'function') {
        options.onChunk({ text, index: 0 });
      }
      return text;
    },
    generateMultimodal: async () => '',
    updateConfiguration: () => ({}),
    addToHistory: (role, content) => adapter.conversationHistory.push({ role, content }),
    clearHistory: () => { adapter.conversationHistory = []; },
    getContextString: () => adapter.conversationHistory.map((m) => `${m.role}: ${m.content}`).join('\n'),
    isQuotaExhaustedError: () => false,
    isAuthenticationError: () => false,
    isRetryableError: () => false
  };
  return { adapter, calls };
}

describe('Interview Practice prompt builders & validation', () => {
  it('resolves valid and fallback domains/difficulties safely', () => {
    assert.ok(PRACTICE_DOMAINS['system-design']);
    assert.ok(PRACTICE_DIFFICULTIES.includes('senior'));
    assert.equal(resolvePracticeDomain('CODING'), 'coding');
    assert.equal(resolvePracticeDomain('unknown-domain'), 'mixed');
    assert.equal(resolvePracticeDifficulty('STAFF'), 'staff');
    assert.equal(resolvePracticeDifficulty('invalid'), 'mid');
  });

  it('builds practice question prompt incorporating context and dedupe list', () => {
    const prompt = buildPracticeQuestionPrompt({
      domain: 'system-design',
      difficulty: 'senior',
      topic: 'Distributed Rate Limiter',
      programmingLanguage: 'Go',
      resumeContext: 'Built high-throughput API gateways',
      jobDescriptionContext: 'Staff Platform Engineer',
      previousQuestions: ['Design an idempotent queue']
    });

    assert.ok(prompt.includes('System Design (system-design)'));
    assert.ok(prompt.includes('Difficulty Level: senior'));
    assert.ok(prompt.includes('Distributed Rate Limiter'));
    assert.ok(prompt.includes('Built high-throughput API gateways'));
    assert.ok(prompt.includes('Staff Platform Engineer'));
    assert.ok(prompt.includes('Design an idempotent queue'));
    assert.ok(prompt.includes('## Practice Question'));
  });

  it('builds evaluation prompt requiring rewrite and actionable improvement plan', () => {
    const prompt = buildPracticeEvaluationPrompt({
      question: 'How do you mitigate write skew in Snapshot Isolation?',
      candidateAnswer: 'We can use Serializable isolation or select for update locks.',
      domain: 'conceptual',
      difficulty: 'mid',
      programmingLanguage: 'SQL'
    });

    assert.ok(prompt.includes('How do you mitigate write skew'));
    assert.ok(prompt.includes('We can use Serializable isolation'));
    assert.ok(prompt.includes('## Evaluation & Rubric Score'));
    assert.ok(prompt.includes('## Strengths & Gaps'));
    assert.ok(prompt.includes('## How to Respond Instead (Model Answer)'));
    assert.ok(prompt.includes('## Actionable Improvement Plan'));
  });
});

describe('Interview Practice service (offline fallback & AI adapter)', () => {
  it('generates non-repeating questions and evaluates answers in offline rubric mode', async () => {
    const service = createInterviewPracticeService({
      getAdapter: () => null,
      getContextTexts: () => ({ resume: 'CS student', jobDescription: 'Backend SWE' })
    });

    const q1 = await service.generateQuestion({ domain: 'mixed', difficulty: 'mid' });
    assert.equal(q1.success, true);
    assert.equal(q1.offline, true);
    assert.ok(q1.text.includes('## Practice Question'));

    const emptyEval = await service.evaluateResponse({ candidateAnswer: '   ' });
    assert.equal(emptyEval.success, false);

    const shortEval = await service.evaluateResponse({
      candidateAnswer: 'Use a hash map and doubly linked list.'
    });
    assert.equal(shortEval.success, true);
    assert.equal(shortEval.offline, true);
    assert.ok(shortEval.evaluation.includes('## Evaluation & Rubric Score'));
    assert.ok(shortEval.evaluation.includes('## How to Respond Instead (Model Answer)'));
    assert.ok(shortEval.evaluation.includes('## Actionable Improvement Plan'));

    const richEval = await service.evaluateResponse({
      candidateAnswer:
        'First, combine a hash map mapping keys to linked-list nodes so get and put stay O(1). ' +
        'Because capacity can hit zero or duplicate keys can arrive, unlink stale nodes before inserting at head, ' +
        'track expiration timestamps on each entry, and handle concurrent timeout or lock edge cases carefully.'
    });
    assert.equal(richEval.success, true);

    const shortScore = Number(shortEval.evaluation.match(/(\d+)\/10/)?.[1] || 0);
    const richScore = Number(richEval.evaluation.match(/(\d+)\/10/)?.[1] || 0);
    assert.ok(richScore > shortScore, `Expected richScore (${richScore}) > shortScore (${shortScore})`);

    const q2 = await service.generateQuestion({ domain: 'mixed', difficulty: 'mid' });
    assert.notEqual(q2.question.resolvedDomain, q1.question.resolvedDomain);
    assert.equal(service.getState().turnsCount, 2);

    const reset = service.resetSession();
    assert.equal(reset.success, true);
    assert.equal(service.getState().currentQuestion, null);
    assert.equal(service.getState().turnsCount, 0);
  });

  it('delegates through live AI adapter with executeWithAdapter and streams chunks', async () => {
    const { adapter, calls } = createMockAdapter({
      ready: true,
      replyText: (_prompt, callNo) => (callNo === 1
        ? '## Practice Question\nExplain consistent hashing.'
        : '## Evaluation & Rubric Score\n9/10\n## How to Respond Instead (Model Answer)\nRing hashing with virtual nodes.')
    });

    let failoverExecutions = 0;
    const service = createInterviewPracticeService({
      getAdapter: () => adapter,
      executeWithAdapter: async (fn) => {
        failoverExecutions += 1;
        return fn(adapter);
      },
      getContextTexts: () => ({ resume: 'Distributed Systems TA', jobDescription: 'Infra Intern' }),
      getProgrammingLanguage: () => 'Rust'
    });

    const chunks = [];
    const qRes = await service.generateQuestion({
      domain: 'system-design',
      difficulty: 'senior',
      onChunk: (chunk) => chunks.push(chunk.text)
    });
    assert.equal(qRes.offline, false);
    assert.equal(qRes.provider, 'llm');
    assert.equal(chunks.length, 1);
    assert.equal(failoverExecutions, 1);

    const evalRes = await service.evaluateResponse({
      candidateAnswer: 'Consistent hashing maps keys onto a ring with virtual nodes to minimize key movement.'
    });
    assert.equal(evalRes.offline, false);
    assert.equal(failoverExecutions, 2);
    assert.equal(calls.length, 2);
    assert.ok(calls[0].prompt.includes('Rust'));
    assert.ok(calls[1].prompt.includes('Explain consistent hashing.'));
  });

  it('exposes practice methods on assistant-facade without altering existing facade methods', async () => {
    const { adapter, calls } = createMockAdapter({
      ready: true,
      replyText: 'Facade practice output'
    });
    const facade = createAssistantFacade(adapter);

    const q = await facade.generatePracticeQuestion({ domain: 'coding', topic: 'Tries' });
    const e = await facade.evaluatePracticeResponse({
      question: q,
      candidateAnswer: 'Prefix tree nodes with children maps.'
    });

    assert.equal(q, 'Facade practice output');
    assert.equal(e, 'Facade practice output');
    assert.equal(calls.length, 2);
    assert.ok(calls[0].prompt.includes('Tries'));
  });
});

describe('Assistant IPC practice handlers & renderer UI contract', () => {
  it('registers practice-next-question, practice-evaluate-response, practice-get-state, practice-reset-session', async () => {
    const handlers = new Map();
    const emitted = [];
    const mockIpcMain = {
      handle: (channel, handler) => handlers.set(channel, handler)
    };

    registerAssistantIpc({
      ipcMain: mockIpcMain,
      screenshotManager: {},
      windowController: {},
      geminiRuntime: {
        isAiReady: () => false,
        getService: () => null,
        getActiveProgrammingLanguage: () => 'Python',
        executeWithKeyFailover: async (fn) => fn(null)
      },
      assemblyAiService: { flushAllSttHistoryBuffers: () => {}, resetSttHistoryBuffers: () => {} },
      sendToRenderer: (channel, data) => emitted.push({ channel, data }),
      quitApplication: () => {},
      getContextServices: () => null,
      getAppState: () => ({ resumeText: 'BSc Computer Science', jobDescriptionText: 'Backend SWE' })
    });

    const qResult = await handlers.get('practice-next-question')({}, { domain: 'coding' });
    assert.equal(qResult.success, true);

    const evalResult = await handlers.get('practice-evaluate-response')({}, {
      candidateAnswer: 'Use hash map plus doubly linked list for O(1) get/put and handle expired keys cleanly.'
    });
    assert.equal(evalResult.success, true);
    assert.ok(evalResult.evaluation.includes('## How to Respond Instead (Model Answer)'));

    const stateResult = await handlers.get('practice-get-state')({});
    assert.equal(stateResult.success, true);
    assert.equal(stateResult.state.turnsCount, 1);

    const resetResult = await handlers.get('practice-reset-session')({});
    assert.equal(resetResult.success, true);
    assert.equal(resetResult.state.turnsCount, 0);

    assert.ok(emitted.some((evt) => evt.channel === 'ai-stream-start' && evt.data.actionId === 'practiceQuestion'));
    assert.ok(emitted.some((evt) => evt.channel === 'ai-stream-end' && evt.data.actionId === 'practiceEvaluate'));
  });

  it('includes Practice UI controls in renderer.html while keeping existing controls intact', () => {
    const html = fs.readFileSync(
      path.join(__dirname, '..', 'src', 'windows', 'assistant', 'renderer.html'),
      'utf8'
    );
    assert.ok(html.includes('id="practice-domain-select"'));
    assert.ok(html.includes('id="practice-question-btn"'));
    assert.ok(html.includes('id="practice-evaluate-btn"'));
    assert.ok(html.includes('id="output-format-select"'));
    assert.ok(html.includes('id="setting-hide-from-screen-capture"'));
  });
});
