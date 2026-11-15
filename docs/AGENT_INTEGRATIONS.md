# Multi-Agent Integrations Guide (Cursor, Claude Code, Antigravity & Codex)

Glassline is engineered as an **agent-native** interview coaching backend. Any MCP-compatible coding assistant or terminal agent can conduct mock interviews, critique your answers, suggest how to respond instead, build improvement plans, and persist durable study notes. Conversely, Glassline can also call local CLI agents via its outbound `CliAgentService` adapter.

---

## 1. Automated Setup & Verification

From `source/`, run:

```bash
# Generate portable workspace & template files (relative paths: source/scripts/run-mcp-server.js)
npm run agents:setup

# Or generate configs with machine-specific absolute paths (useful for copying into ~/.cursor, ~/.codex, etc.)
npm run agents:setup -- --absolute

# Verify all 9 generated files and run a live stdio MCP round-trip handshake
npm run agents:verify
```

Generated artifacts:
- `.cursor/mcp.json` and `integrations/cursor/mcp.json`
- `.mcp.json`, `integrations/claude-code/.mcp.json`, and `CLAUDE.md`
- `integrations/antigravity/mcp_config.json` and `integrations/antigravity/SKILL.md`
- `integrations/codex/config.toml` and `AGENTS.md`

---

## 2. Per-Agent Configuration Instructions

### Cursor
1. Open the `glassline` repository in Cursor.
2. Cursor automatically detects `.cursor/mcp.json`:
   ```json
   {
     "mcpServers": {
       "glassline": {
         "command": "node",
         "args": ["source/scripts/run-mcp-server.js"],
         "env": {
           "GLASSLINE_AGENT_PORT": "7823"
         }
       }
     }
   }
   ```
3. To enable Glassline globally across *all* Cursor workspaces, run `npm run agents:setup -- --absolute` and merge `integrations/cursor/mcp.json` into `~/.cursor/mcp.json`.
4. **Prompt tip in Cursor Chat / Composer:**
   > *"Use Glassline MCP tools to ask me a senior system-design question based on my profile context. Wait for my text answer, then evaluate it, show how I should respond instead, and give me an improvement plan."*

---

### Claude Code
1. Launching `claude` from the repository root automatically picks up `.mcp.json` and reads coaching instructions from `CLAUDE.md`.
2. Verify registration inside Claude Code using `/mcp` (the `glassline` server should list 6 tools and 2 resources).
3. You can also register Glassline globally via CLI (using absolute path from `--absolute`):
   ```bash
   claude mcp add glassline -- node /ABS/PATH/TO/glassline/source/scripts/run-mcp-server.js
   ```

---

### Google Antigravity (`agy`)
1. Import the MCP server entry from `integrations/antigravity/mcp_config.json` into your Antigravity MCP configuration (or generate absolute paths first via `npm run agents:setup -- --absolute`).
2. Add or install the included coaching skill at `integrations/antigravity/SKILL.md` (`name: glassline-interview-coach`) so Antigravity follows the structured Question -> Candidate Text Response -> Critique & Rewrite -> Improvement Plan -> Study Note workflow.

---

### OpenAI Codex CLI (`codex`)
1. Copy the TOML snippet from `integrations/codex/config.toml` into `~/.codex/config.toml` (or your project's `.codex/config.toml`):
   ```toml
   [mcp_servers.glassline]
   command = "node"
   args = ["source/scripts/run-mcp-server.js"]

   [mcp_servers.glassline.env]
   GLASSLINE_AGENT_PORT = "7823"
   ```
2. Root workflow conventions are documented automatically for Codex in `AGENTS.md`.
3. Ask Codex to run a text interview drill or inspect your Glassline study notes (`glassline_get_session_context`).

---

## 3. Desktop Companion Live Synchronization

When the Glassline Electron desktop app is running (`cd source && npm start`), its companion HTTP server listens on port `7823` and exposes localhost-only endpoints at `http://127.0.0.1:7823/api/agent/*`.

- When an agent calls `glassline_get_session_context`, `glassline_practice_generate_question`, or `glassline_practice_evaluate_response` via MCP, `glassline-mcp-server.js` automatically probes `127.0.0.1:7823` first.
- If the desktop app is running, both your IDE agent and the desktop studio share the live `practiceService` session, pinned documents, and in-memory context.
- If the desktop app is **not** running, `glassline-mcp-server.js` transparently falls back to local sealed state (`OPEN_CLUELY_STATE_DIR` / `cache/app-state.json`) + headless LLM or Built-in Rubric Mode.

---

## 4. Outbound CLI Agent Adapter (`CliAgentService`)

For programmatic pipelines or tests where Glassline delegates prompt execution *outward* to a local coding CLI binary instead of a cloud REST key, `source/src/services/ai/cli-agent-service.js` implements the standard `contracts.js` AI adapter interface across all four tools:

| Adapter ID | Resolved CLI Command | Capabilities |
| :--- | :--- | :--- |
| `claude` / `claude-code` | `claude -p <prompt>` | Text + Streaming (`onChunk`) |
| `codex` / `openai` | `codex exec <prompt>` | Text + Streaming (`onChunk`) |
| `antigravity` / `agy` | `agy chat --prompt <prompt>` | Text + Streaming (`onChunk`) |
| `cursor` | `cursor agent --prompt <prompt>` | Text + Streaming (`onChunk`) |

Inspect availability on the host machine at any time via `detectInstalledCliAgents()` or the `glassline_bridge_status` MCP tool.

---

## 5. Troubleshooting

- **MCP server starts but tool call fails with state path issues:** Set `OPEN_CLUELY_STATE_DIR` explicitly or verify write permissions on `source/cache/`.
- **Agent reports HTTP companion bridge unreachable (`reachable: false`):** This is expected whenever the Electron desktop app is closed; MCP tools automatically operate in standalone mode. Start `cd source && npm start` to share live desktop session state.
- **Verify changes quickly:** Run `cd source && npm run agents:verify && npm test`.
