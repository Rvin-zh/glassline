'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const prompts = require('../src/services/ai/prompts');
const { buildMemoryPrompt } = require('../src/services/ai/memory-service');

const {
  STATIC_PROMPT_VERSION,
  buildAnswerQuestionPrompt,
  buildAskAiSessionPrompt,
  buildCacheablePromptPrefix,
  buildFollowUpEmailPrompt,
  buildInsightsPrompt,
  buildMeetingNotesPrompt,
  buildPinnedContextBlock,
  buildScreenshotAnalysisPrompt,
  buildStaticSystemPrompt,
  buildSuggestResponsePrompt
} = prompts;

const NON_CODING_DOMAIN_SCOPE =
  'For system-design, behavioral, conceptual, conversational, and other domains:';
const CUE_ONLY_RULE = 'Output ONLY 2-4 Markdown bullet cue fragments.';
const CONTENT_SHAPE_RULE =
  'No full sentences, spoken dialogue or scripts, headings, or preamble.';
const WORD_LIMIT_RULE = 'Hard maximum: 30 words total.';
const GLANCEABLE_LENGTH_RULE = 'Use 3-7 words per bullet; target 20 words total.';
const CODING_EXEMPTION_RULE =
  'The 30-word limit applies only to non-coding answers; never cap coding answers.';
const SYSTEM_DESIGN_RULE =
  'Prioritize terse component and trade-off labels; for example: `- Cache: Redis (write-through)`.';
const DATA_FLOW_RULE = 'Do not require full data-flow prose.';

const livePromptBuilders = [
  ['static system', () => buildStaticSystemPrompt({ programmingLanguage: 'TypeScript' })],
  [
    'cacheable prefix',
    () => buildCacheablePromptPrefix({
      programmingLanguage: 'TypeScript',
      resume: 'Backend engineer',
      jobDescription: 'Design distributed systems'
    })
  ],
  [
    'Ask AI',
    () => buildAskAiSessionPrompt({
      contextString: 'Interviewer: Explain caching.',
      transcriptContext: 'Candidate: Sure.',
      programmingLanguage: 'TypeScript'
    })
  ],
  [
    'Screen AI',
    () => buildScreenshotAnalysisPrompt({
      additionalContext: 'Architecture diagram',
      programmingLanguage: 'TypeScript'
    })
  ],
  [
    'Suggest',
    () => buildSuggestResponsePrompt({
      transcriptContext: 'Interviewer: How would you scale this service?'
    })
  ],
  [
    'Answer Question',
    () => buildAnswerQuestionPrompt({
      question: 'What is eventual consistency?',
      programmingLanguage: 'TypeScript'
    })
  ]
];

function countOccurrences(content, expected) {
  return content.split(expected).length - 1;
}

describe('live answer prompt contract', () => {
  it('bumps the static cache contract for all output-format definitions', () => {
    assert.equal(STATIC_PROMPT_VERSION, 'static-v3');
  });

  for (const [name, buildPrompt] of livePromptBuilders) {
    it(`${name} requires concise non-coding cues`, () => {
      const prompt = buildPrompt();

      assert.ok(prompt.includes(NON_CODING_DOMAIN_SCOPE));
      assert.ok(prompt.includes(CUE_ONLY_RULE));
      assert.ok(prompt.includes(CONTENT_SHAPE_RULE));
      assert.ok(prompt.includes(GLANCEABLE_LENGTH_RULE));
      assert.ok(prompt.includes(WORD_LIMIT_RULE));
      assert.equal(countOccurrences(prompt, CUE_ONLY_RULE), 1);
    });

    it(`${name} keeps coding answers code-first and uncapped`, () => {
      const prompt = buildPrompt();

      assert.ok(prompt.includes('Start with the code, no introduction.'));
      assert.ok(prompt.includes(CODING_EXEMPTION_RULE));
    });

    it(`${name} gives terse system-design guidance`, () => {
      const prompt = buildPrompt();

      assert.ok(prompt.includes(SYSTEM_DESIGN_RULE));
      assert.ok(prompt.includes(DATA_FLOW_RULE));
    });
  }

  it('Ask AI and Screen AI inherit the same central contract', () => {
    const staticPrompt = buildStaticSystemPrompt({ programmingLanguage: 'Python' });
    const askPrompt = buildAskAiSessionPrompt({ programmingLanguage: 'Python' });
    const screenPrompt = buildScreenshotAnalysisPrompt({ programmingLanguage: 'Python' });

    for (const rule of [
      NON_CODING_DOMAIN_SCOPE,
      CUE_ONLY_RULE,
      CONTENT_SHAPE_RULE,
      GLANCEABLE_LENGTH_RULE,
      WORD_LIMIT_RULE,
      CODING_EXEMPTION_RULE,
      SYSTEM_DESIGN_RULE,
      DATA_FLOW_RULE
    ]) {
      assert.ok(staticPrompt.includes(rule));
      assert.ok(askPrompt.includes(rule));
      assert.ok(screenPrompt.includes(rule));
    }
  });

  it('Answer Question retains selected-language coding guidance', () => {
    const prompt = buildAnswerQuestionPrompt({
      question: 'Implement binary search.',
      programmingLanguage: 'TypeScript'
    });

    assert.ok(prompt.includes('Selected default programming language: TypeScript'));
    assert.ok(prompt.includes('```typescript'));
  });
});

describe('conflicting live-answer instructions', () => {
  const conflicts = [
    'one-sentence headline',
    '**Data flow:** numbered steps.',
    'Speakable answer in 3–6 sentences',
    '**Talking points:**',
    '1–2 paragraphs in plain English',
    'In one phrase:',
    'Reply in a single short sentence',
    'End with **Final answer:**',
    "I'm not sure what you're being asked.",
    '**Best response (say this):**',
    '2–4 sentences max.',
    '**Optional follow-ups:**',
    'The best response must be speakable',
    'Provide a clear, concise answer.'
  ];

  for (const [name, buildPrompt] of livePromptBuilders) {
    it(`${name} omits legacy prose and spoken-script formats`, () => {
      const prompt = buildPrompt();

      for (const conflict of conflicts) {
        assert.equal(prompt.includes(conflict), false, `Unexpected legacy instruction: ${conflict}`);
      }
    });
  }
});

describe('documentation and background prompt exclusions', () => {
  const documentationBuilders = [
    ['Meeting Notes', () => buildMeetingNotesPrompt({ transcriptContext: 'Meeting transcript' })],
    ['Insights', () => buildInsightsPrompt({ transcriptContext: 'Meeting transcript' })],
    ['Follow-up Email', () => buildFollowUpEmailPrompt({ contextString: 'Meeting transcript' })],
    ['memory JSON', () => buildMemoryPrompt({ transcript: 'Meeting transcript' })]
  ];

  for (const [name, buildPrompt] of documentationBuilders) {
    it(`${name} is not capped by the live-answer contract`, () => {
      const prompt = buildPrompt();

      assert.equal(prompt.includes(CUE_ONLY_RULE), false);
      assert.equal(prompt.includes(WORD_LIMIT_RULE), false);
      assert.equal(prompt.includes(CODING_EXEMPTION_RULE), false);
    });
  }

  it('retains each documentation action format', () => {
    assert.ok(buildMeetingNotesPrompt().includes('## Key Discussion Points'));
    assert.ok(buildInsightsPrompt().includes('## Key Themes'));
    assert.ok(buildFollowUpEmailPrompt().includes('Professional closing'));
    assert.ok(buildMemoryPrompt().includes('Return ONLY valid JSON'));
  });

  it('keeps pinned context content-only', () => {
    const block = buildPinnedContextBlock({
      resume: 'Backend engineer',
      jobDescription: 'Platform role',
      memorySummary: 'Discussed caching'
    });

    assert.ok(block.includes('Backend engineer'));
    assert.equal(block.includes(CUE_ONLY_RULE), false);
    assert.equal(block.includes(WORD_LIMIT_RULE), false);
  });
});
