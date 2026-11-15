# Glassline — Claude Code Instructions

This repository implements **Glassline**, an interactive text-based AI Interview Practice Simulator, Coaching Studio, and Multi-Agent MCP Bridge.

## MCP Server (`.mcp.json`)
Claude Code automatically discovers the Glassline MCP server in `.mcp.json`:
- Server name: `glassline`
- Entrypoint: `node source/scripts/run-mcp-server.js`

### Interview Practice Workflow for Claude Code
When helping a user practice interviews in text:
1. Read candidate background & saved study notes via `glassline_get_session_context`.
2. Ask ONE tailored question via `glassline_practice_generate_question` (do not reveal the answer yet).
3. Wait for the candidate's written answer.
4. Evaluate their answer via `glassline_practice_evaluate_response` and provide:
   - Rubric score & specific gaps
   - **How to Respond Instead (Model Answer)**
   - **Actionable Improvement Plan**
5. Persist key takeaways via `glassline_save_study_note`.

## Development & Tests
- Install & run unit/integration tests from `source/`:
  - `cd source && npm test`
  - `cd source && npm run agents:verify`
