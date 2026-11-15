'use strict';

const crypto = require('crypto');

const PRACTICE_DOMAINS = Object.freeze({
  mixed: Object.freeze({
    id: 'mixed',
    label: 'Mixed Interview',
    description: 'Alternates coding, system design, behavioral STAR, and core CS concepts'
  }),
  coding: Object.freeze({
    id: 'coding',
    label: 'Algorithms & Coding',
    description: 'Data structures, algorithmic complexity, and clean problem solving'
  }),
  'system-design': Object.freeze({
    id: 'system-design',
    label: 'System Design',
    description: 'Scalable architectures, consistency trade-offs, bottlenecks, and SLAs'
  }),
  behavioral: Object.freeze({
    id: 'behavioral',
    label: 'Behavioral (STAR)',
    description: 'Leadership, conflict resolution, ownership, and measurable impact'
  }),
  conceptual: Object.freeze({
    id: 'conceptual',
    label: 'CS & Architecture Concepts',
    description: 'Operating systems, networking, databases, concurrency, and language internals'
  })
});

const PRACTICE_DIFFICULTIES = Object.freeze(['junior', 'mid', 'senior', 'staff']);

const DEFAULT_PRACTICE_DOMAIN = 'mixed';
const DEFAULT_PRACTICE_DIFFICULTY = 'mid';

const OFFLINE_QUESTION_BANK = Object.freeze({
  coding: [
    {
      topic: 'Rate-Limited LRU Cache',
      promptText: [
        '## Practice Question',
        'Design and describe (or write in code) an **in-memory LRU cache** with per-key TTL expiration where `get(key)` and `put(key, value, ttlMs)` both run in $O(1)$ amortized time.',
        '',
        '### What the Interviewer Is Evaluating',
        '- Correct data-structure composition (hash map + doubly linked list or ordered map semantics)',
        '- Lazy vs active TTL eviction and memory-leak avoidance',
        '- Edge cases: capacity = 0, duplicate key updates, expired reads',
        '',
        '### Constraints & Follow-up Angles',
        '- Assume single-process concurrency up to 100k ops/sec',
        '- Follow-up: how would you shard this across multiple threads or nodes?',
        '',
        '*Type your written answer below and click **Coach & Plan** (or press Enter) to receive rubric feedback, how to respond instead, and an improvement plan.*'
      ].join('\n'),
      modelAnswer:
        'Combine a hash map (`key -> node`) with a doubly linked list ordered by recency. On `get(key)`, check if the node exists; if `now >= node.expiresAt`, unlink it from both structures and return `-1`. Otherwise move the node to the head in $O(1)$ and return its value. On `put(key, val, ttlMs)`, update existing nodes in place and move to head; for new keys, evict the tail node when at capacity before inserting at head. To avoid unbounded stale entries under low read rates, attach an optional amortized periodic sweep or min-heap by expiration timestamp.'
    },
    {
      topic: 'Task Scheduler with Cooldowns',
      promptText: [
        '## Practice Question',
        'Given a list of CPU task types and a non-negative cooldown interval `n` between identical tasks, how do you compute the **minimum total execution intervals** needed to finish all tasks?',
        '',
        '### What the Interviewer Is Evaluating',
        '- Recognizing greedy scheduling / frequency-bottleneck math vs heap simulation',
        '- Clear time & space complexity analysis ($O(T)$ where $T$ is number of tasks)',
        '- Edge cases: `n = 0`, ties for maximum frequency, idle slots completely filled',
        '',
        '### Constraints & Follow-up Angles',
        '- Input up to $10^5$ tasks; explain both the math formula and priority-queue + cooldown-queue simulation.',
        '',
        '*Type your written answer below and click **Coach & Plan** to receive rubric feedback and a model response.*'
      ].join('\n'),
      modelAnswer:
        'Identify `maxFreq = max(count)` and `numMax = count of tasks with maxFreq`. Placing the most frequent tasks first creates `(maxFreq - 1)` frames of length `(n + 1)`, plus a final partial frame of size `numMax`, giving `(maxFreq - 1) * (n + 1) + numMax`. If remaining distinct tasks fill all idle slots cleanly, the answer cannot be shorter than `tasks.length`, so return `Math.max(tasks.length, (maxFreq - 1) * (n + 1) + numMax)` in $O(N)$ time and $O(1)$ space over fixed task labels.'
    }
  ],
  'system-design': [
    {
      topic: 'Distributed Notification &Webhook Delivery Service',
      promptText: [
        '## Practice Question',
        'Design a **multi-tenant webhook / notification delivery pipeline** capable of delivering 50,000 events/second with at-least-once semantics, configurable retries, and customer visibility into failures.',
        '',
        '### What the Interviewer Is Evaluating',
        '- Decoupling ingestion from slow/failing downstream endpoints via partitioned message queues',
        '- Exponential backoff, dead-letter queues (DLQ), circuit breakers for noisy tenants, and idempotency keys',
        '- Storage separation between hot delivery state and append-only audit logs',
        '',
        '### Constraints & Follow-up Angles',
        '- Some subscriber endpoints time out after 5s — how do you stop one slow tenant from starving everyone else?',
        '',
        '*Type your written answer below and click **Coach & Plan** to get rubric scoring, how to respond instead, and an action plan.*'
      ].join('\n'),
      modelAnswer:
        'Start with requirements (50k/s throughput, <2s p95 enqueue latency, at-least-once delivery with idempotency HMAC headers). Place an API gateway in front of an ingestion service that validates payloads and publishes to partitioned Kafka/Pulsar topics keyed by `tenant_id` (plus fair-share per-tenant queues or isolated slow-lane pools so slow endpoints do not head-of-line block healthy tenants). Workers attempt HTTP delivery with strict timeouts, apply exponential backoff + jitter using delayed retry topics/Redis sorted sets, trip per-endpoint circuit breakers after consecutive 5xx/timeouts, and move exhausted events to a DLQ backed by Postgres/ClickHouse metadata for replay.'
    }
  ],
  behavioral: [
    {
      topic: 'Technical Disagreement & Trade-off Alignment',
      promptText: [
        '## Practice Question',
        'Tell me about a time you **strongly disagreed with a technical or architectural decision** made by a teammate, lead, or stakeholder. How did you handle it, what was the outcome, and what would you do differently today?',
        '',
        '### What the Interviewer Is Evaluating',
        '- Structured storytelling (**STAR**: Situation, Task, Action, Result)',
        '- Data-driven persuasion and empathy rather than ego or silent compliance',
        '- Clear ownership of measurable technical and team outcomes',
        '',
        '### Constraints & Follow-up Angles',
        '- Avoid vague generalizations ("we talked it out"); name the specific metrics, trade-offs, and concrete result.',
        '',
        '*Type your written answer below and click **Coach & Plan** to receive STAR feedback, a stronger rewrite, and a coaching plan.*'
      ].join('\n'),
      modelAnswer:
        'Use STAR explicitly: (S) On a backend ingestion service handling 12k req/min, a teammate proposed synchronous dual-writes to both Postgres and search indexes inside the request path. (T) My goal was keeping p99 write latency under 120ms without losing search consistency. (A) Rather than debating abstractly, I built a small failure-injection benchmark showing that transient search timeouts caused connection-pool exhaustion and partial failures; I presented a lightweight outbox-table alternative alongside a 2-day migration estimate in an RFC review. (R) We adopted the transactional outbox pattern, cutting p99 write latency by 38% and eliminating drift incidents over the next two quarters.'
    }
  ],
  conceptual: [
    {
      topic: 'Database Isolation Levels & Anomaly Prevention',
      promptText: [
        '## Practice Question',
        'Explain the practical difference between **Read Committed**, **Repeatable Read / Snapshot Isolation**, and **Serializable** isolation in relational databases. When can Snapshot Isolation still produce write skew, and how do you mitigate it?',
        '',
        '### What the Interviewer Is Evaluating',
        '- Precise distinction between dirty reads, non-repeatable reads, phantom reads, and write skew',
        '- Awareness of MVCC vs two-phase locking vs SSI (Serializable Snapshot Isolation)',
        '- Choosing locking (`SELECT ... FOR UPDATE`, atomic predicates) vs full Serializable overhead',
        '',
        '### Constraints & Follow-up Angles',
        '- Give one concrete real-world example of write skew (e.g., on-call doctor scheduling or account balance checks).',
        '',
        '*Type your written answer below and click **Coach & Plan** to get detailed coaching and a model answer.*'
      ].join('\n'),
      modelAnswer:
        'Read Committed prevents dirty reads by reading only committed snapshots per statement; two statements in one transaction can still see different committed states. Snapshot Isolation (MVCC) gives a transaction a consistent point-in-time view at start, preventing non-repeatable reads and lost updates on the same row, yet two concurrent transactions reading disjoint rows and asserting a shared invariant can commit a **write skew** (e.g., two on-call doctors simultaneously going off-duty because each sees the other still on call). Mitigation options are `SELECT ... FOR UPDATE` / materialized lock rows, conditional constraints, or Serializable Snapshot Isolation (SSI), which tracks rw-antidependencies and aborts conflicting cycles with retry logic.'
    }
  ]
});

function resolvePracticeDomain(domain) {
  const normalized = String(domain || '').trim().toLowerCase();
  if (Object.prototype.hasOwnProperty.call(PRACTICE_DOMAINS, normalized)) {
    return normalized;
  }
  return DEFAULT_PRACTICE_DOMAIN;
}

function resolvePracticeDifficulty(difficulty) {
  const normalized = String(difficulty || '').trim().toLowerCase();
  if (PRACTICE_DIFFICULTIES.includes(normalized)) {
    return normalized;
  }
  return DEFAULT_PRACTICE_DIFFICULTY;
}

function normalizeOptionalText(value, maxChars = 4000) {
  const trimmed = String(value || '').trim();
  if (!trimmed) {
    return '';
  }
  return trimmed.length > maxChars ? `${trimmed.slice(0, maxChars)}\n[truncated]` : trimmed;
}

function buildPracticeQuestionPrompt({
  domain = DEFAULT_PRACTICE_DOMAIN,
  difficulty = DEFAULT_PRACTICE_DIFFICULTY,
  topic = '',
  programmingLanguage = 'Python',
  resumeContext = '',
  jobDescriptionContext = '',
  previousQuestions = []
} = {}) {
  const safeDomain = resolvePracticeDomain(domain);
  const safeDifficulty = resolvePracticeDifficulty(difficulty);
  const domainInfo = PRACTICE_DOMAINS[safeDomain];
  const cleanTopic = normalizeOptionalText(topic, 300);
  const cleanResume = normalizeOptionalText(resumeContext, 2500);
  const cleanJob = normalizeOptionalText(jobDescriptionContext, 2500);
  const recentQuestions = Array.isArray(previousQuestions)
    ? previousQuestions.map((item) => normalizeOptionalText(item, 240)).filter(Boolean).slice(-6)
    : [];

  const parts = [
    'You are an experienced technical interviewer and academic career coach running an offline, text-based **Interactive Interview Practice** session.',
    'Generate ONE realistic, thought-provoking interview question tailored to the candidate profile below so the candidate can practice typing a full response and receive structured coaching.',
    '',
    `Practice Domain: ${domainInfo.label} (${domainInfo.id}) — ${domainInfo.description}`,
    `Difficulty Level: ${safeDifficulty}`,
    `Preferred Programming Language (if coding applies): ${programmingLanguage || 'Python'}`
  ];

  if (cleanTopic) {
    parts.push(`Requested Focus / Topic: ${cleanTopic}`);
  }
  if (cleanJob) {
    parts.push('', 'Target Role / Job Description Context:', cleanJob);
  }
  if (cleanResume) {
    parts.push('', 'Candidate Resume / Academic Background Context:', cleanResume);
  }
  if (recentQuestions.length > 0) {
    parts.push('', 'Do NOT repeat any of these previously asked questions:', ...recentQuestions.map((q, idx) => `${idx + 1}. ${q}`));
  }

  parts.push(
    '',
    'Format your response in clean Markdown with these exact sections:',
    '## Practice Question',
    '- State a single clear, self-contained interview question. Do NOT include the solution yet.',
    '### What the Interviewer Is Evaluating',
    '- 2 to 3 concise bullets naming concrete signals.',
    '### Constraints & Follow-up Angles',
    '- 1 to 2 bullets on scope, scale, or edge cases.',
    'End with a one-line prompt inviting the candidate to write their response.'
  );

  return parts.join('\n');
}

function buildPracticeEvaluationPrompt({
  question = '',
  candidateAnswer = '',
  domain = DEFAULT_PRACTICE_DOMAIN,
  difficulty = DEFAULT_PRACTICE_DIFFICULTY,
  programmingLanguage = 'Python',
  resumeContext = '',
  jobDescriptionContext = '',
  sessionHistory = []
} = {}) {
  const safeDomain = resolvePracticeDomain(domain);
  const safeDifficulty = resolvePracticeDifficulty(difficulty);
  const cleanQuestion = normalizeOptionalText(question, 2500) || '(General interview practice turn)';
  const cleanAnswer = normalizeOptionalText(candidateAnswer, 6000);
  const cleanResume = normalizeOptionalText(resumeContext, 2000);
  const cleanJob = normalizeOptionalText(jobDescriptionContext, 2000);

  const parts = [
    'You are an expert technical interviewer and academic career coach evaluating a candidate response during a **text-based mock interview practice session**.',
    'Your job is to give honest, specific feedback, rewrite how the candidate should respond instead, and provide an actionable improvement plan.',
    '',
    `Domain: ${PRACTICE_DOMAINS[safeDomain].label} (${safeDomain})`,
    `Target Level: ${safeDifficulty}`,
    `Preferred Language: ${programmingLanguage || 'Python'}`,
    '',
    'Interviewer Question:',
    cleanQuestion,
    '',
    'Candidate Text Response:',
    cleanAnswer || '(Candidate submitted an empty response)'
  ];

  if (cleanJob) {
    parts.push('', 'Target Role / Context:', cleanJob);
  }
  if (cleanResume) {
    parts.push('', 'Candidate Resume / Academic Projects:', cleanResume);
  }
  if (Array.isArray(sessionHistory) && sessionHistory.length > 0) {
    const recentSummary = sessionHistory
      .slice(-3)
      .map((turn, idx) => `Turn ${idx + 1}: Q="${normalizeOptionalText(turn.question, 140)}" -> Score note=${normalizeOptionalText(turn.summary || 'reviewed', 120)}`)
      .join('\n');
    parts.push('', 'Recent Practice Turns:', recentSummary);
  }

  parts.push(
    '',
    'Write thorough, constructive coaching using EXACTLY these four Markdown headings:',
    '## Evaluation & Rubric Score',
    '- Give an overall score `X/10` plus concise ratings across Clarity, Technical Depth, Structure, and Completeness.',
    '',
    '## Strengths & Gaps',
    '- Bullet what the candidate did well.',
    '- Bullet specific missing trade-offs, edge cases, complexity details, or vague phrasing.',
    '',
    '## How to Respond Instead (Model Answer)',
    '- Provide a concrete, interview-ready rewritten answer the candidate can model (if behavioral, use clear STAR framing; if coding/system design, include clean approach, complexity/trade-offs, and idiomatic code in the preferred language when helpful).',
    '',
    '## Actionable Improvement Plan',
    '- 3 to 4 concrete next steps: what to study, a 15-minute deliberate-practice drill, and 1 follow-up question to practice next.'
  );

  return parts.join('\n');
}

function selectOfflineQuestion({ domain, topic, askedQuestions = [] }) {
  const effectiveDomain = domain === 'mixed'
    ? ['coding', 'system-design', 'behavioral', 'conceptual'][askedQuestions.length % 4]
    : domain;
  const pool = OFFLINE_QUESTION_BANK[effectiveDomain] || OFFLINE_QUESTION_BANK.coding;
  const unused = pool.find((entry) => !askedQuestions.includes(entry.topic));
  const picked = unused || pool[askedQuestions.length % pool.length];

  const promptText = topic
    ? picked.promptText.replace(
      '## Practice Question',
      `## Practice Question — Focus: ${String(topic).trim()}`
    )
    : picked.promptText;

  return {
    domain: effectiveDomain,
    topic: topic ? String(topic).trim() : picked.topic,
    promptText,
    modelAnswer: picked.modelAnswer
  };
}

function scoreOfflineAnswer({ question, candidateAnswer, domain }) {
  const text = String(candidateAnswer || '').trim();
  const words = text ? text.split(/\s+/).length : 0;
  const lower = text.toLowerCase();

  let score = 4;
  const strengths = [];
  const gaps = [];

  if (words >= 35) {
    score += 2;
    strengths.push(`Substantive explanation (${words} words) rather than a one-line fragment.`);
  } else {
    gaps.push(`Response is very brief (${words} words); interviewers expect step-by-step reasoning and concrete specifics.`);
  }

  const hasStructure = /(first|second|then|because|trade-?off|situation|task|action|result|step|\n-|\n1\.)/i.test(text);
  if (hasStructure) {
    score += 1;
    strengths.push('Shows structured reasoning or ordered transitions.');
  } else {
    gaps.push('Lacks explicit structure (e.g., Problem -> Approach -> Complexity/Trade-offs, or STAR for behavioral).');
  }

  const hasMetricsOrComplexity = /(o\(|latency|throughput|qps|p99|memory|percent|%|ms|sec|retry|evict|sharding|index|lock|consistent)/i.test(lower);
  if (hasMetricsOrComplexity) {
    score += 2;
    strengths.push('References concrete technical mechanisms, metrics, or complexity bounds.');
  } else {
    gaps.push('Add measurable details: time/space complexity, latency/scale targets, failure modes, or quantifiable impact.');
  }

  const hasEdgeCases = /(edge|empty|timeout|fail|null|overflow|concurrent|race|duplicate|stale)/i.test(lower);
  if (hasEdgeCases) {
    score += 1;
    strengths.push('Considers failure modes or boundary conditions.');
  } else {
    gaps.push('Address edge cases and failure modes (timeouts, concurrency, empty/null inputs, or capacity limits).');
  }

  score = Math.max(1, Math.min(10, score));
  if (strengths.length === 0) {
    strengths.push('Clear willingness to engage directly with the prompt.');
  }

  const bankMatches = Object.values(OFFLINE_QUESTION_BANK).flat();
  const matchedEntry = bankMatches.find((entry) =>
    question && (question.includes(entry.topic) || question.includes(entry.promptText.slice(0, 60)))
  );
  const referenceModelAnswer = matchedEntry?.modelAnswer || (
    domain === 'behavioral'
      ? 'Frame your response with explicit **STAR** headings: state the concrete **Situation** and stakes, clarify your specific **Task**, walk through 2–3 high-leverage **Actions** you personally drove (including data/trade-offs considered), and close with a quantified **Result** and reflection.'
      : 'Open with clarifying assumptions and constraints, present a clear baseline design/algorithm first, state time/space complexity or bottleneck math, discuss trade-offs between alternatives, and verify 2–3 edge cases or failure scenarios.'
  );

  return [
    '## Evaluation & Rubric Score',
    `- **Overall Score:** ${score}/10 *(Built-in Heuristic Rubric — configure Gemini, Portkey, or a connected CLI agent for full LLM coaching)*`,
    `- **Length & Clarity:** ${words >= 35 ? 'Adequate depth' : 'Too brief'} (${words} words)`,
    `- **Structure & Signals:** ${hasStructure ? 'Structured' : 'Needs clearer framing'} | ${hasMetricsOrComplexity ? 'Concrete technical signals' : 'Missing metrics/complexity'}`,
    '',
    '## Strengths & Gaps',
    '**Strengths:**',
    ...strengths.map((item) => `- ${item}`),
    '',
    '**Gaps to Close:**',
    ...gaps.map((item) => `- ${item}`),
    '',
    '## How to Respond Instead (Model Answer)',
    referenceModelAnswer,
    '',
    '## Actionable Improvement Plan',
    '1. **Rewrite Immediately (5 min):** Re-type your answer incorporating the missing signals above (structure + edge cases + metrics/complexity).',
    '2. **Targeted Drill (10 min):** Practice explaining one concrete failure mode or trade-off out loud and in writing without filler words.',
    '3. **Verify Depth:** Test your revised response against a follow-up question such as: *"What breaks first at 10x scale, and how would you observe it?"*'
  ].join('\n');
}

function createInterviewPracticeService({
  getAdapter = () => null,
  executeWithAdapter = null,
  getContextTexts = () => ({ resume: '', jobDescription: '' }),
  getProgrammingLanguage = () => 'Python'
} = {}) {
  const state = {
    domain: DEFAULT_PRACTICE_DOMAIN,
    difficulty: DEFAULT_PRACTICE_DIFFICULTY,
    currentQuestion: null,
    turns: [],
    askedTopics: []
  };

  function getState() {
    return {
      domain: state.domain,
      difficulty: state.difficulty,
      currentQuestion: state.currentQuestion ? { ...state.currentQuestion } : null,
      turnsCount: state.turns.length,
      turns: state.turns.map((turn) => ({ ...turn })),
      askedTopics: [...state.askedTopics]
    };
  }

  function resetSession() {
    state.currentQuestion = null;
    state.turns = [];
    state.askedTopics = [];
    return {
      success: true,
      state: getState()
    };
  }

  function resolveAdapterInfo() {
    const adapter = typeof getAdapter === 'function' ? getAdapter() : null;
    const ready = Boolean(adapter && typeof adapter.isReady === 'function' && adapter.isReady());
    return { adapter, ready };
  }

  async function runTextGeneration(adapter, prompt, { executionContext, onChunk } = {}) {
    const invoke = async (activeAdapter) => {
      const requestOptions = {};
      if (typeof onChunk === 'function') {
        requestOptions.onChunk = onChunk;
      }
      if (executionContext && typeof activeAdapter.runWithExecutionContext === 'function') {
        return activeAdapter.runWithExecutionContext(
          executionContext,
          () => activeAdapter.generateText(prompt, requestOptions)
        );
      }
      return activeAdapter.generateText(prompt, requestOptions);
    };

    if (typeof executeWithAdapter === 'function') {
      return executeWithAdapter(invoke);
    }
    return invoke(adapter);
  }

  async function generateQuestion({
    domain = state.domain,
    difficulty = state.difficulty,
    topic = '',
    programmingLanguage,
    resumeContext,
    jobDescriptionContext,
    allowOfflineFallback = true,
    executionContext = null,
    onChunk = null
  } = {}) {
    const safeDomain = resolvePracticeDomain(domain);
    const safeDifficulty = resolvePracticeDifficulty(difficulty);
    state.domain = safeDomain;
    state.difficulty = safeDifficulty;

    const pinned = typeof getContextTexts === 'function' ? (getContextTexts() || {}) : {};
    const effectiveResume = resumeContext !== undefined ? resumeContext : (pinned.resume || '');
    const effectiveJob = jobDescriptionContext !== undefined ? jobDescriptionContext : (pinned.jobDescription || '');
    const effectiveLang = programmingLanguage || (typeof getProgrammingLanguage === 'function' ? getProgrammingLanguage() : 'Python');
    const { adapter, ready } = resolveAdapterInfo();

    if (!ready) {
      if (!allowOfflineFallback) {
        return {
          success: false,
          error: 'No AI provider is configured for interview practice.'
        };
      }

      const selected = selectOfflineQuestion({
        domain: safeDomain,
        topic,
        askedQuestions: state.askedTopics
      });
      if (selected.topic && !state.askedTopics.includes(selected.topic)) {
        state.askedTopics.push(selected.topic);
      }

      const questionRecord = {
        id: crypto.randomUUID(),
        domain: safeDomain,
        resolvedDomain: selected.domain,
        difficulty: safeDifficulty,
        topic: selected.topic,
        promptText: selected.promptText,
        createdAt: new Date().toISOString()
      };
      state.currentQuestion = questionRecord;

      return {
        success: true,
        question: { ...questionRecord },
        text: selected.promptText,
        offline: true,
        provider: 'offline-rubric',
        model: 'built-in-question-bank',
        state: getState()
      };
    }

    const prompt = buildPracticeQuestionPrompt({
      domain: safeDomain,
      difficulty: safeDifficulty,
      topic,
      programmingLanguage: effectiveLang,
      resumeContext: effectiveResume,
      jobDescriptionContext: effectiveJob,
      previousQuestions: state.turns.map((turn) => turn.question).concat(
        state.currentQuestion ? [state.currentQuestion.promptText] : []
      )
    });

    const text = String(await runTextGeneration(adapter, prompt, { executionContext, onChunk }) || '').trim();
    const questionRecord = {
      id: crypto.randomUUID(),
      domain: safeDomain,
      resolvedDomain: safeDomain,
      difficulty: safeDifficulty,
      topic: normalizeOptionalText(topic, 120) || PRACTICE_DOMAINS[safeDomain].label,
      promptText: text,
      createdAt: new Date().toISOString()
    };
    state.currentQuestion = questionRecord;
    if (questionRecord.topic && !state.askedTopics.includes(questionRecord.topic)) {
      state.askedTopics.push(questionRecord.topic);
    }

    return {
      success: true,
      question: { ...questionRecord },
      text,
      offline: false,
      provider: adapter.modelName ? 'llm' : 'ai-adapter',
      model: adapter.model || adapter.modelName || null,
      state: getState()
    };
  }

  async function evaluateResponse({
    question = '',
    candidateAnswer = '',
    domain = state.domain,
    difficulty = state.difficulty,
    programmingLanguage,
    resumeContext,
    jobDescriptionContext,
    allowOfflineFallback = true,
    executionContext = null,
    onChunk = null
  } = {}) {
    const cleanAnswer = String(candidateAnswer || '').trim();
    if (!cleanAnswer) {
      return {
        success: false,
        error: 'Provide your written interview response before requesting evaluation and coaching.'
      };
    }

    const safeDomain = resolvePracticeDomain(domain);
    const safeDifficulty = resolvePracticeDifficulty(difficulty);
    const effectiveQuestion = String(question || '').trim() || state.currentQuestion?.promptText || '';
    if (!effectiveQuestion) {
      return {
        success: false,
        error: 'No active practice question found. Generate or provide an interview question first.'
      };
    }

    const pinned = typeof getContextTexts === 'function' ? (getContextTexts() || {}) : {};
    const effectiveResume = resumeContext !== undefined ? resumeContext : (pinned.resume || '');
    const effectiveJob = jobDescriptionContext !== undefined ? jobDescriptionContext : (pinned.jobDescription || '');
    const effectiveLang = programmingLanguage || (typeof getProgrammingLanguage === 'function' ? getProgrammingLanguage() : 'Python');
    const { adapter, ready } = resolveAdapterInfo();

    let evaluationText = '';
    let offline = false;
    let provider = 'llm';
    let model = null;

    if (!ready) {
      if (!allowOfflineFallback) {
        return {
          success: false,
          error: 'No AI provider is configured to evaluate this practice response.'
        };
      }
      evaluationText = scoreOfflineAnswer({
        question: effectiveQuestion,
        candidateAnswer: cleanAnswer,
        domain: safeDomain
      });
      offline = true;
      provider = 'offline-rubric';
      model = 'built-in-heuristic-coach';
    } else {
      const prompt = buildPracticeEvaluationPrompt({
        question: effectiveQuestion,
        candidateAnswer: cleanAnswer,
        domain: safeDomain,
        difficulty: safeDifficulty,
        programmingLanguage: effectiveLang,
        resumeContext: effectiveResume,
        jobDescriptionContext: effectiveJob,
        sessionHistory: state.turns
      });
      evaluationText = String(await runTextGeneration(adapter, prompt, { executionContext, onChunk }) || '').trim();
      model = adapter.model || adapter.modelName || null;
      provider = 'llm';
    }

    const turnRecord = {
      id: crypto.randomUUID(),
      domain: safeDomain,
      difficulty: safeDifficulty,
      question: effectiveQuestion,
      candidateAnswer: cleanAnswer,
      evaluation: evaluationText,
      offline,
      evaluatedAt: new Date().toISOString()
    };
    state.turns.push(turnRecord);
    if (state.turns.length > 50) {
      state.turns = state.turns.slice(-50);
    }

    return {
      success: true,
      turnId: turnRecord.id,
      question: effectiveQuestion,
      candidateAnswer: cleanAnswer,
      text: evaluationText,
      evaluation: evaluationText,
      offline,
      provider,
      model,
      state: getState()
    };
  }

  return {
    PRACTICE_DOMAINS,
    PRACTICE_DIFFICULTIES,
    getState,
    resetSession,
    generateQuestion,
    evaluateResponse
  };
}

module.exports = {
  PRACTICE_DOMAINS,
  PRACTICE_DIFFICULTIES,
  DEFAULT_PRACTICE_DOMAIN,
  DEFAULT_PRACTICE_DIFFICULTY,
  OFFLINE_QUESTION_BANK,
  resolvePracticeDomain,
  resolvePracticeDifficulty,
  buildPracticeQuestionPrompt,
  buildPracticeEvaluationPrompt,
  scoreOfflineAnswer,
  createInterviewPracticeService
};
