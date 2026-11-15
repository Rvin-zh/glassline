# Glassline Source Runbook (`source/`)

This directory contains the Electron application, provider-neutral AI services, stdio MCP server, companion HTTP bridge, agent integration generator, and Node automated test suite.

---

## Requirements

- **Node.js >= 20** (tested on macOS with Node 26 and npm 11)
- **AI Providers (Optional — Offline Built-in Rubric Mode works without API keys):**
  - **Gemini API** (`GEMINI_API_KEY`)
  - **Portkey AI Gateway** (`PORTKEY_API_KEY` + provider slug / Vertex caching support)
  - **Local CLI Agents** via `CliAgentService` (`claude`, `codex`, `agy`, `cursor`)
- **Speech-to-Text (Optional for voice sessions):** AssemblyAI (`ASSEMBLYAI_API_KEY`) or OpenAI Realtime STT (`OPENAI_API_KEY`)

---

## NPM Scripts

Run all commands from `source/`:

| Script | Command | Purpose |
| :--- | :--- | :--- |
| `npm start` | `node scripts/run-electron.js` | Launch the Glassline Electron Interview Practice & Coaching Studio. |
| `npm run dev` | `node scripts/run-electron.js --enable-logging` | Launch with verbose Electron main/renderer logs. |
| `npm run mcp` | `node scripts/run-mcp-server.js` | Start the JSON-RPC 2.0 MCP stdio server (`glassline-mcp`). |
| `npm run agents:setup` | `node scripts/setup-agent-integrations.js` | Regenerate MCP configs & guides for Cursor, Claude Code, Antigravity, and Codex (pass `-- --absolute` for absolute script paths). |
| `npm run agents:verify` | `node scripts/setup-agent-integrations.js --verify` | Validate all 9 integration artifacts and run a live stdio MCP smoke handshake (`initialize`, `tools/list`, `tools/call`). |
| `npm test` | `node --test --test-reporter=spec test/*.test.js test/**/*.test.js` | Run all unit and integration tests under `test/`. |
| `npm run test:e2e` | `node scripts/e2e-electron.js` | Run headless Electron E2E smoke suite in isolated state directory. |
| `npm run verify` | `npm test && npm run test:e2e && ...` | Combined test, Electron E2E, Fedora no-write smoke, and macOS packaging checks. |
| `npm run build` | `node scripts/run-build.js` | Build distributable desktop packages with `electron-builder`. |

---

## Environment Variables

| Variable | Purpose |
| :--- | :--- |
| `OPEN_CLUELY_STATE_DIR` | Override base directory where `cache/app-state.json` is stored (ideal for isolated test runs and academic sandboxes). |
| `OPEN_CLUELY_ENV_PATH` | Explicitly override `.env` resolution path. |
| `OPEN_CLUELY_DISABLE_MOBILE` | Set to `1` to disable binding the port `7823` HTTP + WebSocket companion server (used by isolated E2E runs). |
| `GLASSLINE_AGENT_PORT` | Override companion HTTP bridge port queried by MCP tools (default: `7823`). |
| `GLASSLINE_MCP_DISABLE_BRIDGE_PROBE` | Set to `1` to force MCP tools to operate directly on local state without probing `127.0.0.1:7823`. |
| `GLASSLINE_AI_PROVIDER` | Select default headless provider (`gemini` or `portkey`) when invoking `glassline-mcp-server.js` outside Electron. |

---

## Module Architecture Map

### Core Services (`src/services/ai/`)
- **`interview-practice.js`**: Text-based mock interview orchestrator (`PRACTICE_DOMAINS`, `PRACTICE_DIFFICULTIES`, `buildPracticeQuestionPrompt`, `buildPracticeEvaluationPrompt`, `scoreOfflineAnswer`, `createInterviewPracticeService`).
- **`cli-agent-service.js`**: Implements the `contracts.js` AI adapter interface (`CliAgentService`) for `claude`, `codex`, `agy`, and `cursor` CLIs, plus `detectInstalledCliAgents()`.
- **`assistant-facade.js`**: Provider-neutral wrapper adding `executionContext`, explicit Vertex/Gemini context-cache handling, and unified helpers (`generatePracticeQuestion`, `evaluatePracticeResponse`, `askAiWithSessionContext`, etc.).
- **`prompts.js`**: Central static cacheable system prefix (`STATIC_PROMPT_VERSION`) and prompt construction templates.
- **`contracts.js`**: Duck-typed adapter validator (`assertAiAdapter`) enforced across `GeminiService`, `PortkeyService`, and `CliAgentService`.

### Main Process & Companion Bridges (`src/main-process/` & `src/mcp/`)
- **`start-application.js`**: Electron composition root creating a shared `practiceService` instance passed to both `registerAssistantIpc` and `createMobileServer`.
- **`features/assistant/ipc.js`**: Registers practice IPC channels (`practice-next-question`, `practice-evaluate-response`, `practice-get-state`, `practice-reset-session`) alongside context/memory/AI handlers.
- **`features/mobile-server/server.js`**: Serves the mobile companion UI on port `7823` and exposes localhost-restricted JSON endpoints under `/api/agent/*`.
- **`src/mcp/glassline-mcp-server.js`**: Standalone JSON-RPC 2.0 MCP server with dual stdio framing (`Content-Length` and NDJSON).

### Renderer (`src/windows/assistant/`)
- **`renderer.html` & `styles.css`**: Practice domain selector (`#practice-domain-select`), `Ask Question` (`#practice-question-btn`), and `Coach & Plan` (`#practice-evaluate-btn`).
- **`preload/actions.js`**: Safe IPC wrappers (`practiceNextQuestion`, `practiceEvaluateResponse`, `practiceGetState`, `practiceResetSession`).
- **`renderer.js` & `renderer/features/listeners/event-listeners.js`**: Interactive practice state (`activePracticeQuestion`) that routes chat submissions straight into evaluation & coaching while a practice turn is active.

---

## Platform Guides

- macOS setup & permissions: [`MAC.md`](MAC.md)
- Linux / Fedora Wayland & PipeWire setup: [`FEDORA.md`](FEDORA.md)
- Architecture, practice guide, and MCP reference: [`../docs/`](../docs/)
