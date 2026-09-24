# Electron End-to-End Verification Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add isolated, deterministic Electron E2E verification for UI controls, IPC, document state, and incremental LLM streaming.

**Architecture:** A Node runner starts a loopback fake Portkey/OpenAI-compatible gateway, seeds temporary state, launches the real Electron application with an isolated browser profile, and drives the renderer over Chrome DevTools Protocol. The fake provider emits delayed SSE chunks so the suite proves incremental DOM updates rather than only final output.

**Tech Stack:** Node 22 core modules, Electron 44, existing `ws`, Node test runner, Chrome DevTools Protocol.

## Global Constraints

- Do not add Playwright, Puppeteer, or browser downloads.
- Never read or mutate the normal `cache/app-state.json` during E2E.
- Never print API keys, CV/JD text, memory, or user transcripts.
- Bind fake services only to `127.0.0.1` and operating-system-selected ports.
- `npm test` stays fast; `npm run verify` runs unit, E2E, and Fedora smoke checks.
- Run `npm run verify` after every subsequent feature.
- Do not make partial implementation commits from already-modified source files; request the final integration action after all checks pass.

---

### Task 1: Add app isolation seams

**Files:**
- Modify: `src/services/state/app-state.js`
- Modify: `src/main-process/features/mobile-server/server.js`
- Test: `test/e2e-isolation.test.js`

**Interfaces:**
- Consumes: `process.env.OPEN_CLUELY_STATE_DIR`, `process.env.OPEN_CLUELY_DISABLE_MOBILE`
- Produces: isolated state path and a disabled mobile-server implementation with the existing `broadcast`, `getStatus`, `emitStatus`, and `close` methods

- [ ] **Step 1: Write failing isolation tests**

Test that setting `OPEN_CLUELY_STATE_DIR=/tmp/example` makes `getAppStatePath()` return `/tmp/example/cache/app-state.json`. Test that `createMobileServer({ disabled: true })` reports `listening: false` and never calls `httpServer.listen`.

- [ ] **Step 2: Verify the tests fail**

Run:

```bash
node --test --test-reporter=spec test/e2e-isolation.test.js
```

Expected: FAIL because app state ignores the override and mobile server has no disabled mode.

- [ ] **Step 3: Implement the state override**

In `getAppStateBaseDir`, resolve a non-empty `OPEN_CLUELY_STATE_DIR` before the development/packaged branches:

```js
const explicitStateDir = String(process.env.OPEN_CLUELY_STATE_DIR || '').trim();
if (explicitStateDir) {
  return path.resolve(explicitStateDir);
}
```

Export `getAppStateBaseDir` for focused testing.

- [ ] **Step 4: Implement disabled mobile mode**

Add a `disabled` option defaulting from `OPEN_CLUELY_DISABLE_MOBILE === '1'`. Skip `listen()` when disabled, retain the existing no-op-safe public interface, and set a non-secret status reason such as `disabled-for-e2e`.

- [ ] **Step 5: Verify Task 1**

Run:

```bash
node --test --test-reporter=spec test/e2e-isolation.test.js
```

Expected: all isolation tests PASS.

---

### Task 2: Add E2E support modules

**Files:**
- Create: `scripts/e2e/fake-portkey-gateway.js`
- Create: `scripts/e2e/cdp-client.js`
- Test: `test/e2e-support.test.js`

**Interfaces:**
- Produces: `createFakePortkeyGateway({ chunks, chunkDelayMs })`
- Produces: `connectCdp(webSocketUrl)` with `call`, `evaluate`, `waitFor`, and `close`

- [ ] **Step 1: Write failing support tests**

Verify that the fake server:

```js
const fake = await createFakePortkeyGateway({
  chunks: ['Stream', 'ing ', 'works']
});
```

binds to loopback and emits three parseable `/v1/chat/completions` SSE chunks in order. Verify `close()` releases the port. Test CDP message correlation with a fake WebSocket that returns responses out of order.

- [ ] **Step 2: Verify the tests fail**

Run:

```bash
node --test --test-reporter=spec test/e2e-support.test.js
```

Expected: FAIL because support modules do not exist.

- [ ] **Step 3: Implement the fake Portkey gateway**

Return:

```js
{
  baseUrl: `http://127.0.0.1:${port}/v1`,
  requests,
  close: () => new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))
}
```

`POST /v1/chat/completions` must record sanitized model/messages, set `text/event-stream`, emit one OpenAI-compatible chat-completion chunk per delayed content fragment, then emit a stop chunk and `[DONE]`.

- [ ] **Step 4: Implement the CDP client**

Use incrementing numeric IDs and a pending promise map. `evaluate(expression)` calls `Runtime.evaluate` with `awaitPromise: true` and `returnByValue: true`. `waitFor(expression, { timeoutMs, intervalMs })` repeatedly evaluates until the returned value is truthy, then throws a sanitized timeout.

- [ ] **Step 5: Verify Task 2**

Run:

```bash
node --test --test-reporter=spec test/e2e-support.test.js
```

Expected: all support tests PASS.

---

### Task 3: Add the Electron E2E runner

**Files:**
- Create: `scripts/e2e-electron.js`
- Modify: `scripts/run-electron.js`
- Test: `test/e2e-runner-contract.test.js`

**Interfaces:**
- Consumes: fake Portkey gateway and CDP support modules
- Produces: process exit 0 on complete E2E success, nonzero with sanitized diagnostics on failure

- [ ] **Step 1: Write the failing runner contract test**

Check that the runner exports `runElectronE2E`, accepts injected `electronBinary`, `spawn`, and fake-server dependencies, and registers cleanup for success, failure, `SIGINT`, and `SIGTERM`.

- [ ] **Step 2: Verify the contract test fails**

Run:

```bash
node --test --test-reporter=spec test/e2e-runner-contract.test.js
```

Expected: FAIL because the runner is absent.

- [ ] **Step 3: Implement process lifecycle**

Create temporary directories with `fs.mkdtempSync(path.join(os.tmpdir(), 'open-cluely-e2e-'))`. Seed `cache/app-state.json` with:

```js
{
  aiProvider: 'portkey',
  portkeyApiKey: 'e2e-portkey-test-key',
  portkeyProvider: '@e2e',
  portkeyBaseUrl: fake.baseUrl,
  geminiModel: 'gemini-3.8-flash',
  programmingLanguage: 'Python',
  promptCacheEnabled: false,
  webSearchEnabled: false,
  requestWebSearchEnabled: false
}
```

Launch Electron with `--ozone-platform=x11`, `--remote-debugging-port=<ephemeral>`, `--user-data-dir=<temporary>`, `--no-sandbox`, and the repository app path. Set `OPEN_CLUELY_STATE_DIR`, `OPEN_CLUELY_DISABLE_MOBILE=1`, and `OPEN_CLUELY_DISPLAY_PROFILE=xwayland`.

- [ ] **Step 4: Implement deterministic scenarios**

Use CDP to assert:

- `document.documentElement` includes `platform-linux` and `reduced-effects`;
- all main-interface buttons begin below the drag handle;
- Settings opens and shows the seeded Portkey configuration;
- document paste reports the expected character count;
- entering `E2E stream request` and clicking Send creates a user message;
- assistant content has at least two distinct prefix-ordered snapshots before it equals `Streaming works`;
- theme toggles;
- Clear removes test messages.

- [ ] **Step 5: Implement sanitized cleanup**

In `finally`, close CDP and fake server, terminate only the spawned Electron process tree, and remove the temporary directory. Filter captured logs so values matching common API-key patterns or the seeded document text cannot be printed.

- [ ] **Step 6: Verify Task 3**

Run:

```bash
node --test --test-reporter=spec test/e2e-runner-contract.test.js
node scripts/e2e-electron.js
```

Expected: contract tests PASS and runner prints each scenario as PASS, including `incremental chat streaming`.

---

### Task 4: Add verification commands and documentation

**Files:**
- Modify: `package.json`
- Modify: `README.md`
- Modify: `FEDORA.md`

**Interfaces:**
- Produces: `npm run test:e2e`, `npm run verify`, `npm run verify:live`

- [ ] **Step 1: Add scripts**

Add:

```json
{
  "test:e2e": "node scripts/e2e-electron.js",
  "verify": "npm test && npm run test:e2e && npm run smoke:fedora",
  "verify:live": "npm run verify && npm run benchmark:models && npm run smoke:stt"
}
```

- [ ] **Step 2: Document test tiers**

Document that `verify` is deterministic and isolated, while `verify:live` requires `PORTKEY_API_KEY` or `OPENAI_API_KEY`, incurs provider usage, and never logs credentials or transcript content.

- [ ] **Step 3: Run complete verification**

Run:

```bash
npm run verify
```

Expected: all Node tests pass, all Electron E2E scenarios pass, and Fedora smoke diagnostics report all checks true.

- [ ] **Step 4: Run configured live verification**

Run with credentials supplied through the existing environment:

```bash
npm run verify:live
```

Expected: deterministic verification passes, model benchmark has successful runs, and realtime STT smoke ends with `smoke-stt: ok`.
