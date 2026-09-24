'use strict';

const http = require('node:http');

const LOOPBACK_HOST = '127.0.0.1';
const E2E_MODEL = 'gemini-3.8-flash';
const E2E_MEMORY_MODEL = 'gemini-3.5-flash-lite';
const E2E_MEMORY_TOPIC = 'E2E deterministic memory topic';
const E2E_MEMORY_NOTE = 'E2E deterministic durable-note candidate';
const E2E_PORTKEY_API_KEY = 'e2e-portkey-test-key';
const E2E_PORTKEY_PROVIDER = '@e2e';
const E2E_VERTEX_PROJECT = 'e2e-project';
const E2E_VERTEX_LOCATION = 'us-central1';
const E2E_VERTEX_HOST = 'https://aiplatform.googleapis.com/v1';

function delay(milliseconds) {
  if (milliseconds <= 0) {
    return Promise.resolve();
  }
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function openAiError(message, type) {
  return {
    error: {
      message,
      type
    }
  };
}

function sendJson(response, statusCode, payload) {
  response.writeHead(statusCode, {
    'content-type': 'application/json; charset=utf-8'
  });
  response.end(JSON.stringify(payload));
}

async function parseJsonBody(request) {
  let body = '';
  request.setEncoding('utf8');

  for await (const chunk of request) {
    body += chunk;
  }

  return JSON.parse(body || '{}');
}

function isValidChatPayload(payload) {
  return (
    payload !== null
    && typeof payload === 'object'
    && !Array.isArray(payload)
    && typeof payload.model === 'string'
    && payload.model.trim().length > 0
    && Array.isArray(payload.messages)
    && typeof payload.stream === 'boolean'
  );
}

function sanitizeContent(content) {
  if (!Array.isArray(content)) {
    return typeof content === 'string' ? content : '';
  }

  return content.map((part) => {
    if (!part || typeof part !== 'object' || Array.isArray(part)) {
      return { type: 'text', text: String(part || '') };
    }

    if (part.type === 'image_url') {
      return {
        type: 'image_url',
        image_url: {
          url: '[image data omitted]'
        }
      };
    }

    return {
      type: String(part.type || 'text'),
      text: typeof part.text === 'string' ? part.text : ''
    };
  });
}

function sanitizeMessages(messages) {
  return messages.map((message) => ({
    role: typeof message?.role === 'string' ? message.role : '',
    content: sanitizeContent(message?.content)
  }));
}

function getMessageText(messages) {
  return messages
    .flatMap((message) => {
      if (typeof message?.content === 'string') {
        return [message.content];
      }
      if (Array.isArray(message?.content)) {
        return message.content.map((part) => (
          typeof part?.text === 'string' ? part.text : ''
        ));
      }
      return [];
    })
    .filter(Boolean)
    .join('\n');
}

function isMemoryPrompt(messages) {
  const prompt = getMessageText(messages);
  return (
    prompt.includes('You maintain structured interview/session memory')
    && prompt.includes('Return ONLY valid JSON')
    && prompt.includes('proposedDurableNotes')
  );
}

function createMemorySummary() {
  return {
    currentTopic: E2E_MEMORY_TOPIC,
    questions: ['E2E deterministic memory question'],
    facts: ['E2E deterministic memory fact'],
    candidateExamples: ['E2E deterministic candidate example'],
    strengthsGaps: ['E2E deterministic strength'],
    commitments: [],
    proposedDurableNotes: [{ text: E2E_MEMORY_NOTE }]
  };
}

function writeSseEvent(response, payload) {
  response.write(`data: ${JSON.stringify(payload)}\n\n`);
}

async function createFakePortkeyGateway(options = {}) {
  const chunks = Array.isArray(options.chunks)
    ? options.chunks.map((chunk) => String(chunk))
    : [];
  const configuredDelay = Number(options.chunkDelayMs);
  const chunkDelayMs = Number.isFinite(configuredDelay) && configuredDelay >= 0
    ? configuredDelay
    : 0;
  const expectedApiKey = String(options.apiKey || E2E_PORTKEY_API_KEY);
  const expectedProvider = String(options.provider || E2E_PORTKEY_PROVIDER);
  const enableVertexCache = options.enableVertexCache === true;
  const requests = [];
  const cacheRequests = [];
  const activeCacheNames = new Set();
  let cacheSequence = 0;

  const server = http.createServer((request, response) => {
    const handleRequest = async () => {
      const pathname = new URL(request.url || '/', `http://${LOOPBACK_HOST}`).pathname;

      const metadataPath =
        `/v1/providers/${expectedProvider.replace(/^@/, '')}`;
      if (
        enableVertexCache &&
        request.method === 'GET' &&
        pathname === metadataPath
      ) {
        if (request.headers['x-portkey-api-key'] !== expectedApiKey) {
          sendJson(
            response,
            401,
            openAiError('unauthorized fake gateway request', 'authentication_error')
          );
          return;
        }
        cacheRequests.push({ action: 'metadata' });
        sendJson(response, 200, {
          ai_provider_name: 'vertex-ai',
          model_config: {
            vertexServiceAccountJson: {
              project_id: E2E_VERTEX_PROJECT
            },
            vertexRegion: E2E_VERTEX_LOCATION
          }
        });
        return;
      }

      const createCachePath =
        `/v1/projects/${E2E_VERTEX_PROJECT}/locations/` +
        `${E2E_VERTEX_LOCATION}/cachedContents`;
      const cachePathPrefix = `${createCachePath}/`;
      const isCacheCreate =
        enableVertexCache &&
        request.method === 'POST' &&
        pathname === createCachePath;
      const isCacheDelete =
        enableVertexCache &&
        request.method === 'DELETE' &&
        pathname.startsWith(cachePathPrefix);
      if (isCacheCreate || isCacheDelete) {
        if (
          request.headers['x-portkey-api-key'] !== expectedApiKey ||
          request.headers['x-portkey-provider'] !== expectedProvider ||
          request.headers['x-portkey-custom-host'] !== E2E_VERTEX_HOST
        ) {
          sendJson(
            response,
            401,
            openAiError('unauthorized fake gateway request', 'authentication_error')
          );
          return;
        }

        if (isCacheCreate) {
          let payload;
          try {
            payload = await parseJsonBody(request);
          } catch {
            sendJson(
              response,
              400,
              openAiError('invalid JSON', 'invalid_request_error')
            );
            return;
          }
          const expectedModel =
            `projects/${E2E_VERTEX_PROJECT}/locations/${E2E_VERTEX_LOCATION}` +
            `/publishers/google/models/${E2E_MODEL}`;
          if (
            payload?.model !== expectedModel ||
            !Array.isArray(payload?.contents)
          ) {
            sendJson(
              response,
              400,
              openAiError('invalid cache payload', 'invalid_request_error')
            );
            return;
          }
          cacheSequence += 1;
          const name =
            `projects/${E2E_VERTEX_PROJECT}/locations/${E2E_VERTEX_LOCATION}` +
            `/cachedContents/e2e-cache-${cacheSequence}`;
          activeCacheNames.add(name);
          cacheRequests.push({ action: 'create' });
          sendJson(response, 200, {
            name,
            expireTime: new Date(Date.now() + 60_000).toISOString(),
            usageMetadata: { totalTokenCount: 5000 }
          });
          return;
        }

        const name = pathname.slice('/v1/'.length);
        if (!activeCacheNames.delete(name)) {
          sendJson(response, 404, openAiError('not found', 'not_found_error'));
          return;
        }
        cacheRequests.push({ action: 'delete' });
        sendJson(response, 200, {});
        return;
      }

      if (request.method !== 'POST' || pathname !== '/v1/chat/completions') {
        sendJson(response, 404, openAiError('not found', 'not_found_error'));
        return;
      }

      if (
        request.headers['x-portkey-api-key'] !== expectedApiKey
        || request.headers['x-portkey-provider'] !== expectedProvider
      ) {
        sendJson(
          response,
          401,
          openAiError('unauthorized fake gateway request', 'authentication_error')
        );
        return;
      }

      let parsedRequest;
      try {
        parsedRequest = await parseJsonBody(request);
      } catch {
        sendJson(response, 400, openAiError('invalid JSON', 'invalid_request_error'));
        return;
      }

      if (!isValidChatPayload(parsedRequest)) {
        sendJson(response, 400, openAiError('invalid chat payload', 'invalid_request_error'));
        return;
      }
      if (
        enableVertexCache &&
        parsedRequest.cached_content != null &&
        !activeCacheNames.has(parsedRequest.cached_content)
      ) {
        sendJson(
          response,
          400,
          openAiError('invalid cached content', 'invalid_request_error')
        );
        return;
      }

      const memoryRequest = isMemoryPrompt(parsedRequest.messages);
      const sanitizedRequest = {
        model: parsedRequest.model.trim(),
        messages: sanitizeMessages(parsedRequest.messages),
        stream: parsedRequest.stream,
        ...(enableVertexCache
          ? { cached: typeof parsedRequest.cached_content === 'string' }
          : {}),
        ...(memoryRequest
          ? {
            memory: {
              temperature: parsedRequest.temperature,
              responseFormat: parsedRequest.response_format,
              thinking: parsedRequest.thinking,
              reasoning: parsedRequest.reasoning
            }
          }
          : {})
      };
      requests.push(sanitizedRequest);

      if (parsedRequest.stream === false) {
        sendJson(response, 200, {
          id: 'chatcmpl-e2e',
          object: 'chat.completion',
          created: 0,
          model: sanitizedRequest.model,
          choices: [{
            index: 0,
            message: {
              role: 'assistant',
              content: memoryRequest
                ? JSON.stringify(createMemorySummary())
                : chunks.join('')
            },
            finish_reason: 'stop'
          }]
        });
        return;
      }

      response.writeHead(200, {
        'content-type': 'text/event-stream; charset=utf-8',
        'cache-control': 'no-cache, no-transform',
        connection: 'keep-alive',
        'x-accel-buffering': 'no'
      });
      response.flushHeaders();

      for (let index = 0; index < chunks.length; index += 1) {
        await delay(chunkDelayMs);
        if (response.destroyed || response.writableEnded) {
          return;
        }

        writeSseEvent(response, {
          id: `chatcmpl-e2e-${index + 1}`,
          object: 'chat.completion.chunk',
          created: 0,
          model: sanitizedRequest.model,
          choices: [{
            index: 0,
            delta: {
              ...(index === 0 ? { role: 'assistant' } : {}),
              content: chunks[index]
            },
            finish_reason: null
          }]
        });
      }

      if (!response.destroyed && !response.writableEnded) {
        writeSseEvent(response, {
          id: 'chatcmpl-e2e-done',
          object: 'chat.completion.chunk',
          created: 0,
          model: sanitizedRequest.model,
          choices: [{
            index: 0,
            delta: {},
            finish_reason: 'stop'
          }]
        });
        response.end('data: [DONE]\n\n');
      }
    };

    handleRequest().catch(() => {
      if (!response.headersSent) {
        sendJson(response, 500, openAiError('fake gateway failure', 'server_error'));
      } else if (!response.writableEnded) {
        response.end();
      }
    });
  });

  await new Promise((resolve, reject) => {
    const onError = (error) => {
      server.off('listening', onListening);
      reject(error);
    };
    const onListening = () => {
      server.off('error', onError);
      resolve();
    };

    server.once('error', onError);
    server.once('listening', onListening);
    server.listen(0, LOOPBACK_HOST);
  });

  const address = server.address();
  let closePromise = null;

  return {
    baseUrl: `http://${LOOPBACK_HOST}:${address.port}/v1`,
    requests,
    cacheRequests,
    close() {
      if (closePromise) {
        return closePromise;
      }

      closePromise = new Promise((resolve, reject) => {
        if (!server.listening) {
          resolve();
          return;
        }

        server.close((error) => {
          if (error) {
            reject(error);
            return;
          }
          resolve();
        });
        server.closeIdleConnections?.();
      });
      return closePromise;
    }
  };
}

module.exports = {
  E2E_MODEL,
  E2E_MEMORY_MODEL,
  E2E_MEMORY_NOTE,
  E2E_MEMORY_TOPIC,
  E2E_PORTKEY_API_KEY,
  E2E_PORTKEY_PROVIDER,
  createFakePortkeyGateway
};
