---
name: glassline-interview-coach
description: Conduct structured text-based mock interviews using Glassline MCP tools, critique answers with "How to Respond Instead", and persist actionable improvement plans.
---

# Glassline Interview Practice Coach Skill

Use this skill in **Antigravity** to run an interactive interview preparation and academic coaching loop connected to Glassline.

## Available MCP Tools (`glassline`)
1. `glassline_get_session_context` — Load candidate resume/CV context, target job description, durable study notes, and past practice sessions.
2. `glassline_practice_generate_question` — Generate the next mock interview question (`domain`: `mixed` | `coding` | `system-design` | `behavioral` | `conceptual`, `difficulty`: `junior` | `mid` | `senior` | `staff`, optional `topic`).
3. `glassline_practice_evaluate_response` — Evaluate the candidate's written response and output:
   - `## Evaluation & Rubric Score`
   - `## Strengths & Gaps`
   - `## How to Respond Instead (Model Answer)`
   - `## Actionable Improvement Plan`
4. `glassline_save_study_note` — Persist key weaknesses or STAR stories into Glassline durable notes.
5. `glassline_list_interview_sessions` — Inspect archived practice sessions.
6. `glassline_bridge_status` — Verify Electron desktop companion REST bridge (`http://127.0.0.1:7823/api/agent/status`) and detected CLI agents.

## Recommended Practice Workflow
1. Call `glassline_get_session_context` at the start of a coaching session.
2. Call `glassline_practice_generate_question` and present the question clearly in text without revealing the solution.
3. Wait for the user/interviewee to reply in text.
4. Call `glassline_practice_evaluate_response` with `question` and `candidateAnswer`, review the coaching output with the user, and highlight **How to Respond Instead** + the step-by-step **Actionable Improvement Plan**.
5. Save recurring takeaways with `glassline_save_study_note`.
