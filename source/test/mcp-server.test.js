'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { PassThrough } = require('stream');
const { spawn } = require('child_process');
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const {
  MCP_TOOLS,
  MCP_RESOURCES,
  createGlasslineMcpServer
} = require('../src/mcp/glassline-mcp-server');

function withTempStateDir(t) {
  const prev = process.env.OPEN_CLUELY_STATE_DIR;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'glassline-mcp-test-'));
  process.env.OPEN_CLUELY_STATE_DIR = dir;
  t.after(() => {
    if (prev === undefined) {
      delete process.env.OPEN_CLUELY_STATE_DIR;
    } else {
      process.env.OPEN_CLUELY_STATE_DIR = prev;
    }
    fs.rmSync(dir, { recursive: true, force: true });
  });
  return dir;
}

describe('Glassline MCP server JSON-RPC tools & resources', () => {
  it('handles initialize, ping, tools/list, resources/list, and unknown methods', async (t) => {
    withTempStateDir(t);
    const server = createGlasslineMcpServer({
      probeLiveBridge: false,
      adapterOverride: null,
      detectAgents: async () => [{ id: 'cursor', label: 'Cursor Agent', binary: 'cursor', available: true }]
    });

    const init = await server.handleJsonRpcMessage({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: { protocolVersion: '2025-03-26' }
    });
    assert.equal(init.result.protocolVersion, '2025-03-26');
    assert.equal(init.result.serverInfo.name, 'glassline-mcp');

    const notify = await server.handleJsonRpcMessage({
      jsonrpc: '2.0',
      method: 'notifications/initialized'
    });
    assert.equal(notify, null);

    const ping = await server.handleJsonRpcMessage({ jsonrpc: '2.0', id: 2, method: 'ping' });
    assert.deepEqual(ping.result, {});

    const listTools = await server.handleJsonRpcMessage({ jsonrpc: '2.0', id: 3, method: 'tools/list' });
    assert.equal(listTools.result.tools.length, MCP_TOOLS.length);

    const listRes = await server.handleJsonRpcMessage({ jsonrpc: '2.0', id: 4, method: 'resources/list' });
    assert.equal(listRes.result.resources.length, MCP_RESOURCES.length);

    const unknown = await server.handleJsonRpcMessage({ jsonrpc: '2.0', id: 5, method: 'nonexistent/op' });
    assert.equal(unknown.error.code, -32601);
  });

  it('executes interactive practice flow, durable notes, and resource reads cleanly', async (t) => {
    withTempStateDir(t);
    const server = createGlasslineMcpServer({
      probeLiveBridge: false,
      adapterOverride: null,
      detectAgents: async () => [
        { id: 'claude', label: 'Claude Code', binary: 'claude', available: true },
        { id: 'codex', label: 'OpenAI Codex CLI', binary: 'codex', available: false }
      ]
    });

    const gen = await server.handleJsonRpcMessage({
      jsonrpc: '2.0',
      id: 10,
      method: 'tools/call',
      params: {
        name: 'glassline_practice_generate_question',
        arguments: { domain: 'behavioral', difficulty: 'mid', topic: 'Architecture Trade-off' }
      }
    });
    assert.equal(gen.result.structuredContent.success, true);
    assert.ok(gen.result.content[0].text.includes('## Practice Question'));

    const evaluate = await server.handleJsonRpcMessage({
      jsonrpc: '2.0',
      id: 11,
      method: 'tools/call',
      params: {
        name: 'glassline_practice_evaluate_response',
        arguments: {
          candidateAnswer:
            'Situation: Our API latency spiked. Task: I needed to stabilize p99 latency under 150ms. ' +
            'Action: I built an outbox queue to avoid blocking database writes during timeouts. Result: p99 latency dropped 40%.'
        }
      }
    });
    assert.equal(evaluate.result.structuredContent.success, true);
    assert.ok(evaluate.result.content[0].text.includes('## How to Respond Instead (Model Answer)'));
    assert.ok(evaluate.result.content[0].text.includes('## Actionable Improvement Plan'));

    const saveNote = await server.handleJsonRpcMessage({
      jsonrpc: '2.0',
      id: 12,
      method: 'tools/call',
      params: {
        name: 'glassline_save_study_note',
        arguments: { note: 'Quantify reliability SLAs in STAR results', tag: 'behavioral' }
      }
    });
    assert.equal(saveNote.result.structuredContent.success, true);
    assert.equal(saveNote.result.structuredContent.totalDurableNotes, 1);

    const ctx = await server.handleJsonRpcMessage({
      jsonrpc: '2.0',
      id: 13,
      method: 'tools/call',
      params: { name: 'glassline_get_session_context', arguments: {} }
    });
    assert.equal(ctx.result.structuredContent.durableNotes[0].text, '[behavioral] Quantify reliability SLAs in STAR results');

    const bridge = await server.handleJsonRpcMessage({
      jsonrpc: '2.0',
      id: 14,
      method: 'tools/call',
      params: { name: 'glassline_bridge_status', arguments: {} }
    });
    assert.equal(bridge.result.structuredContent.companionBridge.reachable, false);
    assert.equal(bridge.result.structuredContent.detectedCliAgents.length, 2);

    const resSession = await server.handleJsonRpcMessage({
      jsonrpc: '2.0',
      id: 15,
      method: 'resources/read',
      params: { uri: 'glassline://practice/current-session' }
    });
    const parsedSession = JSON.parse(resSession.result.contents[0].text);
    assert.equal(parsedSession.turnsCount, 1);
  });

  it('supports both NDJSON and Content-Length stdio framing', async (t) => {
    withTempStateDir(t);
    const server = createGlasslineMcpServer({
      probeLiveBridge: false,
      adapterOverride: null,
      detectAgents: async () => []
    });

    // 1. NDJSON stream
    const inNdjson = new PassThrough();
    const outNdjson = new PassThrough();
    const handle1 = server.startStdio(inNdjson, outNdjson);

    const ndjsonReply = await new Promise((resolve) => {
      outNdjson.once('data', (chunk) => resolve(JSON.parse(chunk.toString('utf8').trim())));
      inNdjson.write(`${JSON.stringify({ jsonrpc: '2.0', id: 99, method: 'ping' })}\n`);
    });
    assert.equal(ndjsonReply.id, 99);
    assert.deepEqual(ndjsonReply.result, {});
    handle1.stop();

    // 2. Content-Length framed stream
    const inFramed = new PassThrough();
    const outFramed = new PassThrough();
    const handle2 = server.startStdio(inFramed, outFramed);

    const framedReply = await new Promise((resolve) => {
      let acc = '';
      outFramed.on('data', (chunk) => {
        acc += chunk.toString('utf8');
        if (acc.includes('\r\n\r\n')) {
          const [, body] = acc.split('\r\n\r\n');
          if (body.trim().endsWith('}')) {
            resolve(acc);
          }
        }
      });
      const req = JSON.stringify({ jsonrpc: '2.0', id: 100, method: 'ping' });
      inFramed.write(`Content-Length: ${Buffer.byteLength(req, 'utf8')}\r\n\r\n${req}`);
    });
    assert.ok(framedReply.startsWith('Content-Length:'));
    const bodyJson = JSON.parse(framedReply.split('\r\n\r\n')[1]);
    assert.equal(bodyJson.id, 100);
    handle2.stop();
  });

  it('runs scripts/run-mcp-server.js as a real child stdio process', async (t) => {
    const tempDir = withTempStateDir(t);
    const scriptPath = path.join(__dirname, '..', 'scripts', 'run-mcp-server.js');

    const result = await new Promise((resolve, reject) => {
      const child = spawn(process.execPath, [scriptPath], {
        env: {
          ...process.env,
          OPEN_CLUELY_STATE_DIR: tempDir,
          GLASSLINE_MCP_DISABLE_BRIDGE_PROBE: '1'
        },
        stdio: ['pipe', 'pipe', 'pipe']
      });

      const timer = setTimeout(() => {
        child.kill('SIGKILL');
        reject(new Error('Timed out waiting for run-mcp-server.js stdout'));
      }, 5000);

      let out = '';
      child.stdout.on('data', (chunk) => {
        out += chunk.toString('utf8');
        if (out.includes('\n')) {
          clearTimeout(timer);
          child.kill('SIGTERM');
          resolve(JSON.parse(out.trim().split('\n')[0]));
        }
      });

      child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} })}\n`);
    });

    assert.equal(result.id, 1);
    assert.equal(result.result.serverInfo.name, 'glassline-mcp');
  });
});
