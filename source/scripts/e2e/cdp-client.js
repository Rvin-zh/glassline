'use strict';

const DEFAULT_CONNECT_TIMEOUT_MS = 5000;
const DEFAULT_COMMAND_TIMEOUT_MS = 5000;
const DEFAULT_CLOSE_TIMEOUT_MS = 1000;

function addSocketListener(socket, eventName, handler) {
  if (typeof socket.on === 'function') {
    socket.on(eventName, handler);
    return;
  }
  if (typeof socket.addEventListener === 'function') {
    socket.addEventListener(eventName, handler);
    return;
  }
  throw new Error('CDP WebSocket does not support event listeners');
}

function decodeSocketMessage(eventOrData) {
  let data = eventOrData;
  if (
    data &&
    typeof data === 'object' &&
    !Buffer.isBuffer(data) &&
    Object.prototype.hasOwnProperty.call(data, 'data')
  ) {
    data = data.data;
  }

  if (Buffer.isBuffer(data)) {
    return data.toString('utf8');
  }
  if (data instanceof ArrayBuffer) {
    return Buffer.from(data).toString('utf8');
  }
  if (ArrayBuffer.isView(data)) {
    return Buffer
      .from(data.buffer, data.byteOffset, data.byteLength)
      .toString('utf8');
  }
  return String(data);
}

function wait(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function normalizeDuration(value, fallback, minimum) {
  const number = Number(value);
  if (!Number.isFinite(number) || number < 0) {
    return fallback;
  }
  return Math.max(minimum, Math.floor(number));
}

async function connectCdp(webSocketUrl, WebSocketConstructor, options = {}) {
  let WebSocketImpl = WebSocketConstructor;
  let configuredOptions = options;

  if (
    WebSocketConstructor &&
    typeof WebSocketConstructor === 'object'
  ) {
    configuredOptions = WebSocketConstructor;
    WebSocketImpl = configuredOptions.WebSocketConstructor
      || configuredOptions.webSocketConstructor;
  }

  if (!configuredOptions || typeof configuredOptions !== 'object') {
    configuredOptions = {};
  }
  WebSocketImpl = WebSocketImpl || require('ws');

  const connectTimeoutMs = normalizeDuration(
    configuredOptions.connectTimeoutMs
      ?? configuredOptions.connectionTimeoutMs,
    DEFAULT_CONNECT_TIMEOUT_MS,
    0
  );
  const commandTimeoutMs = normalizeDuration(
    configuredOptions.commandTimeoutMs,
    DEFAULT_COMMAND_TIMEOUT_MS,
    0
  );
  const closeTimeoutMs = normalizeDuration(
    configuredOptions.closeTimeoutMs,
    DEFAULT_CLOSE_TIMEOUT_MS,
    0
  );
  let socket;

  try {
    socket = new WebSocketImpl(webSocketUrl);
  } catch {
    throw new Error('CDP WebSocket connection failed');
  }

  let state = 'connecting';
  let nextId = 1;
  let terminalError = null;
  let closePromise = null;
  let connectionTimeout = null;
  const pending = new Map();

  let resolveConnection;
  let rejectConnection;
  const connected = new Promise((resolve, reject) => {
    resolveConnection = resolve;
    rejectConnection = reject;
  });

  let resolveSocketClosed;
  const socketClosed = new Promise((resolve) => {
    resolveSocketClosed = resolve;
  });

  function forceTerminateSocket() {
    try {
      if (typeof socket.terminate === 'function') {
        socket.terminate();
      } else {
        socket.close();
      }
      return true;
    } catch {
      return false;
    }
  }

  function rejectPending(error) {
    for (const request of pending.values()) {
      clearTimeout(request.timeout);
      request.reject(error);
    }
    pending.clear();
  }

  function handleOpen() {
    if (state !== 'connecting') {
      return;
    }
    state = 'open';
    clearTimeout(connectionTimeout);
    resolveConnection();
  }

  function handleMessage(eventOrData) {
    let message;
    try {
      message = JSON.parse(decodeSocketMessage(eventOrData));
    } catch {
      return;
    }

    if (!Number.isInteger(message.id)) {
      return;
    }

    const request = pending.get(message.id);
    if (!request) {
      return;
    }
    pending.delete(message.id);
    clearTimeout(request.timeout);

    if (message.error) {
      const code = Number.isFinite(Number(message.error.code))
        ? ` (${Number(message.error.code)})`
        : '';
      request.reject(new Error(`CDP command failed${code}`));
      return;
    }
    request.resolve(message.result);
  }

  function handleError() {
    if (state === 'closed' || state === 'closing' || state === 'failed') {
      return;
    }

    terminalError = new Error('CDP WebSocket failed');
    const wasConnecting = state === 'connecting';
    state = 'failed';
    clearTimeout(connectionTimeout);
    rejectPending(terminalError);
    if (wasConnecting) {
      rejectConnection(terminalError);
    }
  }

  function handleClose() {
    resolveSocketClosed();

    if (state === 'closed') {
      return;
    }

    const wasConnecting = state === 'connecting';
    const wasClosing = state === 'closing';
    state = 'closed';
    clearTimeout(connectionTimeout);

    if (!wasClosing) {
      terminalError = terminalError || new Error('CDP WebSocket closed');
      rejectPending(terminalError);
    }
    if (wasConnecting) {
      rejectConnection(terminalError || new Error('CDP WebSocket closed'));
    }
  }

  try {
    addSocketListener(socket, 'open', handleOpen);
    addSocketListener(socket, 'message', handleMessage);
    addSocketListener(socket, 'error', handleError);
    addSocketListener(socket, 'close', handleClose);
  } catch {
    try {
      socket.close();
    } catch {
      // Best-effort cleanup after an incompatible injected socket.
    }
    throw new Error('CDP WebSocket connection failed');
  }

  connectionTimeout = setTimeout(() => {
    if (state !== 'connecting') {
      return;
    }

    terminalError = new Error(
      `CDP WebSocket connection timed out after ${connectTimeoutMs}ms`
    );
    state = 'failed';
    rejectConnection(terminalError);
  }, connectTimeoutMs);

  if (socket.readyState === WebSocketImpl.OPEN || socket.readyState === 1) {
    queueMicrotask(handleOpen);
  }

  try {
    await connected;
  } catch (error) {
    clearTimeout(connectionTimeout);
    if (state !== 'closed') {
      forceTerminateSocket();
    }
    throw error;
  }

  function call(method, params = {}, callOptions = {}) {
    if (state !== 'open') {
      return Promise.reject(
        terminalError || new Error('CDP WebSocket is not open')
      );
    }

    const id = nextId;
    nextId += 1;
    const timeoutMs = normalizeDuration(
      callOptions?.timeoutMs,
      commandTimeoutMs,
      0
    );

    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        const request = pending.get(id);
        if (!request) {
          return;
        }

        pending.delete(id);
        request.reject(
          new Error(`CDP command timed out after ${timeoutMs}ms`)
        );
      }, timeoutMs);
      pending.set(id, { resolve, reject, timeout });

      try {
        socket.send(JSON.stringify({
          id,
          method,
          params
        }));
      } catch {
        const request = pending.get(id);
        if (!request) {
          return;
        }
        pending.delete(id);
        clearTimeout(request.timeout);
        reject(new Error('CDP WebSocket send failed'));
      }
    });
  }

  async function evaluate(expression, evaluateOptions = {}) {
    const response = await call('Runtime.evaluate', {
      expression: String(expression),
      awaitPromise: true,
      returnByValue: true
    }, evaluateOptions);

    if (response?.exceptionDetails) {
      throw new Error('CDP evaluation failed');
    }
    return response?.result?.value;
  }

  async function waitFor(expression, options = {}) {
    const timeoutMs = normalizeDuration(options.timeoutMs, 5000, 0);
    const intervalMs = normalizeDuration(options.intervalMs, 50, 1);
    const pollCommandTimeoutMs = normalizeDuration(
      options.commandTimeoutMs,
      commandTimeoutMs,
      0
    );
    const deadline = Date.now() + timeoutMs;
    const timeoutError = () => new Error(
      `CDP wait timed out after ${timeoutMs}ms`
    );

    while (true) {
      const remainingBeforeCall = deadline - Date.now();
      if (remainingBeforeCall <= 0) {
        throw timeoutError();
      }

      try {
        const value = await evaluate(expression, {
          timeoutMs: Math.min(pollCommandTimeoutMs, remainingBeforeCall)
        });
        if (value) {
          return value;
        }
      } catch (error) {
        if (state !== 'open') {
          throw error;
        }
      }

      const remainingAfterCall = deadline - Date.now();
      if (remainingAfterCall <= 0) {
        throw timeoutError();
      }
      await wait(Math.min(intervalMs, remainingAfterCall));
    }
  }

  function waitForSocketClose(timeoutMs) {
    if (state === 'closed') {
      return Promise.resolve(true);
    }

    return new Promise((resolve) => {
      let settled = false;
      const finish = (didClose) => {
        if (settled) {
          return;
        }
        settled = true;
        clearTimeout(timeout);
        resolve(didClose);
      };
      const timeout = setTimeout(() => finish(false), timeoutMs);
      socketClosed.then(() => finish(true));
    });
  }

  function close() {
    if (closePromise) {
      return closePromise;
    }

    closePromise = (async () => {
      let closeFailed = false;
      const closeError = new Error('CDP client closed');

      if (state !== 'closed') {
        state = 'closing';
        try {
          socket.close();
        } catch {
          closeFailed = true;
        }

        const closeObserved = closeFailed
          ? false
          : await waitForSocketClose(closeTimeoutMs);
        if (!closeObserved && !forceTerminateSocket()) {
          closeFailed = true;
        }
      }

      terminalError = terminalError || closeError;
      if (state !== 'closed') {
        state = 'closed';
      }
      rejectPending(closeError);

      if (closeFailed) {
        throw new Error('CDP WebSocket close failed');
      }
    })();
    return closePromise;
  }

  return {
    call,
    evaluate,
    waitFor,
    close
  };
}

module.exports = {
  connectCdp
};
