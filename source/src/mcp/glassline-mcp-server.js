'use strict';

const crypto = require('crypto');
const http = require('http');
const { loadAppState, saveAppState, getAppStatePath } = require('../services/state/app-state');
const { GeminiService } = require('../services/ai/gemini-service');
const { PortkeyService } = require('../services/ai/portkey-service');
const {
  PRACTICE_DOMAINS,
  PRACTICE_DIFFICULTIES,
  createInterviewPracticeService
} = require('../services/ai/interview-practice');
const { detectInstalledCliAgents } = require('../services/ai/cli-agent-service');

const MCP_SERVER_INFO = Object.freeze({
  name: 'glassline-mcp',
  version: '1.2.0'
});

const DEFAULT_PROTOCOL_VERSION = '2024-11-05';
const DEFAULT_BRIDGE_PORT = 7823;

const MCP_TOOLS = Object.freeze([
  {
    name: 'glassline_get_session_context',
    description: 'Read Glassline session context including pinned resume/job context, approved study notes, archived practice sessions, and current mock-interview state.',
    inputSchema: {
      type: 'object',
      properties: {
        includeArchivedSessions: {
          type: 'boolean',
          description: 'Whether to include archived session summaries (defaults to true).'
        }
      }
    }
  },
  {
    name: 'glassline_practice_generate_question',
    description: 'Generate a tailored text-based mock interview question using Glassline context and track it as the active practice question.',
    inputSchema: {
      type: 'object',
      properties: {
        domain: {
          type: 'string',
          enum: Object.keys(PRACTICE_DOMAINS),
          description: 'Interview domain focus (mixed, coding, system-design, behavioral, conceptual).'
        },
        difficulty: {
          type: 'string',
          enum: [...PRACTICE_DIFFICULTIES],
          description: 'Target seniority level (junior, mid, senior, staff).'
        },
        topic: {
          type: 'string',
          description: 'Optional focus topic (e.g. LRU cache, distributed queues, ownership conflict).'
        },
        programmingLanguage: {
          type: 'string',
          description: 'Preferred language when coding applies (e.g. Python, TypeScript).'
        },
        allowOfflineFallback: {
          type: 'boolean',
          description: 'Fallback to built-in rubric bank when no cloud AI key is configured (defaults to true).'
        }
      }
    }
  },
  {
    name: 'glassline_practice_evaluate_response',
    description: 'Evaluate a candidate written interview answer and return rubric scoring, strengths/gaps, how to respond instead (model answer), and an actionable improvement plan.',
    inputSchema: {
      type: 'object',
      required: ['candidateAnswer'],
      properties: {
        question: {
          type: 'string',
          description: 'Interview question being answered (defaults to active session question when omitted).'
        },
        candidateAnswer: {
          type: 'string',
          description: 'The candidate written answer to evaluate and improve.'
        },
        domain: {
          type: 'string',
          enum: Object.keys(PRACTICE_DOMAINS)
        },
        difficulty: {
          type: 'string',
          enum: [...PRACTICE_DIFFICULTIES]
        },
        programmingLanguage: {
          type: 'string'
        },
        allowOfflineFallback: {
          type: 'boolean'
        }
      }
    }
  },
  {
    name: 'glassline_save_study_note',
    description: 'Save a durable study insight, weak-area takeaway, or improvement action item into Glassline persisted durable notes.',
    inputSchema: {
      type: 'object',
      required: ['note'],
      properties: {
        note: {
          type: 'string',
          description: 'Concise study takeaway or improvement action to remember across sessions.'
        },
        tag: {
          type: 'string',
          description: 'Optional topic tag such as system-design, star-story, or complexity.'
        }
      }
    }
  },
  {
    name: 'glassline_list_interview_sessions',
    description: 'List archived Glassline practice and review sessions stored in local state.',
    inputSchema: {
      type: 'object',
      properties: {}
    }
  },
  {
    name: 'glassline_bridge_status',
    description: 'Inspect Glassline MCP server readiness, local Electron companion bridge reachability (localhost:7823), AI provider readiness, and detected CLI agents (Cursor, Claude Code, Antigravity, Codex).',
    inputSchema: {
      type: 'object',
      properties: {}
    }
  }
]);

const MCP_RESOURCES = Object.freeze([
  {
    uri: 'glassline://context/profile',
    name: 'Glassline Candidate Context & Study Notes',
    description: 'Pinned resume, job description, and durable study notes stored by Glassline.',
    mimeType: 'application/json'
  },
  {
    uri: 'glassline://practice/current-session',
    name: 'Glassline Active Practice Session',
    description: 'Current mock-interview domain, active question, and evaluated turn history.',
    mimeType: 'application/json'
  }
]);

function httpJsonRequest({ host = '127.0.0.1', port, method = 'GET', pathName, body = null, timeoutMs = 800 }) {
  return new Promise((resolve, reject) => {
    const payload = body ? JSON.stringify(body) : null;
    const req = http.request(
      {
        host,
        port,
        method,
        path: pathName,
        timeout: timeoutMs,
        headers: payload
          ? {
            'Content-Type': 'application/json',
            'Content-Length': Buffer.byteLength(payload, 'utf8')
          }
          : {}
      },
      (res) => {
        const chunks = [];
        res.on('data', (chunk) => chunks.push(chunk));
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          try {
            resolve({ statusCode: res.statusCode, data: JSON.parse(text) });
          } catch (error) {
            reject(new Error(`Invalid JSON from Glassline companion: ${error.message}`));
          }
        });
      }
    );

    req.on('timeout', () => {
      req.destroy(new Error('Companion bridge request timed out'));
    });
    req.on('error', reject);

    if (payload) {
      req.write(payload);
    }
    req.end();
  });
}

function buildHeadlessAdapterFromState(appState = {}) {
  const provider = String(appState.aiProvider || process.env.GLASSLINE_AI_PROVIDER || 'gemini').toLowerCase();
  const language = appState.programmingLanguage || 'Python';

  if (provider === 'portkey') {
    const key = String(appState.portkeyApiKey || process.env.PORTKEY_API_KEY || '').trim();
    if (!key) return null;
    const service = new PortkeyService();
    const ok = service.initialize(key, appState.geminiModel, language, {
      provider: appState.portkeyProvider,
      baseUrl: appState.portkeyBaseUrl
    });
    return ok && service.isReady() ? service : null;
  }

  const keys = Array.isArray(appState.geminiApiKey)
    ? appState.geminiApiKey
    : [appState.geminiApiKey || process.env.GEMINI_API_KEY || ''];
  const activeIndex = Number.isInteger(appState.geminiApiKeyIndex) ? appState.geminiApiKeyIndex : 0;
  const activeKey = String(keys[activeIndex] || keys.find(Boolean) || '').trim();
  if (!activeKey) return null;

  const service = new GeminiService();
  const ok = service.initialize(activeKey, appState.geminiModel, language);
  return ok && service.isReady() ? service : null;
}

function createGlasslineMcpServer({
  app = null,
  bridgePort = Number(process.env.GLASSLINE_AGENT_PORT || DEFAULT_BRIDGE_PORT),
  probeLiveBridge = process.env.GLASSLINE_MCP_DISABLE_BRIDGE_PROBE !== '1',
  adapterOverride = undefined,
  detectAgents = detectInstalledCliAgents
} = {}) {
  let cachedAdapter = null;
  let cachedAdapterKey = '';

  function readSafeState() {
    try {
      return loadAppState(app) || {};
    } catch (_error) {
      return {};
    }
  }

  function resolveAdapter() {
    if (adapterOverride !== undefined) {
      return typeof adapterOverride === 'function' ? adapterOverride() : adapterOverride;
    }

    const state = readSafeState();
    const keyFingerprint = JSON.stringify([
      state.aiProvider,
      state.geminiModel,
      state.geminiApiKeyIndex,
      Array.isArray(state.geminiApiKey) ? state.geminiApiKey.length : Boolean(state.geminiApiKey),
      Boolean(state.portkeyApiKey),
      state.programmingLanguage
    ]);

    if (!cachedAdapter || cachedAdapterKey !== keyFingerprint) {
      cachedAdapter = buildHeadlessAdapterFromState(state);
      cachedAdapterKey = keyFingerprint;
    }
    return cachedAdapter;
  }

  const practiceService = createInterviewPracticeService({
    getAdapter: resolveAdapter,
    getContextTexts: () => {
      const state = readSafeState();
      return {
        resume: state.resumeText || '',
        jobDescription: state.jobDescriptionText || ''
      };
    },
    getProgrammingLanguage: () => readSafeState().programmingLanguage || 'Python'
  });

  async function tryCompanionBridge(method, pathName, body = null) {
    if (!probeLiveBridge || !bridgePort) {
      return null;
    }
    try {
      const response = await httpJsonRequest({
        port: bridgePort,
        method,
        pathName,
        body,
        timeoutMs: 900
      });
      if (response.statusCode >= 200 && response.statusCode < 300) {
        return response.data;
      }
      return null;
    } catch (_error) {
      return null;
    }
  }

  function formatToolResult(payload, textSummary = null) {
    const text = textSummary || JSON.stringify(payload, null, 2);
    return {
      content: [
        {
          type: 'text',
          text
        }
      ],
      structuredContent: payload,
      isError: payload?.success === false
    };
  }

  async function executeToolCall(name, args = {}) {
    switch (name) {
      case 'glassline_get_session_context': {
        const liveContext = await tryCompanionBridge('GET', '/api/agent/context');
        if (liveContext && liveContext.ok) {
          return formatToolResult({
            success: true,
            source: 'live-desktop-bridge',
            ...liveContext
          });
        }

        const state = readSafeState();
        const includeArchived = args.includeArchivedSessions !== false;
        const sessions = includeArchived && Array.isArray(state.interviewSessions)
          ? state.interviewSessions.map(({ id, archivedAt, title, summary }) => ({
            id,
            archivedAt,
            title,
            summary
          }))
          : [];

        return formatToolResult({
          success: true,
          source: 'local-state',
          resume: state.resumeText || '',
          jobDescription: state.jobDescriptionText || '',
          durableNotes: Array.isArray(state.durableNotes) ? state.durableNotes : [],
          interviewSessions: sessions,
          practiceState: practiceService.getState()
        });
      }

      case 'glassline_practice_generate_question': {
        const liveQuestion = await tryCompanionBridge('POST', '/api/agent/practice/question', args);
        if (liveQuestion && liveQuestion.success) {
          return formatToolResult(liveQuestion, liveQuestion.text || liveQuestion.question?.promptText);
        }

        const result = await practiceService.generateQuestion(args || {});
        return formatToolResult(
          result,
          result.success ? result.text : `Error: ${result.error}`
        );
      }

      case 'glassline_practice_evaluate_response': {
        const liveEval = await tryCompanionBridge('POST', '/api/agent/practice/evaluate', args);
        if (liveEval && liveEval.success) {
          return formatToolResult(liveEval, liveEval.evaluation || liveEval.text);
        }

        const result = await practiceService.evaluateResponse(args || {});
        return formatToolResult(
          result,
          result.success ? (result.evaluation || result.text) : `Error: ${result.error}`
        );
      }

      case 'glassline_save_study_note': {
        const noteText = String(args?.note || '').trim();
        if (!noteText) {
          return formatToolResult({ success: false, error: 'note is required' }, 'Error: note is required');
        }

        const currentState = readSafeState();
        const existingNotes = Array.isArray(currentState.durableNotes) ? currentState.durableNotes : [];
        const tagPrefix = args?.tag ? `[${String(args.tag).trim()}] ` : '';
        const newNote = {
          id: crypto.randomUUID(),
          text: `${tagPrefix}${noteText}`,
          status: 'approved',
          createdAt: new Date().toISOString(),
          source: 'mcp-agent'
        };
        const updatedNotes = [...existingNotes, newNote];
        saveAppState(app, { durableNotes: updatedNotes });

        return formatToolResult({
          success: true,
          savedNote: newNote,
          totalDurableNotes: updatedNotes.length
        });
      }

      case 'glassline_list_interview_sessions': {
        const state = readSafeState();
        const sessions = Array.isArray(state.interviewSessions)
          ? state.interviewSessions.map(({ id, archivedAt, title, summary }) => ({
            id,
            archivedAt,
            title,
            summary
          }))
          : [];
        return formatToolResult({
          success: true,
          count: sessions.length,
          sessions
        });
      }

      case 'glassline_bridge_status': {
        const liveStatus = await tryCompanionBridge('GET', '/api/agent/status');
        const cliAgents = await detectAgents();
        const adapter = resolveAdapter();
        return formatToolResult({
          success: true,
          server: MCP_SERVER_INFO,
          companionBridge: {
            reachable: Boolean(liveStatus?.ok),
            url: `http://127.0.0.1:${bridgePort}`,
            details: liveStatus || null
          },
          headlessAiReady: Boolean(adapter && adapter.isReady()),
          statePath: getAppStatePath(app),
          practiceState: practiceService.getState(),
          detectedCliAgents: cliAgents
        });
      }

      default:
        throw Object.assign(new Error(`Unknown MCP tool: ${name}`), { code: -32602 });
    }
  }

  async function readResource(uri) {
    if (uri === 'glassline://context/profile') {
      const state = readSafeState();
      return {
        contents: [
          {
            uri,
            mimeType: 'application/json',
            text: JSON.stringify(
              {
                resume: state.resumeText || '',
                jobDescription: state.jobDescriptionText || '',
                durableNotes: Array.isArray(state.durableNotes) ? state.durableNotes : [],
                programmingLanguage: state.programmingLanguage || 'Python'
              },
              null,
              2
            )
          }
        ]
      };
    }

    if (uri === 'glassline://practice/current-session') {
      return {
        contents: [
          {
            uri,
            mimeType: 'application/json',
            text: JSON.stringify(practiceService.getState(), null, 2)
          }
        ]
      };
    }

    throw Object.assign(new Error(`Unknown resource URI: ${uri}`), { code: -32602 });
  }

  async function handleJsonRpcMessage(message) {
    if (!message || typeof message !== 'object') {
      return {
        jsonrpc: '2.0',
        id: null,
        error: { code: -32600, message: 'Invalid Request' }
      };
    }

    const { id, method, params = {} } = message;
    const isNotification = id === undefined || id === null;

    try {
      let result;
      switch (method) {
        case 'initialize': {
          const clientProtocol = typeof params?.protocolVersion === 'string' && params.protocolVersion
            ? params.protocolVersion
            : DEFAULT_PROTOCOL_VERSION;
          result = {
            protocolVersion: clientProtocol,
            capabilities: {
              tools: { listChanged: false },
              resources: { subscribe: false, listChanged: false }
            },
            serverInfo: MCP_SERVER_INFO
          };
          break;
        }
        case 'notifications/initialized':
        case 'notifications/cancelled':
          return null;
        case 'ping':
          result = {};
          break;
        case 'tools/list':
          result = { tools: MCP_TOOLS };
          break;
        case 'tools/call':
          result = await executeToolCall(params?.name, params?.arguments || {});
          break;
        case 'resources/list':
          result = { resources: MCP_RESOURCES };
          break;
        case 'resources/read':
          result = await readResource(params?.uri);
          break;
        default: {
          if (isNotification) return null;
          return {
            jsonrpc: '2.0',
            id,
            error: { code: -32601, message: `Method not found: ${method}` }
          };
        }
      }

      if (isNotification) return null;
      return { jsonrpc: '2.0', id, result };
    } catch (error) {
      if (isNotification) return null;
      return {
        jsonrpc: '2.0',
        id,
        error: {
          code: typeof error?.code === 'number' ? error.code : -32603,
          message: error?.message || 'Internal MCP server error'
        }
      };
    }
  }

  function startStdio(input = process.stdin, output = process.stdout) {
    let buffer = Buffer.alloc(0);
    let responseFraming = null;

    function writeResponse(payload, framingMode) {
      const json = JSON.stringify(payload);
      if (framingMode === 'content-length') {
        const byteLen = Buffer.byteLength(json, 'utf8');
        output.write(`Content-Length: ${byteLen}\r\n\r\n${json}`);
      } else {
        output.write(`${json}\n`);
      }
    }

    async function processMessage(rawJson, framingMode) {
      let parsed;
      try {
        parsed = JSON.parse(rawJson);
      } catch (error) {
        writeResponse(
          {
            jsonrpc: '2.0',
            id: null,
            error: { code: -32700, message: `Parse error: ${error.message}` }
          },
          framingMode
        );
        return;
      }

      const reply = await handleJsonRpcMessage(parsed);
      if (reply) {
        writeResponse(reply, framingMode);
      }
    }

    function drainBuffer() {
      while (buffer.length > 0) {
        const headText = buffer.toString('utf8', 0, Math.min(buffer.length, 64));

        if (/^Content-Length:/i.test(headText)) {
          const headerEnd = buffer.indexOf('\r\n\r\n');
          if (headerEnd === -1) return;

          const headerBlock = buffer.slice(0, headerEnd).toString('utf8');
          const match = headerBlock.match(/Content-Length:\s*(\d+)/i);
          if (!match) {
            buffer = buffer.slice(headerEnd + 4);
            continue;
          }

          const contentLength = Number.parseInt(match[1], 10);
          const messageStart = headerEnd + 4;
          if (buffer.length < messageStart + contentLength) return;

          const body = buffer.slice(messageStart, messageStart + contentLength).toString('utf8');
          buffer = buffer.slice(messageStart + contentLength);
          responseFraming = responseFraming || 'content-length';
          void processMessage(body, 'content-length');
          continue;
        }

        const newlineIndex = buffer.indexOf('\n');
        if (newlineIndex === -1) return;

        const line = buffer.slice(0, newlineIndex).toString('utf8').replace(/\r$/, '').trim();
        buffer = buffer.slice(newlineIndex + 1);
        if (!line) continue;

        responseFraming = responseFraming || 'ndjson';
        void processMessage(line, 'ndjson');
      }
    }

    const onData = (chunk) => {
      const incoming = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk), 'utf8');
      buffer = Buffer.concat([buffer, incoming]);
      drainBuffer();
    };

    input.on('data', onData);
    return {
      stop() {
        input.off('data', onData);
      }
    };
  }

  return {
    MCP_SERVER_INFO,
    MCP_TOOLS,
    MCP_RESOURCES,
    practiceService,
    handleJsonRpcMessage,
    startStdio
  };
}

module.exports = {
  MCP_SERVER_INFO,
  MCP_TOOLS,
  MCP_RESOURCES,
  createGlasslineMcpServer
};
