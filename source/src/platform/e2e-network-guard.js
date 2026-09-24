'use strict';

const fs = require('node:fs');
const http = require('node:http');
const https = require('node:https');
const net = require('node:net');
const tls = require('node:tls');

const E2E_NETWORK_POLICY_VALUE = 'loopback-only';
const E2E_HOST_RESOLVER_RULES =
  'MAP * ~NOTFOUND, EXCLUDE 127.0.0.1, EXCLUDE localhost, EXCLUDE [::1]';
const ALLOWED_EVENT_TYPES = new Set(['policy-ready', 'blocked-outbound']);
const ALLOWED_TRANSPORTS = new Set([
  'node',
  'fetch',
  'http',
  'https',
  'net',
  'tls',
  'renderer'
]);

function isE2ENetworkPolicyEnabled(environment = process.env) {
  return String(environment?.OPEN_CLUELY_E2E_NETWORK_POLICY || '')
    .trim()
    .toLowerCase() === E2E_NETWORK_POLICY_VALUE;
}

function normalizeHostname(value) {
  let hostname = String(value || '').trim().toLowerCase();
  if (hostname.startsWith('[') && hostname.includes(']')) {
    hostname = hostname.slice(1, hostname.indexOf(']'));
  } else if (hostname.includes(':') && net.isIP(hostname) !== 6) {
    hostname = hostname.split(':', 1)[0];
  }
  return hostname.replace(/\.$/, '');
}

function isLoopbackHostname(value) {
  const hostname = normalizeHostname(value);
  return hostname === '127.0.0.1'
    || hostname === 'localhost'
    || hostname === '::1';
}

function isAllowedResourceUrl(value) {
  try {
    const candidate = value instanceof URL
      ? value
      : new URL(String(value?.url || value || ''));
    if (candidate.protocol === 'file:' || candidate.protocol === 'data:') {
      return true;
    }
    if (!['http:', 'https:', 'ws:', 'wss:'].includes(candidate.protocol)) {
      return false;
    }
    return isLoopbackHostname(candidate.hostname);
  } catch {
    return false;
  }
}

function isAllowedHttpTarget(target, defaultProtocol) {
  if (target instanceof URL || typeof target === 'string') {
    return isAllowedResourceUrl(target);
  }

  if (!target || typeof target !== 'object') {
    return true;
  }
  if (target.socketPath) {
    return true;
  }

  const hostname = target.hostname ?? target.host;
  if (hostname == null || hostname === '') {
    return true;
  }

  const protocol = String(target.protocol || defaultProtocol);
  const normalizedHost = normalizeHostname(hostname);
  return isAllowedResourceUrl(
    `${protocol}//${normalizedHost.includes(':') ? `[${normalizedHost}]` : normalizedHost}`
  );
}

function isAllowedSocketTarget(args) {
  const first = args[0];
  if (typeof first === 'string') {
    return true;
  }

  if (first && typeof first === 'object') {
    if (first.path) {
      return true;
    }
    return isLoopbackHostname(first.host ?? first.hostname ?? 'localhost');
  }

  const host = typeof args[1] === 'string' ? args[1] : 'localhost';
  return isLoopbackHostname(host);
}

function createBlockedError(transport) {
  const error = new Error(
    `E2E network policy blocked an outbound ${transport} request`
  );
  error.code = 'OPEN_CLUELY_E2E_NETWORK_BLOCKED';
  return error;
}

function createPolicyEventWriter(environment, fsModule = fs) {
  return (event) => {
    const reportPath = String(
      environment?.OPEN_CLUELY_E2E_NETWORK_REPORT_PATH || ''
    ).trim();
    if (!reportPath) {
      return;
    }

    const type = ALLOWED_EVENT_TYPES.has(event?.type)
      ? event.type
      : 'blocked-outbound';
    const transport = ALLOWED_TRANSPORTS.has(event?.transport)
      ? event.transport
      : 'node';
    fsModule.appendFileSync(
      reportPath,
      `${JSON.stringify({ type, transport })}\n`,
      { encoding: 'utf8', mode: 0o600 }
    );
  };
}

function createSafeEventEmitter(onPolicyEvent) {
  return (event) => {
    try {
      onPolicyEvent(event);
    } catch {
      // Blocking remains authoritative even if diagnostic reporting fails.
    }
  };
}

function installFunctionGuard(target, name, isAllowed, transport, emitEvent) {
  const original = target?.[name];
  if (typeof original !== 'function') {
    return () => {};
  }

  const guarded = function guardedNetworkCall(...args) {
    if (!isAllowed(...args)) {
      emitEvent({ type: 'blocked-outbound', transport });
      throw createBlockedError(transport);
    }
    return original.apply(this, args);
  };
  target[name] = guarded;

  return () => {
    if (target[name] === guarded) {
      target[name] = original;
    }
  };
}

function installE2ENodeNetworkPolicy(options = {}) {
  const environment = options.environment || process.env;
  if (!isE2ENetworkPolicyEnabled(environment)) {
    return {
      enabled: false,
      restore() {}
    };
  }

  const globalObject = options.globalObject || globalThis;
  const httpModule = options.httpModule || http;
  const httpsModule = options.httpsModule || https;
  const netModule = options.netModule || net;
  const tlsModule = options.tlsModule || tls;
  const emitEvent = createSafeEventEmitter(
    options.onPolicyEvent || createPolicyEventWriter(environment)
  );
  const restorers = [];

  const originalFetch = globalObject.fetch;
  if (typeof originalFetch === 'function') {
    const guardedFetch = function guardedFetch(input, ...args) {
      if (!isAllowedResourceUrl(input)) {
        emitEvent({ type: 'blocked-outbound', transport: 'fetch' });
        return Promise.reject(createBlockedError('fetch'));
      }
      return originalFetch.call(this, input, ...args);
    };
    globalObject.fetch = guardedFetch;
    restorers.push(() => {
      if (globalObject.fetch === guardedFetch) {
        globalObject.fetch = originalFetch;
      }
    });
  }

  restorers.push(
    installFunctionGuard(
      httpModule,
      'request',
      (target) => isAllowedHttpTarget(target, 'http:'),
      'http',
      emitEvent
    ),
    installFunctionGuard(
      httpModule,
      'get',
      (target) => isAllowedHttpTarget(target, 'http:'),
      'http',
      emitEvent
    ),
    installFunctionGuard(
      httpsModule,
      'request',
      (target) => isAllowedHttpTarget(target, 'https:'),
      'https',
      emitEvent
    ),
    installFunctionGuard(
      httpsModule,
      'get',
      (target) => isAllowedHttpTarget(target, 'https:'),
      'https',
      emitEvent
    ),
    installFunctionGuard(
      netModule,
      'connect',
      (...args) => isAllowedSocketTarget(args),
      'net',
      emitEvent
    ),
    installFunctionGuard(
      netModule,
      'createConnection',
      (...args) => isAllowedSocketTarget(args),
      'net',
      emitEvent
    ),
    installFunctionGuard(
      tlsModule,
      'connect',
      (...args) => isAllowedSocketTarget(args),
      'tls',
      emitEvent
    )
  );

  emitEvent({ type: 'policy-ready', transport: 'node' });

  let restored = false;
  return {
    enabled: true,
    restore() {
      if (restored) {
        return;
      }
      restored = true;
      for (const restore of restorers.reverse()) {
        restore();
      }
    }
  };
}

function installE2ESessionNetworkPolicy(session, options = {}) {
  const environment = options.environment || process.env;
  if (!isE2ENetworkPolicyEnabled(environment)) {
    return {
      enabled: false,
      restore() {}
    };
  }
  if (typeof session?.webRequest?.onBeforeRequest !== 'function') {
    throw new Error('E2E renderer network policy could not be installed');
  }

  const emitEvent = createSafeEventEmitter(
    options.onPolicyEvent || createPolicyEventWriter(environment)
  );
  session.webRequest.onBeforeRequest({ urls: ['*://*/*'] }, (details, callback) => {
    if (isAllowedResourceUrl(details?.url)) {
      callback({ cancel: false });
      return;
    }
    emitEvent({ type: 'blocked-outbound', transport: 'renderer' });
    callback({ cancel: true });
  });
  emitEvent({ type: 'policy-ready', transport: 'renderer' });

  return {
    enabled: true,
    restore() {}
  };
}

function mergeSwitchValues(existingValue, requiredValues) {
  return [...new Set([
    ...String(existingValue || '').split(','),
    ...requiredValues
  ].map((value) => value.trim()).filter(Boolean))].join(',');
}

function applyE2EChromiumNetworkPolicy(app, options = {}) {
  const environment = options.environment || process.env;
  if (!isE2ENetworkPolicyEnabled(environment)) {
    return false;
  }

  const commandLine = app?.commandLine;
  if (typeof commandLine?.appendSwitch !== 'function') {
    throw new Error('E2E Chromium network policy could not be installed');
  }
  const disabledFeatures = typeof commandLine.getSwitchValue === 'function'
    ? commandLine.getSwitchValue('disable-features')
    : '';

  commandLine.appendSwitch(
    'disable-features',
    mergeSwitchValues(disabledFeatures, ['AsyncDns', 'DnsOverHttps'])
  );
  commandLine.appendSwitch('disable-async-dns');
  commandLine.appendSwitch('dns-over-https-mode', 'off');
  commandLine.appendSwitch('dns-prefetch-disable');
  commandLine.appendSwitch('host-resolver-rules', E2E_HOST_RESOLVER_RULES);
  return true;
}

function configureE2ENetworkPolicy(app, options = {}) {
  const environment = options.environment || process.env;
  if (!isE2ENetworkPolicyEnabled(environment)) {
    return {
      enabled: false,
      restore() {}
    };
  }

  applyE2EChromiumNetworkPolicy(app, { environment });
  return installE2ENodeNetworkPolicy({
    ...options,
    environment
  });
}

module.exports = {
  E2E_HOST_RESOLVER_RULES,
  E2E_NETWORK_POLICY_VALUE,
  applyE2EChromiumNetworkPolicy,
  configureE2ENetworkPolicy,
  installE2ENodeNetworkPolicy,
  installE2ESessionNetworkPolicy,
  isAllowedResourceUrl,
  isE2ENetworkPolicyEnabled
};
