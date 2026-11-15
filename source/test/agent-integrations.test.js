'use strict';

const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const { assertAiAdapter } = require('../src/services/ai/contracts');
const {
  CliAgentService,
  resolveCliAgentId,
  detectInstalledCliAgents
} = require('../src/services/ai/cli-agent-service');
const {
  writeIntegrationFiles,
  validateGeneratedFiles
} = require('../scripts/setup-agent-integrations');
const { createMobileServer } = require('../src/main-process/features/mobile-server/server');

function httpRequestJson(port, method, urlPath, body = null) {
  return new Promise((resolve, reject) => {
    const payload = body ? JSON.stringify(body) : null;
    const req = http.request(
      {
        host: '127.0.0.1',
        port,
        method,
        path: urlPath,
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
          resolve({
            statusCode: res.statusCode,
            body: JSON.parse(Buffer.concat(chunks).toString('utf8'))
          });
        });
      }
    );
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

describe('Outbound CLI agent adapters (Cursor, Claude Code, Antigravity, Codex)', () => {
  it('satisfies contracts.js assertAiAdapter across all 4 CLI profiles', async () => {
    const invocations = [];
    const expectedArgs = [
      ['claude-code', 'claude', ['-p']],
      ['codex', 'codex', ['exec']],
      ['agy', 'agy', ['chat', '--prompt']],
      ['cursor', 'cursor', ['agent', '--prompt']]
    ];

    for (const [alias, expectedBinary, prefixArgs] of expectedArgs) {
      const adapter = new CliAgentService({
        agent: alias,
        programmingLanguage: 'Python',
        runCommand: async (binary, args) => {
          invocations.push({ binary, args });
          return { stdout: `Response from ${binary}`, stderr: '' };
        }
      });

      assertAiAdapter(adapter, alias);
      const chunks = [];
      const output = await adapter.generateText('Explain idempotency.', {
        systemInstruction: 'Be concise.',
        onChunk: (chunk) => chunks.push(chunk.text)
      });

      assert.equal(output, `Response from ${expectedBinary}`);
      assert.equal(chunks.length, 1);
      const last = invocations[invocations.length - 1];
      assert.equal(last.binary, expectedBinary);
      assert.deepEqual(last.args.slice(0, prefixArgs.length), prefixArgs);
      assert.ok(last.args[prefixArgs.length].includes('Explain idempotency.'));
    }

    assert.equal(resolveCliAgentId('AGY'), 'antigravity');
  });

  it('tracks configuration updates, history, and error classifications', async () => {
    const service = new CliAgentService({
      agent: 'claude',
      runCommand: async () => ({ stdout: 'ok', stderr: '' })
    });

    const change = service.updateConfiguration({ agent: 'codex', programmingLanguage: 'Rust' });
    assert.equal(change.agentChanged, true);
    assert.equal(change.modelChanged, true);
    assert.equal(change.programmingLanguageChanged, true);
    assert.equal(service.model, 'cli:codex');

    service.addToHistory('user', 'Question');
    service.addToHistory('assistant', 'Answer');
    assert.ok(service.getContextString().includes('user: Question'));
    service.clearHistory();
    assert.equal(service.getContextString(), '');

    assert.equal(service.isQuotaExhaustedError(new Error('429 rate limit exceeded')), true);
    assert.equal(service.isAuthenticationError(new Error('Unauthorized API key')), true);
    assert.equal(service.isRetryableError(new Error('503 service temporarily unavailable')), true);

    const detected = await detectInstalledCliAgents(async (bin) => bin === 'claude' || bin === 'agy');
    assert.equal(detected.find((entry) => entry.id === 'claude').available, true);
    assert.equal(detected.find((entry) => entry.id === 'antigravity').available, true);
    assert.equal(detected.find((entry) => entry.id === 'cursor').available, false);
  });
});

describe('Agent integration generator & workspace templates', () => {
  it('writes and validates Cursor, Claude Code, Antigravity, and Codex configs into an isolated workspace', (t) => {
    const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'glassline-agents-'));
    t.after(() => fs.rmSync(tmpRoot, { recursive: true, force: true }));

    const files = writeIntegrationFiles({ repoRoot: tmpRoot, useAbsolute: false });
    assert.equal(files.length, 9);
    validateGeneratedFiles({ repoRoot: tmpRoot });

    const cursorConfig = JSON.parse(fs.readFileSync(path.join(tmpRoot, '.cursor', 'mcp.json'), 'utf8'));
    assert.equal(cursorConfig.mcpServers.glassline.command, 'node');
    assert.deepEqual(cursorConfig.mcpServers.glassline.args, ['source/scripts/run-mcp-server.js']);

    const codexToml = fs.readFileSync(path.join(tmpRoot, 'integrations', 'codex', 'config.toml'), 'utf8');
    assert.ok(codexToml.includes('[mcp_servers.glassline]'));

    const antigravitySkill = fs.readFileSync(
      path.join(tmpRoot, 'integrations', 'antigravity', 'SKILL.md'),
      'utf8'
    );
    assert.ok(antigravitySkill.includes('glassline_practice_evaluate_response'));
  });

  it('keeps committed repository agent integration files valid', () => {
    const repoRoot = path.resolve(__dirname, '..', '..');
    validateGeneratedFiles({ repoRoot });
  });
});

describe('Companion HTTP localhost REST bridge (/api/agent/*)', () => {
  it('serves status, context, question generation, and evaluation on loopback', async (t) => {
    const server = createMobileServer({
      disabled: false,
      port: 0,
      getGeminiRuntime: () => ({
        isAiReady: () => false,
        getService: () => null,
        getActiveAiProvider: () => 'gemini',
        getActiveProgrammingLanguage: () => 'Python'
      }),
      getScreenshotManager: () => ({ getScreenshotsCount: () => 0 }),
      notifyDesktop: () => {},
      getContextServices: () => ({
        documentService: {
          getPinnedDocumentTexts: () => ({ resume: 'Systems Eng Candidate', jobDescription: 'Distributed Platform' })
        },
        memoryService: {
          getDurableNotes: () => [{ id: 'n1', text: 'Explain failure modes clearly', status: 'approved' }]
        }
      }),
      getAppState: () => ({
        aiProvider: 'gemini',
        geminiModel: 'gemini-3.8-flash',
        interviewSessions: [{ id: 's1', archivedAt: '2026-01-01T00:00:00Z', title: 'Mock 1', summary: 'Caching' }]
      })
    });

    t.after(() => server.close());

    await new Promise((resolve) => {
      const check = () => {
        if (server.getStatus().listening) return resolve();
        setTimeout(check, 10);
      };
      check();
    });

    const port = server.getPort();
    assert.ok(port > 0);

    const statusRes = await httpRequestJson(port, 'GET', '/api/agent/status');
    assert.equal(statusRes.statusCode, 200);
    assert.equal(statusRes.body.ok, true);
    assert.equal(statusRes.body.service, 'glassline');

    const ctxRes = await httpRequestJson(port, 'GET', '/api/agent/context');
    assert.equal(ctxRes.statusCode, 200);
    assert.equal(ctxRes.body.resume, 'Systems Eng Candidate');
    assert.equal(ctxRes.body.durableNotes.length, 1);
    assert.equal(ctxRes.body.interviewSessions.length, 1);

    const qRes = await httpRequestJson(port, 'POST', '/api/agent/practice/question', {
      domain: 'coding',
      topic: 'LRU'
    });
    assert.equal(qRes.statusCode, 200);
    assert.equal(qRes.body.success, true);

    const evalRes = await httpRequestJson(port, 'POST', '/api/agent/practice/evaluate', {
      candidateAnswer:
        'First pair a hash map with a doubly linked list for O(1) latency, evicting tail entries at capacity and unlinking expired keys on reads.'
    });
    assert.equal(evalRes.statusCode, 200);
    assert.equal(evalRes.body.success, true);
    assert.ok(evalRes.body.evaluation.includes('## How to Respond Instead (Model Answer)'));

    const missingAnsRes = await httpRequestJson(port, 'POST', '/api/agent/practice/evaluate', {
      candidateAnswer: ''
    });
    assert.equal(missingAnsRes.statusCode, 400);
    assert.equal(missingAnsRes.body.ok, false);
  });
});
