/**
 * Provider-neutral AI service contract (duck-typed).
 *
 * Adapters (Gemini and Portkey) implement I/O only.
 * High-level ask/suggest/notes/insights/screenshot flows live in assistant-facade.js.
 *
 * Required adapter surface:
 * - isReady(): boolean
 * - model | modelName: string (active model id)
 * - programmingLanguage: string
 * - conversationHistory: Array<{ role, content }>
 * - generateText(prompt, options?: { onChunk?, systemInstruction?, thinkingLevel?, webSearchEnabled? }): Promise<string>
 * - generateMultimodal(parts, options?: same): Promise<string>
 * - updateConfiguration(options): { apiKeyChanged?, modelChanged?, programmingLanguageChanged?, ... }
 * - addToHistory(role, content): void
 * - clearHistory(): void
 * - getContextString(): string
 * - isQuotaExhaustedError(error): boolean
 * - isAuthenticationError(error): boolean
 * - isRetryableError(error): boolean
 * - capabilities: {
 *     supportsMultimodal: boolean,
 *     supportsStreaming: boolean,
 *     supportsGoogleSearch: boolean,
 *     supportsThinkingLevels: boolean,
 *     provider: 'gemini' | 'portkey'
 *   }
 *
 * Optional:
 * - systemInstruction: string
 * - thinkingLevel: string
 * - webSearchEnabled: boolean
 */

const AI_ADAPTER_METHODS = [
  'isReady',
  'generateText',
  'generateMultimodal',
  'updateConfiguration',
  'addToHistory',
  'clearHistory',
  'getContextString',
  'isQuotaExhaustedError',
  'isAuthenticationError',
  'isRetryableError'
];

function assertAiAdapter(adapter, label = 'AI adapter') {
  if (!adapter || typeof adapter !== 'object') {
    throw new Error(`${label} must be an object.`);
  }

  for (const methodName of AI_ADAPTER_METHODS) {
    if (typeof adapter[methodName] !== 'function') {
      throw new Error(`${label} is missing required method: ${methodName}()`);
    }
  }

  if (!adapter.capabilities || typeof adapter.capabilities !== 'object') {
    throw new Error(`${label} is missing capabilities object.`);
  }

  return adapter;
}

module.exports = {
  AI_ADAPTER_METHODS,
  assertAiAdapter
};
