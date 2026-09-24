const { buildPinnedContextBlock } = require('./prompts');

const DEFAULT_CHAR_BUDGET = 12000;
const DEFAULT_TOKEN_BUDGET = 3000;

function estimateTokens(text) {
  return Math.ceil(String(text || '').length / 4);
}

function normalizeNotes(notes) {
  if (!Array.isArray(notes)) {
    return [];
  }

  return notes
    .map((note) => {
      if (typeof note === 'string') {
        return { text: note.trim(), status: 'approved' };
      }
      if (note && typeof note === 'object') {
        return {
          text: String(note.text || note.content || '').trim(),
          status: note.status || 'approved'
        };
      }
      return null;
    })
    .filter((note) => note && note.text);
}

function formatMemorySummary(memorySummary) {
  if (!memorySummary) {
    return '';
  }
  if (typeof memorySummary === 'string') {
    return memorySummary.trim();
  }
  if (typeof memorySummary !== 'object') {
    return '';
  }

  const parts = [];
  if (memorySummary.currentTopic) {
    parts.push(`Current topic: ${memorySummary.currentTopic}`);
  }
  if (Array.isArray(memorySummary.questions) && memorySummary.questions.length) {
    parts.push(`Questions: ${memorySummary.questions.join('; ')}`);
  }
  if (Array.isArray(memorySummary.facts) && memorySummary.facts.length) {
    parts.push(`Facts: ${memorySummary.facts.join('; ')}`);
  }
  if (Array.isArray(memorySummary.candidateExamples) && memorySummary.candidateExamples.length) {
    parts.push(`Examples: ${memorySummary.candidateExamples.join('; ')}`);
  }
  if (Array.isArray(memorySummary.strengthsGaps) && memorySummary.strengthsGaps.length) {
    parts.push(`Strengths/gaps: ${memorySummary.strengthsGaps.join('; ')}`);
  }
  if (Array.isArray(memorySummary.commitments) && memorySummary.commitments.length) {
    parts.push(`Commitments: ${memorySummary.commitments.join('; ')}`);
  }
  return parts.join('\n').trim();
}

function normalizeSelectedInterviewSessions(sessions) {
  if (!Array.isArray(sessions)) {
    return [];
  }

  return sessions
    .map((session) => {
      if (!session || typeof session !== 'object' || Array.isArray(session)) {
        return null;
      }
      const title = typeof session.title === 'string' ? session.title.trim() : '';
      const summary = formatMemorySummary(session.summary);
      const notes = normalizeNotes(session.notes)
        .filter((note) => note.status === 'approved');
      if (!summary && notes.length === 0) {
        return null;
      }
      return { title, summary, notes };
    })
    .filter(Boolean);
}

function formatSelectedInterviewContext(sessions) {
  return sessions
    .map((session) => {
      const parts = [];
      if (session.title) {
        parts.push(session.title);
      }
      if (session.summary) {
        parts.push(session.summary);
      }
      if (session.notes.length > 0) {
        parts.push(
          `Approved notes:\n${session.notes.map(({ text }) => `- ${text}`).join('\n')}`
        );
      }
      return parts.join('\n');
    })
    .filter(Boolean)
    .join('\n\n');
}

function mergeApprovedNotes(...groups) {
  const merged = [];
  const seen = new Set();
  for (const group of groups) {
    for (const note of normalizeNotes(group)) {
      if (note.status !== 'approved') {
        continue;
      }
      const identity = note.text.toLocaleLowerCase('en-US');
      if (seen.has(identity)) {
        continue;
      }
      seen.add(identity);
      merged.push(note);
    }
  }
  return merged;
}

function truncateToBudget(text, budgetChars) {
  const value = String(text || '');
  if (!Number.isFinite(budgetChars) || budgetChars <= 0) {
    return '';
  }
  if (value.length <= budgetChars) {
    return value;
  }
  return `${value.slice(0, Math.max(0, budgetChars - 1)).trimEnd()}…`;
}

/**
 * Shared prioritized context assembler for desktop (and later mobile).
 * Priority: pinned docs → approved durable notes → session memory →
 * recent transcript → optional search → screenshots metadata.
 *
 * Mobile audience intentionally excludes CV and durable notes until pairing exists.
 */
function assembleContext(input = {}) {
  const audience = input.audience === 'mobile' ? 'mobile' : 'desktop';
  const charBudget = Number.isFinite(input.charBudget)
    ? input.charBudget
    : (Number.isFinite(input.tokenBudget)
      ? Math.floor(input.tokenBudget * 4)
      : DEFAULT_CHAR_BUDGET);
  const tokenBudget = Number.isFinite(input.tokenBudget)
    ? input.tokenBudget
    : Math.ceil(charBudget / 4);

  const includePinnedDocs = audience === 'desktop' && input.includePinnedDocs !== false;
  const includeDurableNotes = audience === 'desktop' && input.includeDurableNotes !== false;
  const includeSessionMemory = input.includeSessionMemory !== false;
  const includeTranscript = input.includeTranscript !== false;
  const includeSearch = input.includeSearch === true;
  const includeScreenshots = input.includeScreenshots !== false;

  const resume = includePinnedDocs ? String(input.resume || '').trim() : '';
  const jobDescription = includePinnedDocs ? String(input.jobDescription || '').trim() : '';
  const durableNotes = includeDurableNotes
    ? normalizeNotes(input.durableNotes).filter((note) => note.status === 'approved')
    : [];
  const memorySummary = includeSessionMemory
    ? formatMemorySummary(input.memorySummary || input.sessionMemory)
    : '';
  const selectedInterviewSessions = audience === 'desktop'
    ? normalizeSelectedInterviewSessions(input.selectedInterviewSessions)
    : [];
  const previousInterviewContext = formatSelectedInterviewContext(
    selectedInterviewSessions
  );
  const previousInterviewSummaries = selectedInterviewSessions
    .map((session) => {
      if (!session.summary) {
        return '';
      }
      return session.title
        ? `${session.title}\n${session.summary}`
        : session.summary;
    })
    .filter(Boolean)
    .join('\n\n');
  const promptMemorySummary = [memorySummary, previousInterviewSummaries]
    .filter(Boolean)
    .join('\n\n');
  const promptDurableNotes = audience === 'desktop'
    ? mergeApprovedNotes(
      durableNotes,
      selectedInterviewSessions.flatMap((session) => session.notes)
    )
    : [];
  const transcript = includeTranscript ? String(input.transcript || input.transcriptContext || '').trim() : '';
  const conversationHistory = String(input.contextString || input.conversationHistory || '').trim();
  const searchResults = includeSearch ? (input.searchResults || []) : [];
  const screenshotIds = includeScreenshots && Array.isArray(input.enabledScreenshotIds)
    ? input.enabledScreenshotIds.filter((id) => typeof id === 'string' && id.trim())
    : [];

  const sections = [];
  let usedChars = 0;
  const dropped = [];

  function tryAdd(label, content, { pinned = false } = {}) {
    const text = String(content || '').trim();
    if (!text) {
      return false;
    }

    const block = `${label}:\n${text}`;
    const cost = block.length + 2;

    if (!pinned && usedChars + cost > charBudget) {
      const remaining = Math.max(0, charBudget - usedChars - label.length - 3);
      if (remaining < 64) {
        dropped.push(label);
        return false;
      }
      const truncated = truncateToBudget(text, remaining);
      sections.push({ label, content: truncated, pinned, truncated: true });
      usedChars += label.length + truncated.length + 3;
      return true;
    }

    if (pinned && usedChars + cost > charBudget) {
      // Pinned sections are never budget-evicted; they may overflow the soft budget.
      sections.push({ label, content: text, pinned, truncated: false, overBudget: true });
      usedChars += cost;
      return true;
    }

    sections.push({ label, content: text, pinned, truncated: false });
    usedChars += cost;
    return true;
  }

  if (resume) {
    tryAdd('Resume / CV (pinned)', resume, { pinned: true });
  }
  if (jobDescription) {
    tryAdd('Job description (pinned)', jobDescription, { pinned: true });
  }
  if (durableNotes.length) {
    tryAdd(
      'Approved durable notes (pinned)',
      durableNotes.map((note) => `- ${note.text}`).join('\n'),
      { pinned: true }
    );
  }
  if (previousInterviewContext) {
    tryAdd(
      'Previous interviews (selected, pinned)',
      previousInterviewContext,
      { pinned: true }
    );
  }
  if (memorySummary) {
    tryAdd('Session memory', memorySummary);
  }
  if (transcript) {
    tryAdd('Recent transcript', transcript);
  }
  if (conversationHistory) {
    tryAdd('Conversation history', conversationHistory);
  }
  if (Array.isArray(searchResults) && searchResults.length) {
    const formatted = searchResults
      .map((result, index) => {
        if (typeof result === 'string') {
          return `${index + 1}. ${result}`;
        }
        const title = result?.title || result?.url || `Result ${index + 1}`;
        const url = result?.url ? ` (${result.url})` : '';
        const snippet = result?.snippet || result?.content || '';
        return `${index + 1}. ${title}${url}${snippet ? `\n${snippet}` : ''}`;
      })
      .join('\n');
    tryAdd('Web search results', formatted);
  }
  if (screenshotIds.length) {
    tryAdd('Enabled screenshots', screenshotIds.map((id) => `- ${id}`).join('\n'));
  }

  const pinnedBlock = buildPinnedContextBlock({
    resume,
    jobDescription,
    memorySummary: promptMemorySummary,
    durableNotes: promptDurableNotes.map((note) => note.text),
    searchResults: includeSearch ? searchResults : []
  });

  const contextString = sections
    .map((section) => `${section.label}:\n${section.content}`)
    .join('\n\n')
    .trim();

  return {
    audience,
    charBudget,
    tokenBudget,
    usedChars,
    usedTokens: estimateTokens(contextString),
    overBudget: usedChars > charBudget,
    dropped,
    sections,
    pinnedBlock,
    resume,
    jobDescription,
    memorySummary,
    durableNotes,
    previousInterviewContext,
    promptMemorySummary,
    promptDurableNotes,
    searchResults: includeSearch ? searchResults : [],
    transcriptContext: transcript,
    contextString,
    enabledScreenshotIds: screenshotIds,
    // Explicit privacy gate for mobile companion until pairing lands.
    excludedForMobile: audience === 'mobile'
      ? ['resume', 'jobDescription', 'durableNotes', 'interviewSessions']
      : []
  };
}

module.exports = {
  DEFAULT_CHAR_BUDGET,
  DEFAULT_TOKEN_BUDGET,
  estimateTokens,
  formatMemorySummary,
  assembleContext
};
