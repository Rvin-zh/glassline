# API, IPC, Companion REST & MCP Protocol Reference

Complete technical contract for Glassline's **Model Context Protocol (MCP)** stdio server, **Localhost Companion REST API**, **Electron IPC / Preload**, and **AI Adapter** interfaces.

---

## 1. MCP Server Reference (`glassline-mcp`)

- **Implementation:** `source/src/mcp/glassline-mcp-server.js`
- **Entrypoint:** `node source/scripts/run-mcp-server.js` (`npm run mcp`)
- **Transport:** JSON-RPC 2.0 over `stdio`, auto-detecting both:
  - **NDJSON** (newline-delimited JSON objects per line)
  - **Content-Length framing** (`Content-Length: <bytes>\r\n\r\n<json>`)
- **Supported Core Methods:** `initialize`, `notifications/initialized`, `notifications/cancelled`, `ping`, `tools/list`, `tools/call`, `resources/list`, `resources/read`

### MCP Tools

#### `glassline_get_session_context`
Loads pinned resume text, target job description, approved durable study notes, archived session summaries, and active mock-interview session state.
- **Arguments:**
  - `includeArchivedSessions` *(boolean, optional, default `true`)*
- **Returns:** `{ success, source, resume, jobDescription, durableNotes, interviewSessions, practiceState }`

#### `glassline_practice_generate_question`
Generates the next non-repeating text interview question and sets it as the active practice question.
- **Arguments:**
  - `domain` *(string, optional)*: `"mixed" | "coding" | "system-design" | "behavioral" | "conceptual"`
  - `difficulty` *(string, optional)*: `"junior" | "mid" | "senior" | "staff"`
  - `topic` *(string, optional)*: Focused concept or problem area
  - `programmingLanguage` *(string, optional)*: Override default coding language
  - `allowOfflineFallback` *(boolean, optional, default `true`)*
- **Returns:** `{ success, question: { id, domain, resolvedDomain, difficulty, topic, promptText, createdAt }, text, offline, provider, model, state }`

#### `glassline_practice_evaluate_response`
Evaluates a candidate's text answer and produces structured coaching, **"How to Respond Instead (Model Answer)"**, and an **"Actionable Improvement Plan"**.
- **Arguments:**
  - `candidateAnswer` *(string, **required**)*
  - `question` *(string, optional — defaults to current active practice question)*
  - `domain` *(string, optional)*
  - `difficulty` *(string, optional)*
  - `programmingLanguage` *(string, optional)*
  - `allowOfflineFallback` *(boolean, optional, default `true`)*
- **Returns:** `{ success, turnId, question, candidateAnswer, text, evaluation, offline, provider, model, state }`

#### `glassline_save_study_note`
Persists an approved study takeaway or weakness reminder to sealed `app-state.json` (`durableNotes`).
- **Arguments:**
  - `note` *(string, **required**)*
  - `tag` *(string, optional)*: Prefixed as `[tag] ...`
- **Returns:** `{ success, savedNote, totalDurableNotes }`

#### `glassline_list_interview_sessions`
Returns metadata (`id`, `archivedAt`, `title`, `summary`) for archived sessions without exposing secrets.

#### `glassline_bridge_status`
Reports MCP server metadata, localhost HTTP bridge health (`http://127.0.0.1:7823/api/agent/status`), local state path, headless AI readiness, active practice state, and `detectedCliAgents` (`claude`, `codex`, `antigravity`, `cursor`).

### MCP Resources

| URI | Mime Type | Contents |
| :--- | :--- | :--- |
| `glassline://context/profile` | `application/json` | Pinned `resume`, `jobDescription`, `durableNotes`, and `programmingLanguage` |
| `glassline://practice/current-session` | `application/json` | Snapshot from `practiceService.getState()` (`domain`, `difficulty`, `currentQuestion`, `turns`) |

---

## 2. Localhost Companion REST Bridge (`127.0.0.1:7823`)

Hosted by `source/src/main-process/features/mobile-server/server.js`. All `/api/agent/*` routes enforce loopback origin validation (`127.0.0.1`, `::1`, `::ffff:127.0.0.1`, `localhost`) and return `403 Forbidden` to non-loopback peers.

| Method & Path | Request Body | Description |
| :--- | :--- | :--- |
| `GET /api/agent/status` | — | Returns `{ ok, service: 'glassline', port, aiReady, provider, model, practiceState }`. |
| `GET /api/agent/context` | — | Returns `{ ok, resume, jobDescription, durableNotes, interviewSessions, practiceState }`. |
| `POST /api/agent/practice/question` | `{ domain?, difficulty?, topic?, programmingLanguage?, allowOfflineFallback? }` | Generates a practice question using the shared Electron `practiceService`. |
| `POST /api/agent/practice/evaluate` | `{ question?, candidateAnswer, domain?, difficulty?, programmingLanguage?, allowOfflineFallback? }` | Evaluates candidate answer and records the turn in the shared session state. |

### Example `curl` Flow
```bash
# Check companion status
curl -s http://127.0.0.1:7823/api/agent/status | jq .

# Generate a practice question
curl -s -X POST http://127.0.0.1:7823/api/agent/practice/question \
  -H "Content-Type: application/json" \
  -d '{"domain":"system-design","difficulty":"mid","topic":"Webhook Delivery"}'

# Evaluate a written answer
curl -s -X POST http://127.0.0.1:7823/api/agent/practice/evaluate \
  -H "Content-Type: application/json" \
  -d '{"candidateAnswer":"Use an ingestion API gateway in front of a tenant-partitioned Kafka queue, exponential backoff retries with jitter, circuit breakers for slow subscribers, and a dead-letter queue for inspection."}'
```

---

## 3. Electron IPC & Preload Practice APIs

Registered in `source/src/main-process/features/assistant/ipc.js` and exposed cleanly to the renderer via `source/src/windows/assistant/preload/actions.js`:

| IPC Channel | Preload Method (`window.electronAPI.*`) | Streaming Action ID | Purpose |
| :--- | :--- | :--- | :--- |
| `practice-next-question` | `practiceNextQuestion(payload)` | `practiceQuestion` | Generate next text interview question |
| `practice-evaluate-response` | `practiceEvaluateResponse(payload)` | `practiceEvaluate` | Critique text answer, show model answer, and build improvement plan |
| `practice-get-state` | `practiceGetState()` | — | Fetch current `practiceService.getState()` |
| `practice-reset-session` | `practiceResetSession()` | — | Clear active question, turns, and asked topics |
