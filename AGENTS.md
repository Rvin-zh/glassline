# Glassline — OpenAI Codex / Universal Agent Guide

**Glassline** is an academic & career-readiness software engineering project focused on structured text-based interview simulation, rubric feedback, and multi-agent tooling.

## Agent Connectivity
Connect Codex, Cursor, Claude Code, or Antigravity via the stdio MCP server or local companion HTTP API:
- **MCP command:** `node source/scripts/run-mcp-server.js`
- **Codex TOML snippet:** `integrations/codex/config.toml`
- **Local Companion API (when desktop app is running):** `http://127.0.0.1:7823/api/agent/status`

## MCP Tools Exposed
- `glassline_get_session_context`
- `glassline_practice_generate_question`
- `glassline_practice_evaluate_response`
- `glassline_save_study_note`
- `glassline_list_interview_sessions`
- `glassline_bridge_status`

## Verification Commands
- `cd source && npm test` — Full Node test suite
- `cd source && npm run agents:verify` — Verifies all 4 agent configs + live MCP stdio handshake
