#!/usr/bin/env node
'use strict';

const assert = require('assert');
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const SOURCE_DIR = path.resolve(__dirname, '..');
const REPO_ROOT = path.resolve(SOURCE_DIR, '..');
const RELATIVE_MCP_ENTRY = 'source/scripts/run-mcp-server.js';
const ABSOLUTE_MCP_ENTRY = path.join(SOURCE_DIR, 'scripts', 'run-mcp-server.js');

function buildMcpJsonConfig({ useAbsolute = false } = {}) {
  const entryPath = useAbsolute ? ABSOLUTE_MCP_ENTRY : RELATIVE_MCP_ENTRY;
  return {
    mcpServers: {
      glassline: {
        command: 'node',
        args: [entryPath],
        env: {
          GLASSLINE_AGENT_PORT: '7823'
        }
      }
    }
  };
}

function buildCodexTomlConfig({ useAbsolute = false } = {}) {
  const entryPath = useAbsolute ? ABSOLUTE_MCP_ENTRY : RELATIVE_MCP_ENTRY;
  return [
    '# Glassline MCP server configuration for OpenAI Codex CLI (~/.codex/config.toml or workspace .codex/config.toml)',
    '[mcp_servers.glassline]',
    'command = "node"',
    `args = ["${entryPath.replace(/\\/g, '\\\\')}"]`,
    '',
    '[mcp_servers.glassline.env]',
    'GLASSLINE_AGENT_PORT = "7823"',
    ''
  ].join('\n');
}

function buildAntigravitySkillMarkdown() {
  return `---
name: glassline-interview-coach
description: Conduct structured text-based mock interviews using Glassline MCP tools, critique answers with "How to Respond Instead", and persist actionable improvement plans.
---

# Glassline Interview Practice Coach Skill

Use this skill in **Antigravity** to run an interactive interview preparation and academic coaching loop connected to Glassline.

## Available MCP Tools (\`glassline\`)
1. \`glassline_get_session_context\` — Load candidate resume/CV context, target job description, durable study notes, and past practice sessions.
2. \`glassline_practice_generate_question\` — Generate the next mock interview question (\`domain\`: \`mixed\` | \`coding\` | \`system-design\` | \`behavioral\` | \`conceptual\`, \`difficulty\`: \`junior\` | \`mid\` | \`senior\` | \`staff\`, optional \`topic\`).
3. \`glassline_practice_evaluate_response\` — Evaluate the candidate's written response and output:
   - \`## Evaluation & Rubric Score\`
   - \`## Strengths & Gaps\`
   - \`## How to Respond Instead (Model Answer)\`
   - \`## Actionable Improvement Plan\`
4. \`glassline_save_study_note\` — Persist key weaknesses or STAR stories into Glassline durable notes.
5. \`glassline_list_interview_sessions\` — Inspect archived practice sessions.
6. \`glassline_bridge_status\` — Verify Electron desktop companion REST bridge (\`http://127.0.0.1:7823/api/agent/status\`) and detected CLI agents.

## Recommended Practice Workflow
1. Call \`glassline_get_session_context\` at the start of a coaching session.
2. Call \`glassline_practice_generate_question\` and present the question clearly in text without revealing the solution.
3. Wait for the user/interviewee to reply in text.
4. Call \`glassline_practice_evaluate_response\` with \`question\` and \`candidateAnswer\`, review the coaching output with the user, and highlight **How to Respond Instead** + the step-by-step **Actionable Improvement Plan**.
5. Save recurring takeaways with \`glassline_save_study_note\`.
`;
}

function buildClaudeMd() {
  return `# Glassline — Claude Code Instructions

This repository implements **Glassline**, an interactive text-based AI Interview Practice Simulator, Coaching Studio, and Multi-Agent MCP Bridge.

## MCP Server (\`.mcp.json\`)
Claude Code automatically discovers the Glassline MCP server in \`.mcp.json\`:
- Server name: \`glassline\`
- Entrypoint: \`node source/scripts/run-mcp-server.js\`

### Interview Practice Workflow for Claude Code
When helping a user practice interviews in text:
1. Read candidate background & saved study notes via \`glassline_get_session_context\`.
2. Ask ONE tailored question via \`glassline_practice_generate_question\` (do not reveal the answer yet).
3. Wait for the candidate's written answer.
4. Evaluate their answer via \`glassline_practice_evaluate_response\` and provide:
   - Rubric score & specific gaps
   - **How to Respond Instead (Model Answer)**
   - **Actionable Improvement Plan**
5. Persist key takeaways via \`glassline_save_study_note\`.

## Development & Tests
- Install & run unit/integration tests from \`source/\`:
  - \`cd source && npm test\`
  - \`cd source && npm run agents:verify\`
`;
}

function buildAgentsMd() {
  return `# Glassline — OpenAI Codex / Universal Agent Guide

**Glassline** is an academic & career-readiness software engineering project focused on structured text-based interview simulation, rubric feedback, and multi-agent tooling.

## Agent Connectivity
Connect Codex, Cursor, Claude Code, or Antigravity via the stdio MCP server or local companion HTTP API:
- **MCP command:** \`node source/scripts/run-mcp-server.js\`
- **Codex TOML snippet:** \`integrations/codex/config.toml\`
- **Local Companion API (when desktop app is running):** \`http://127.0.0.1:7823/api/agent/status\`

## MCP Tools Exposed
- \`glassline_get_session_context\`
- \`glassline_practice_generate_question\`
- \`glassline_practice_evaluate_response\`
- \`glassline_save_study_note\`
- \`glassline_list_interview_sessions\`
- \`glassline_bridge_status\`

## Verification Commands
- \`cd source && npm test\` — Full Node test suite
- \`cd source && npm run agents:verify\` — Verifies all 4 agent configs + live MCP stdio handshake
`;
}

function getTargetFiles({ useAbsolute = false } = {}) {
  const mcpJson = `${JSON.stringify(buildMcpJsonConfig({ useAbsolute }), null, 2)}\n`;
  const codexToml = buildCodexTomlConfig({ useAbsolute });
  const skillMd = buildAntigravitySkillMarkdown();
  const claudeMd = buildClaudeMd();
  const agentsMd = buildAgentsMd();

  return [
    {
      relativePath: 'integrations/cursor/mcp.json',
      content: mcpJson,
      kind: 'json'
    },
    {
      relativePath: '.cursor/mcp.json',
      content: mcpJson,
      kind: 'json'
    },
    {
      relativePath: 'integrations/claude-code/.mcp.json',
      content: mcpJson,
      kind: 'json'
    },
    {
      relativePath: '.mcp.json',
      content: mcpJson,
      kind: 'json'
    },
    {
      relativePath: 'integrations/antigravity/mcp_config.json',
      content: mcpJson,
      kind: 'json'
    },
    {
      relativePath: 'integrations/antigravity/SKILL.md',
      content: skillMd,
      kind: 'markdown'
    },
    {
      relativePath: 'integrations/codex/config.toml',
      content: codexToml,
      kind: 'toml'
    },
    {
      relativePath: 'CLAUDE.md',
      content: claudeMd,
      kind: 'markdown'
    },
    {
      relativePath: 'AGENTS.md',
      content: agentsMd,
      kind: 'markdown'
    }
  ];
}

function writeIntegrationFiles({ repoRoot = REPO_ROOT, useAbsolute = false } = {}) {
  const targets = getTargetFiles({ useAbsolute });
  const written = [];

  for (const target of targets) {
    const absPath = path.join(repoRoot, target.relativePath);
    fs.mkdirSync(path.dirname(absPath), { recursive: true });
    fs.writeFileSync(absPath, target.content, 'utf8');
    written.push(absPath);
  }

  return written;
}

function validateGeneratedFiles({ repoRoot = REPO_ROOT } = {}) {
  const targets = getTargetFiles();

  for (const target of targets) {
    const absPath = path.join(repoRoot, target.relativePath);
    assert.ok(fs.existsSync(absPath), `Missing integration file: ${target.relativePath}`);
    const content = fs.readFileSync(absPath, 'utf8');
    assert.ok(content.trim().length > 0, `Empty integration file: ${target.relativePath}`);

    if (target.kind === 'json') {
      const parsed = JSON.parse(content);
      const serverConfig = parsed?.mcpServers?.glassline;
      assert.ok(serverConfig, `Missing mcpServers.glassline in ${target.relativePath}`);
      assert.equal(serverConfig.command, 'node');
      assert.ok(Array.isArray(serverConfig.args) && serverConfig.args.length > 0);
    } else if (target.kind === 'toml') {
      assert.ok(content.includes('[mcp_servers.glassline]'), 'Missing Codex MCP table');
      assert.ok(content.includes('command = "node"'), 'Missing Codex node command');
    } else if (target.kind === 'markdown') {
      assert.ok(content.includes('glassline'), `Missing Glassline reference in ${target.relativePath}`);
    }
  }
}

function runMcpStdioSmokeTest() {
  return new Promise((resolve, reject) => {
    const tempStateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'glassline-mcp-verify-'));
    const child = spawn(process.execPath, [ABSOLUTE_MCP_ENTRY], {
      cwd: REPO_ROOT,
      env: {
        ...process.env,
        OPEN_CLUELY_STATE_DIR: tempStateDir,
        GLASSLINE_MCP_DISABLE_BRIDGE_PROBE: '1'
      },
      stdio: ['pipe', 'pipe', 'pipe']
    });

    const responses = new Map();
    const waiters = new Map();
    let buffer = '';
    let stderrText = '';

    function cleanup() {
      try {
        child.kill('SIGTERM');
      } catch (_error) {
        // ignore
      }
      fs.rmSync(tempStateDir, { recursive: true, force: true });
    }

    child.stderr.on('data', (chunk) => {
      stderrText += chunk.toString('utf8');
    });

    child.stdout.on('data', (chunk) => {
      buffer += chunk.toString('utf8');
      let nlIndex = buffer.indexOf('\n');
      while (nlIndex !== -1) {
        const line = buffer.slice(0, nlIndex).trim();
        buffer = buffer.slice(nlIndex + 1);
        if (line) {
          try {
            const parsed = JSON.parse(line);
            if (parsed && parsed.id !== undefined && parsed.id !== null) {
              responses.set(parsed.id, parsed);
              const waiter = waiters.get(parsed.id);
              if (waiter) {
                waiters.delete(parsed.id);
                waiter(parsed);
              }
            }
          } catch (error) {
            cleanup();
            reject(new Error(`Invalid JSON from MCP server: ${error.message}`));
            return;
          }
        }
        nlIndex = buffer.indexOf('\n');
      }
    });

    function rpcCall(id, method, params = {}) {
      return new Promise((res, rej) => {
        const timer = setTimeout(() => {
          waiters.delete(id);
          rej(new Error(`MCP RPC call timed out (${method}). stderr=${stderrText}`));
        }, 5000);
        waiters.set(id, (msg) => {
          clearTimeout(timer);
          res(msg);
        });
        child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
      });
    }

    (async () => {
      try {
        const initRes = await rpcCall(1, 'initialize', { protocolVersion: '2024-11-05' });
        assert.equal(initRes.result?.serverInfo?.name, 'glassline-mcp');
        child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`);

        const listRes = await rpcCall(2, 'tools/list');
        const toolNames = (listRes.result?.tools || []).map((t) => t.name);
        for (const required of [
          'glassline_get_session_context',
          'glassline_practice_generate_question',
          'glassline_practice_evaluate_response',
          'glassline_save_study_note',
          'glassline_list_interview_sessions',
          'glassline_bridge_status'
        ]) {
          assert.ok(toolNames.includes(required), `Missing MCP tool: ${required}`);
        }

        const qRes = await rpcCall(3, 'tools/call', {
          name: 'glassline_practice_generate_question',
          arguments: { domain: 'system-design', difficulty: 'mid', topic: 'Webhook Delivery' }
        });
        assert.equal(qRes.result?.structuredContent?.success, true);

        const evalRes = await rpcCall(4, 'tools/call', {
          name: 'glassline_practice_evaluate_response',
          arguments: {
            candidateAnswer: 'First I put an API gateway in front of a partitioned queue so slow downstream webhooks do not block ingestion, add exponential backoff with jitter retries, and track p99 latency and dead-letter timeouts.'
          }
        });
        assert.equal(evalRes.result?.structuredContent?.success, true);
        const evalText = evalRes.result?.content?.[0]?.text || '';
        assert.ok(evalText.includes('## Evaluation & Rubric Score'));
        assert.ok(evalText.includes('## How to Respond Instead (Model Answer)'));
        assert.ok(evalText.includes('## Actionable Improvement Plan'));

        const noteRes = await rpcCall(5, 'tools/call', {
          name: 'glassline_save_study_note',
          arguments: { note: 'Review idempotency keys in distributed webhook pipelines', tag: 'system-design' }
        });
        assert.equal(noteRes.result?.structuredContent?.success, true);

        const ctxRes = await rpcCall(6, 'tools/call', {
          name: 'glassline_get_session_context',
          arguments: {}
        });
        assert.equal(ctxRes.result?.structuredContent?.durableNotes?.length, 1);

        cleanup();
        resolve({ toolCount: toolNames.length });
      } catch (error) {
        cleanup();
        reject(error);
      }
    })();
  });
}

async function main() {
  const args = new Set(process.argv.slice(2));
  const useAbsolute = args.has('--absolute');
  const verifyOnly = args.has('--verify');

  if (!verifyOnly) {
    const written = writeIntegrationFiles({ repoRoot: REPO_ROOT, useAbsolute });
    console.log(`[agents:setup] Wrote ${written.length} agent integration files under ${REPO_ROOT}`);
    for (const filePath of written) {
      console.log(`  - ${path.relative(REPO_ROOT, filePath)}`);
    }
    return;
  }

  validateGeneratedFiles({ repoRoot: REPO_ROOT });
  const mcpCheck = await runMcpStdioSmokeTest();
  console.log(`[agents:verify] Validated 9 integration config files + live MCP stdio handshake (${mcpCheck.toolCount} tools)`);
}

if (require.main === module) {
  main().catch((error) => {
    console.error('[agents:setup/verify] Failed:', error);
    process.exit(1);
  });
}

module.exports = {
  buildMcpJsonConfig,
  buildCodexTomlConfig,
  buildAntigravitySkillMarkdown,
  buildClaudeMd,
  buildAgentsMd,
  getTargetFiles,
  writeIntegrationFiles,
  validateGeneratedFiles,
  runMcpStdioSmokeTest
};
