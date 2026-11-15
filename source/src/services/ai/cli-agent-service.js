'use strict';

const { execFile } = require('child_process');
const { promisify } = require('util');
const { assertAiAdapter } = require('./contracts');

const execFileAsync = promisify(execFile);

const CLI_AGENT_ALIASES = Object.freeze({
  claude: 'claude',
  'claude-code': 'claude',
  codex: 'codex',
  openai: 'codex',
  antigravity: 'antigravity',
  agy: 'antigravity',
  cursor: 'cursor'
});

const CLI_AGENT_PROFILES = Object.freeze({
  claude: Object.freeze({
    id: 'claude',
    label: 'Claude Code',
    binary: 'claude',
    buildArgs: (prompt) => ['-p', prompt]
  }),
  codex: Object.freeze({
    id: 'codex',
    label: 'OpenAI Codex CLI',
    binary: 'codex',
    buildArgs: (prompt) => ['exec', prompt]
  }),
  antigravity: Object.freeze({
    id: 'antigravity',
    label: 'Antigravity',
    binary: 'agy',
    buildArgs: (prompt) => ['chat', '--prompt', prompt]
  }),
  cursor: Object.freeze({
    id: 'cursor',
    label: 'Cursor Agent',
    binary: 'cursor',
    buildArgs: (prompt) => ['agent', '--prompt', prompt]
  })
});

function resolveCliAgentId(agent) {
  const normalized = String(agent || '').trim().toLowerCase();
  return CLI_AGENT_ALIASES[normalized] || 'claude';
}

function getCliAgentProfile(agent) {
  return CLI_AGENT_PROFILES[resolveCliAgentId(agent)];
}

async function defaultExecFileRunner(binary, args, { timeoutMs = 90_000, cwd = process.cwd() } = {}) {
  const { stdout, stderr } = await execFileAsync(binary, args, {
    timeout: timeoutMs,
    maxBuffer: 4 * 1024 * 1024,
    cwd
  });
  return {
    stdout: String(stdout || ''),
    stderr: String(stderr || '')
  };
}

async function defaultCheckBinaryAvailable(binary) {
  const lookupCommand = process.platform === 'win32' ? 'where' : 'which';
  try {
    const { stdout } = await execFileAsync(lookupCommand, [binary], { timeout: 3000 });
    return Boolean(String(stdout || '').trim());
  } catch (_error) {
    return false;
  }
}

async function detectInstalledCliAgents(checkBinaryAvailable = defaultCheckBinaryAvailable) {
  const entries = await Promise.all(
    Object.values(CLI_AGENT_PROFILES).map(async (profile) => ({
      id: profile.id,
      label: profile.label,
      binary: profile.binary,
      available: await BooleanPromise(checkBinaryAvailable(profile.binary))
    }))
  );
  return entries;
}

async function BooleanPromise(value) {
  try {
    return Boolean(await value);
  } catch (_error) {
    return false;
  }
}

class CliAgentService {
  constructor({
    agent = 'claude',
    programmingLanguage = 'Python',
    timeoutMs = 90_000,
    cwd = process.cwd(),
    readyOverride = null,
    runCommand = defaultExecFileRunner
  } = {}) {
    this.agentId = resolveCliAgentId(agent);
    this.profile = getCliAgentProfile(this.agentId);
    this.model = `cli:${this.agentId}`;
    this.modelName = this.model;
    this.programmingLanguage = String(programmingLanguage || 'Python');
    this.timeoutMs = Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : 90_000;
    this.cwd = cwd;
    this.runCommand = runCommand;
    this.conversationHistory = [];
    this.systemInstruction = '';
    this._ready = typeof readyOverride === 'boolean' ? readyOverride : true;

    assertAiAdapter(this, 'CliAgentService');
  }

  get capabilities() {
    return {
      supportsMultimodal: false,
      supportsStreaming: true,
      supportsGoogleSearch: false,
      supportsThinkingLevels: false,
      provider: 'cli-agent',
      agentId: this.agentId
    };
  }

  isReady() {
    return Boolean(this._ready && typeof this.runCommand === 'function');
  }

  setReady(ready) {
    this._ready = Boolean(ready);
  }

  updateConfiguration(options = {}) {
    const result = {
      apiKeyChanged: false,
      modelChanged: false,
      programmingLanguageChanged: false,
      agentChanged: false
    };

    if (options.agent) {
      const nextId = resolveCliAgentId(options.agent);
      if (nextId !== this.agentId) {
        this.agentId = nextId;
        this.profile = getCliAgentProfile(nextId);
        this.model = `cli:${nextId}`;
        this.modelName = this.model;
        result.modelChanged = true;
        result.agentChanged = true;
      }
    }

    if (options.programmingLanguage && options.programmingLanguage !== this.programmingLanguage) {
      this.programmingLanguage = String(options.programmingLanguage);
      result.programmingLanguageChanged = true;
    }

    if (typeof options.timeoutMs === 'number' && options.timeoutMs > 0) {
      this.timeoutMs = options.timeoutMs;
    }

    return result;
  }

  addToHistory(role, content) {
    this.conversationHistory.push({
      role: String(role || 'user'),
      content: String(content || '')
    });
    if (this.conversationHistory.length > 40) {
      this.conversationHistory = this.conversationHistory.slice(-40);
    }
  }

  clearHistory() {
    this.conversationHistory = [];
  }

  getContextString() {
    return this.conversationHistory
      .map((entry) => `${entry.role}: ${entry.content}`)
      .join('\n');
  }

  isQuotaExhaustedError(error) {
    const message = String(error?.message || error || '').toLowerCase();
    return /quota|rate limit|429|usage limit/.test(message);
  }

  isAuthenticationError(error) {
    const message = String(error?.message || error || '').toLowerCase();
    return /auth|unauthorized|401|login|not logged in|api key/.test(message);
  }

  isRetryableError(error) {
    const message = String(error?.message || error || '').toLowerCase();
    return /timeout|timed out|etimedout|econnreset|temporarily unavailable|503/.test(message);
  }

  async generateText(prompt, options = {}) {
    if (!this.isReady()) {
      throw new Error(`${this.profile.label} CLI adapter is not ready.`);
    }

    const systemPrefix = String(options.systemInstruction || this.systemInstruction || '').trim();
    const composedPrompt = systemPrefix
      ? `${systemPrefix}\n\n${String(prompt || '').trim()}`
      : String(prompt || '').trim();
    const args = this.profile.buildArgs(composedPrompt);

    const { stdout, stderr } = await this.runCommand(this.profile.binary, args, {
      timeoutMs: this.timeoutMs,
      cwd: this.cwd
    });

    const text = String(stdout || '').trim();
    if (!text) {
      const detail = String(stderr || '').trim();
      throw new Error(detail || `${this.profile.label} CLI returned empty output.`);
    }

    if (typeof options.onChunk === 'function') {
      options.onChunk({ text, index: 0 });
    }

    return text;
  }

  async generateMultimodal(parts = [], options = {}) {
    const textParts = Array.isArray(parts)
      ? parts
        .map((part) => (typeof part === 'string' ? part : part?.text || ''))
        .filter(Boolean)
      : [String(parts || '')];
    return this.generateText(textParts.join('\n'), options);
  }
}

module.exports = {
  CLI_AGENT_PROFILES,
  CLI_AGENT_ALIASES,
  CliAgentService,
  resolveCliAgentId,
  getCliAgentProfile,
  detectInstalledCliAgents
};
