# Electron End-to-End Verification Design

## Goal

Add a deterministic Electron end-to-end suite that exercises Open-Cluely's real main, preload, renderer, IPC, and streaming provider path without using paid APIs or modifying the user's saved state.

## Test tiers

- `npm test` remains the fast Node unit/integration suite.
- `npm run test:e2e` runs the isolated Electron suite.
- `npm run verify` runs unit/integration tests, Electron E2E, and Fedora smoke diagnostics. This is the required command after each feature change.
- `npm run verify:live` adds opt-in Portkey model streaming and OpenAI realtime STT smoke checks using environment credentials. It never prints keys or transcript content.

## Architecture

`scripts/e2e-electron.js` owns the test lifecycle:

1. Create a temporary state directory and user-data directory.
2. Start a loopback-only fake Portkey/OpenAI-compatible gateway on an ephemeral port.
3. Seed isolated app state selecting Portkey and the fake gateway.
4. Start Electron directly with an ephemeral DevTools port, the normal Fedora display policy, and E2E isolation environment variables.
5. Connect to the renderer through Chrome DevTools Protocol using the existing `ws` dependency.
6. Drive visible controls and inspect renderer state.
7. Close Electron and the fake gateway and delete all temporary state, including on failure or signals.

The fake gateway's `/v1/chat/completions` endpoint emits delayed OpenAI-compatible SSE chunks. This verifies incremental streaming through the actual Portkey adapter, facade, assistant IPC, preload bridge, stream event listeners, message store, and chat DOM. It does not replace provider-level unit tests or optional live-provider checks.

## Isolation

- `OPEN_CLUELY_STATE_DIR` makes development app-state persistence use a temporary directory.
- `OPEN_CLUELY_DISABLE_MOBILE=1` prevents the E2E process from binding the normal mobile companion port.
- Electron receives a temporary `--user-data-dir`, preventing single-instance lock and browser-profile collisions with the user's running app.
- The test server binds only to `127.0.0.1` on an operating-system-selected port.
- No configured API key, CV, job description, transcript, memory, or other user data is read or changed.

## Deterministic E2E scenarios

The first suite verifies:

1. The renderer reaches ready state under the Fedora XWayland launch policy.
2. Linux reduced effects are active and toolbar controls do not overlap the drag region.
3. Settings open and show the seeded Portkey provider, model, provider slug, and local base URL.
4. A typed chat message is sent through the full provider path.
5. The assistant message changes at least twice before completion and ends with the exact concatenated fake response.
6. Theme and clear-chat controls respond.
7. Document paste travels through renderer/preload/IPC and reports stored character count in isolated state.
8. Search remains disabled and does not make an external network request.

OS permission paths such as real microphone, host-audio portal selection, and screenshots remain in Fedora/live smoke tests because they require user/compositor interaction and are not deterministic in headless automation.

## Streaming assertions

The fake provider sends at least three chunks with short delays. The runner records distinct assistant-message text snapshots and requires:

- at least two non-empty incremental states;
- snapshots in monotonic prefix order;
- an exact final response;
- no renderer, provider, or IPC error message;
- completion before a fixed timeout.

This prevents a false-positive test that only checks the final response after buffering.

## Failure handling

Every wait has a bounded timeout with a scenario-specific error. On failure, the runner reports sanitized main-process output and a compact DOM snapshot without credentials or user content. Cleanup always terminates Electron and closes servers. A nonzero exit status fails `npm run test:e2e` and therefore `npm run verify`.

## Dependency policy

Use Node core modules plus the existing `ws` package. Do not add Playwright, Puppeteer, or a browser download. Electron itself supplies the browser runtime.
