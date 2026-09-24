export function isTranscriptMessageType(type) {
  return type === 'voice' || type === 'voice-mic' || type === 'voice-system';
}

export function isScreenshotMessageType(type) {
  return type === 'screenshot';
}

export function isSystemMessageType(type) {
  return type === 'system';
}

export function isAiResponseMessageType(type) {
  return type === 'ai-response';
}

export function isResumeMessageType(type) {
  return type === 'resume' || type === 'cv';
}

export function isJobDescriptionMessageType(type) {
  return type === 'job-description' || type === 'jobDescription';
}

export function isMemoryMessageType(type) {
  return type === 'memory' || type === 'session-memory' || type === 'durable-note';
}

export function isPinnedContextMessageType(type) {
  return isResumeMessageType(type) || isJobDescriptionMessageType(type) || isMemoryMessageType(type);
}

export function canToggleAiForMessageType(type) {
  if (isPinnedContextMessageType(type)) {
    return true;
  }
  return isTranscriptMessageType(type) || isScreenshotMessageType(type) || isAiResponseMessageType(type);
}

export function defaultIncludeInAiForMessageType(type) {
  if (isSystemMessageType(type)) {
    return false;
  }
  return true;
}

/**
 * Pinned document/memory messages are never dropped by char-budget eviction.
 */
export function isBudgetProtectedMessageType(type) {
  return isPinnedContextMessageType(type);
}

export function contextLineForMessage(message) {
  const content = String(message?.content || '').trim();
  if (!content) return '';

  if (message.type === 'voice-system') return `Host: ${content}`;
  if (message.type === 'voice' || message.type === 'voice-mic') return `You: ${content}`;
  if (message.type === 'screenshot') {
    return message.screenshotId
      ? `Screenshot(${message.screenshotId}): ${content}`
      : `Screenshot: ${content}`;
  }
  if (message.type === 'ai-response') return `AI: ${content}`;
  if (isResumeMessageType(message.type)) return `Resume / CV (pinned): ${content}`;
  if (isJobDescriptionMessageType(message.type)) return `Job description (pinned): ${content}`;
  if (message.type === 'durable-note') return `Durable note (pinned): ${content}`;
  if (isMemoryMessageType(message.type)) return `Session memory: ${content}`;
  return '';
}

export function summaryLineForMessage(message) {
  const content = String(message?.content || '').trim().replace(/\s+/g, ' ');
  if (!content) return '';

  if (message.type === 'voice-system') return `Host said: ${content}`;
  if (message.type === 'voice' || message.type === 'voice-mic') return `You said: ${content}`;
  if (message.type === 'screenshot') return `Screenshot: ${content}`;
  if (message.type === 'ai-response') return `AI response: ${content}`;
  if (isResumeMessageType(message.type)) return `Pinned resume/CV available`;
  if (isJobDescriptionMessageType(message.type)) return `Pinned job description available`;
  if (message.type === 'durable-note') return `Pinned durable note: ${content}`;
  if (isMemoryMessageType(message.type)) return `Session memory: ${content}`;
  return '';
}
