'use strict';

const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const { WebSocketServer } = require('ws');
const { createInterviewPracticeService } = require('../../../services/ai/interview-practice');

// Names that almost always belong to virtual adapters (Docker, WSL, VPN,
// hypervisors). Phones cannot route to these IPs, so we want the real
// Wi-Fi/Ethernet adapter to appear first in the URL list.
const VIRTUAL_ADAPTER_PATTERNS = [
  /vethernet/i,
  /wsl/i,
  /vmware/i,
  /virtualbox/i,
  /hyper-?v/i,
  /docker/i,
  /tailscale/i,
  /zerotier/i,
  /\btap\b/i,
  /\btun\b/i,
  /loopback/i,
  /^ppp/i,
  /openvpn/i,
  /utun/i
];

function isVirtualAdapter(name = '') {
  return VIRTUAL_ADAPTER_PATTERNS.some((re) => re.test(name));
}

function getLanAddresses() {
  const real = [];
  const virtual = [];
  const ifaces = os.networkInterfaces();
  for (const name of Object.keys(ifaces)) {
    for (const iface of ifaces[name] || []) {
      if (iface.family === 'IPv4' && !iface.internal) {
        const entry = { name, address: iface.address, virtual: isVirtualAdapter(name) };
        if (entry.virtual) virtual.push(entry); else real.push(entry);
      }
    }
  }
  return [...real, ...virtual];
}

const MOBILE_PORT = 7823;
const MOBILE_HTML_PATH = path.join(__dirname, 'mobile.html');
const MAX_AGENT_BODY_BYTES = 1024 * 1024;

function isLoopbackRemoteAddress(remoteAddress = '') {
  const normalized = String(remoteAddress || '').trim().toLowerCase();
  return (
    normalized === '127.0.0.1' ||
    normalized === '::1' ||
    normalized === '::ffff:127.0.0.1' ||
    normalized === 'localhost'
  );
}

function sendJson(res, statusCode, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store'
  });
  res.end(body);
}

function readJsonBody(req, maxBytes = MAX_AGENT_BODY_BYTES) {
  return new Promise((resolve, reject) => {
    let totalBytes = 0;
    const chunks = [];
    req.on('data', (chunk) => {
      totalBytes += chunk.length;
      if (totalBytes > maxBytes) {
        const err = new Error('Request body too large');
        err.statusCode = 413;
        reject(err);
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8').trim();
      if (!raw) {
        resolve({});
        return;
      }
      try {
        resolve(JSON.parse(raw));
      } catch (_error) {
        const err = new Error('Invalid JSON request body');
        err.statusCode = 400;
        reject(err);
      }
    });
    req.on('error', reject);
  });
}

function createMobileServer({
  getGeminiRuntime,
  getScreenshotManager,
  notifyDesktop,
  getContextServices = () => null,
  getAppState = () => null,
  practiceService: providedPracticeService = null,
  port = MOBILE_PORT,
  disabled = process.env.OPEN_CLUELY_DISABLE_MOBILE === '1'
}) {
  const clients = new Set();
  const status = {
    listening: false,
    port,
    urls: [],
    clientCount: 0,
    error: null
  };
  if (disabled) {
    status.reason = 'disabled-for-e2e';
  }

  const practiceService = providedPracticeService || createInterviewPracticeService({
    getAdapter: () => {
      const runtime = typeof getGeminiRuntime === 'function' ? getGeminiRuntime() : null;
      return runtime?.isAiReady?.() ? runtime.getService() : null;
    },
    getContextTexts: () => {
      const services = typeof getContextServices === 'function' ? getContextServices() : null;
      const pinned = services?.documentService?.getPinnedDocumentTexts?.();
      if (pinned) {
        return pinned;
      }
      const state = typeof getAppState === 'function' ? (getAppState() || {}) : {};
      return {
        resume: state.resumeText || '',
        jobDescription: state.jobDescriptionText || ''
      };
    },
    getProgrammingLanguage: () => getGeminiRuntime?.()?.getActiveProgrammingLanguage?.() || 'Python'
  });

  function emitStatus() {
    if (typeof notifyDesktop === 'function') {
      try { notifyDesktop('mobile-server-status', { ...status }); } catch (_) { /* ignore */ }
    }
  }

  function refreshUrls() {
    status.urls = getLanAddresses().map(({ name, address, virtual }) => ({
      name,
      address,
      virtual: !!virtual,
      url: `http://${address}:${status.port}`
    }));
  }

  function setClientCount(n) {
    status.clientCount = n;
    emitStatus();
  }

  function broadcast(channel, data) {
    if (clients.size === 0) return;
    const message = JSON.stringify({ channel, data });
    for (const ws of clients) {
      if (ws.readyState === 1 /* WebSocket.OPEN */) {
        try { ws.send(message); } catch (_) { /* ignore dead socket */ }
      }
    }
  }

  if (disabled) {
    return {
      broadcast,
      getStatus: () => ({ ...status }),
      emitStatus,
      close() {
        status.listening = false;
        status.clientCount = 0;
        emitStatus();
      }
    };
  }

  function sendTo(ws, channel, data) {
    try {
      if (ws.readyState === 1) ws.send(JSON.stringify({ channel, data }));
    } catch (_) { /* ignore */ }
  }

  async function handleAgentRequest(req, res, url) {
    if (!isLoopbackRemoteAddress(req.socket?.remoteAddress)) {
      sendJson(res, 403, {
        ok: false,
        error: 'Agent companion endpoints only accept localhost connections'
      });
      return;
    }

    const runtime = typeof getGeminiRuntime === 'function' ? getGeminiRuntime() : null;
    const services = typeof getContextServices === 'function' ? getContextServices() : null;
    const appState = typeof getAppState === 'function' ? (getAppState() || {}) : {};

    if (req.method === 'GET' && url === '/api/agent/status') {
      const service = runtime?.getService?.() || null;
      sendJson(res, 200, {
        ok: true,
        service: 'glassline',
        port: status.port,
        aiReady: Boolean(runtime?.isAiReady?.()),
        provider: runtime?.getActiveAiProvider?.() || appState.aiProvider || 'gemini',
        model: service?.model || service?.modelName || appState.geminiModel || null,
        practiceState: practiceService.getState()
      });
      return;
    }

    if (req.method === 'GET' && url === '/api/agent/context') {
      const pinned = services?.documentService?.getPinnedDocumentTexts?.() || {};
      const durableNotes = services?.memoryService?.getDurableNotes?.()
        || (Array.isArray(appState.durableNotes) ? appState.durableNotes : []);
      const interviewSessions = Array.isArray(appState.interviewSessions)
        ? appState.interviewSessions.map(({ id, archivedAt, title, summary }) => ({
          id,
          archivedAt,
          title,
          summary
        }))
        : [];
      sendJson(res, 200, {
        ok: true,
        resume: String(pinned.resume || appState.resumeText || ''),
        jobDescription: String(pinned.jobDescription || appState.jobDescriptionText || ''),
        durableNotes,
        interviewSessions,
        practiceState: practiceService.getState()
      });
      return;
    }

    if (req.method === 'POST' && url === '/api/agent/practice/question') {
      const body = await readJsonBody(req);
      const result = await practiceService.generateQuestion({
        ...(body && typeof body === 'object' ? body : {}),
        allowOfflineFallback: body?.allowOfflineFallback !== false
      });
      sendJson(res, result.success ? 200 : 400, { ok: result.success, ...result });
      return;
    }

    if (req.method === 'POST' && url === '/api/agent/practice/evaluate') {
      const body = await readJsonBody(req);
      const result = await practiceService.evaluateResponse({
        ...(body && typeof body === 'object' ? body : {}),
        allowOfflineFallback: body?.allowOfflineFallback !== false
      });
      sendJson(res, result.success ? 200 : 400, { ok: result.success, ...result });
      return;
    }

    sendJson(res, 404, { ok: false, error: 'Unknown agent endpoint' });
  }

  // ── HTTP server (serves mobile UI + localhost agent bridge) ────────────────

  const httpServer = http.createServer((req, res) => {
    const url = (req.url || '/').split('?')[0];

    if (url.startsWith('/api/agent/')) {
      handleAgentRequest(req, res, url).catch((error) => {
        const statusCode = error?.statusCode || 500;
        sendJson(res, statusCode, { ok: false, error: error.message || 'Agent request failed' });
      });
      return;
    }

    if (url === '/' || url === '/index.html') {
      try {
        const html = fs.readFileSync(MOBILE_HTML_PATH, 'utf8');
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(html);
      } catch (err) {
        res.writeHead(500);
        res.end('Mobile UI unavailable');
      }
      return;
    }

    res.writeHead(404);
    res.end('Not found');
  });

  // ── WebSocket server ───────────────────────────────────────────────────────

  const wss = new WebSocketServer({ server: httpServer });

  wss.on('connection', (ws) => {
    clients.add(ws);
    setClientCount(clients.size);
    console.log(`[MobileServer] Client connected (total: ${clients.size})`);

    // Send initial state
    const screenshotMgr = getScreenshotManager();
    sendTo(ws, 'connected', {
      screenshotsCount: screenshotMgr ? screenshotMgr.getScreenshotsCount() : 0
    });

    ws.on('message', async (rawData, _isBinary) => {
      let msg;
      try {
        msg = JSON.parse(rawData.toString());
      } catch (_) {
        sendTo(ws, 'error', { message: 'Invalid message format' });
        return;
      }

      const geminiRuntime = getGeminiRuntime();
      const screenshotManager = getScreenshotManager();

      switch (msg.type) {

        // ── Screenshot ─────────────────────────────────────────────────────
        case 'take-screenshot': {
          if (!screenshotManager) {
            sendTo(ws, 'error', { message: 'Screenshot manager not ready' });
            break;
          }
          try {
            await screenshotManager.takeStealthScreenshot();
            // screenshot-taken-stealth is emitted via augmented sendToRenderer → broadcast
          } catch (err) {
            sendTo(ws, 'error', { message: `Screenshot failed: ${err.message}` });
          }
          break;
        }

        // ── Ask AI ─────────────────────────────────────────────────────────
        case 'ask-ai': {
          if (!geminiRuntime || !geminiRuntime.isAiReady()) {
            sendTo(ws, 'error', { message: 'AI provider is not ready. Configure it in the desktop Settings.' });
            break;
          }

          const contextString = typeof msg.contextString === 'string' ? msg.contextString.trim() : '';

          if (!contextString && !screenshotManager?.hasScreenshots()) {
            sendTo(ws, 'error', { message: 'Take a screenshot or type a question first.' });
            break;
          }

          // Fire-and-forget; stream events go back via broadcast
          (async () => {
            try {
              broadcast('ai-stream-start', { actionId: 'askAi' });

              const onChunk = ({ text, index }) => {
                broadcast('ai-stream-chunk', { actionId: 'askAi', text, index });
              };

              let text = '';

              if (screenshotManager && screenshotManager.hasScreenshots()) {
                const { imageParts } = await screenshotManager.buildImagePartsFromScreenshots({ strict: false });
                if (imageParts.length > 0) {
                  text = await geminiRuntime.executeWithKeyFailover((svc) => {
                    if (!svc || !svc.isReady()) throw new Error('AI provider is not ready');
                    return svc.askAiWithSessionContextAndScreenshots(imageParts, {
                      contextString,
                      transcriptContext: '',
                      sessionSummary: '',
                      screenshotCount: imageParts.length,
                      onChunk
                    });
                  });
                }
              }

              if (!text) {
                text = await geminiRuntime.executeWithKeyFailover((svc) => {
                  if (!svc || !svc.isReady()) throw new Error('AI provider is not ready');
                  return svc.askAiWithSessionContext({
                    contextString,
                    transcriptContext: '',
                    sessionSummary: '',
                    screenshotCount: 0,
                    onChunk
                  });
                });
              }

              broadcast('ai-stream-end', { actionId: 'askAi' });
            } catch (err) {
              console.error('[MobileServer] ask-ai error:', err.message);
              broadcast('ai-stream-end', { actionId: 'askAi' });
              broadcast('error', { message: err.message });
            }
          })();
          break;
        }

        // ── Clear conversation history ──────────────────────────────────────
        case 'clear-conversation': {
          try {
            const geminiService = geminiRuntime?.getService();
            if (geminiService) geminiService.clearHistory();
            if (screenshotManager?.clearStealth) screenshotManager.clearStealth();
            // Tell the desktop renderer to wipe its chat UI as well.
            if (typeof notifyDesktop === 'function') {
              notifyDesktop('clear-from-mobile', {});
            }
            broadcast('clear-done', {});
          } catch (err) {
            sendTo(ws, 'error', { message: `Clear failed: ${err.message}` });
          }
          break;
        }

        default:
          sendTo(ws, 'error', { message: `Unknown command: ${msg.type}` });
      }
    });

    ws.on('close', () => {
      clients.delete(ws);
      setClientCount(clients.size);
      console.log(`[MobileServer] Client disconnected (total: ${clients.size})`);
    });

    ws.on('error', (err) => {
      console.error('[MobileServer] WebSocket error:', err.message);
      clients.delete(ws);
      setClientCount(clients.size);
    });
  });

  // ── Start listening ────────────────────────────────────────────────────────

  httpServer.listen(port, '0.0.0.0', () => {
    const actualPort = typeof httpServer.address === 'function'
      ? httpServer.address()?.port
      : null;
    if (typeof actualPort === 'number' && actualPort > 0) {
      status.port = actualPort;
    }
    refreshUrls();
    status.listening = true;
    status.error = null;
    emitStatus();
    console.log(`[MobileServer] Listening on 0.0.0.0:${status.port}`);
    console.log(`[MobileServer] Local:   http://localhost:${status.port}`);
    console.log(`[MobileServer] Agent:   http://127.0.0.1:${status.port}/api/agent/status`);
    for (const { name, url, virtual } of status.urls) {
      const tag = virtual ? '  [virtual — phone probably cannot reach]' : '';
      console.log(`[MobileServer] Network: ${url}  (${name})${tag}`);
    }
    console.log('[MobileServer] On the phone, open one of the Network URLs.');
    console.log('[MobileServer] If the phone cannot reach the PC, allow inbound TCP 7823 in Windows Firewall.');
  });

  httpServer.on('error', (err) => {
    status.listening = false;
    status.error = err.message;
    emitStatus();
    if (err.code === 'EADDRINUSE') {
      console.error(`[MobileServer] Port ${status.port} already in use — mobile companion disabled`);
    } else {
      console.error('[MobileServer] HTTP server error:', err.message);
    }
  });

  return {
    broadcast,
    getStatus: () => ({ ...status }),
    getPort: () => status.port,
    emitStatus,
    close() {
      try {
        wss.close();
        httpServer.close();
        status.listening = false;
        status.clientCount = 0;
        emitStatus();
      } catch (_) { /* ignore */ }
    }
  };
}

module.exports = { createMobileServer };
