# Interactive Interview Practice & Coaching Guide

Glassline's core workflow transforms interview prep into a structured **Ask -> Respond in Text -> Evaluate & Rewrite -> Deliberate Improvement Plan** cycle. This guide covers both the desktop Electron UI and agent-driven text practice sessions inside Cursor, Claude Code, Antigravity, or Codex.

---

## 1. Practice Domains & Seniority Calibration

Defined in `source/src/services/ai/interview-practice.js`, Glassline organizes questions across five domains (`PRACTICE_DOMAINS`) and four seniority levels (`PRACTICE_DIFFICULTIES`):

| Domain ID | Focus Areas Covered | Ideal Preparation Use Case |
| :--- | :--- | :--- |
| `mixed` | Rotates coding, system design, behavioral STAR, and core CS concepts | Full-loop mock interviews & comprehensive academic reviews |
| `coding` | Hash maps, LRU/TTL data structures, scheduling algorithms, complexity bounds, edge cases | Whiteboard & online coding assessments in your selected language |
| `system-design` | Partitioned queues, webhook/notification pipelines, circuit breakers, DLQs, SLA bottlenecks | Distributed systems & backend architecture coursework/interviews |
| `behavioral` | Technical disagreements, ownership, incident postmortems, cross-team trade-offs (STAR) | Behavioral rounds & graduate/engineering fellowship interviews |
| `conceptual` | DB isolation levels (`Read Committed`, `Snapshot Isolation`, `SSI`), write skew, concurrency | Fundamental CS & systems internals questioning |

Supported difficulty targets: `junior`, `mid`, `senior`, `staff`.

---

## 2. How Coaching Feedback Is Structured

Every evaluation request (`buildPracticeEvaluationPrompt` and `scoreOfflineAnswer`) enforces a standardized 4-section Markdown coaching report so candidates immediately understand *why* an answer fell short and *exactly how to phrase a stronger version*:

1. **`## Evaluation & Rubric Score`**
   - Overall score out of `10` (`X/10`)
   - Ratings covering **Clarity**, **Technical Depth**, **Structure**, and **Completeness**
2. **`## Strengths & Gaps`**
   - Concrete strengths observed in the candidate's written answer
   - Specific omissions such as missing time/space complexity, unaddressed concurrency or timeout failures, vague behavioral outcomes, or absent trade-offs
3. **`## How to Respond Instead (Model Answer)`**
   - Rewrites the candidate's answer into a concise, high-signal benchmark response:
     - **Technical / System Design:** Opens with clarifying assumptions, states clean baseline architecture or algorithm, gives explicit complexity/throughput math, and handles edge cases.
     - **Behavioral:** Uses explicit **Situation -> Task -> Action -> Result (STAR)** framing with concrete engineering metrics.
4. **`## Actionable Improvement Plan`**
   - 3–4 concrete study tasks tailored to the candidate's response gaps: immediate 5-minute rewrite instruction, a 10–15 minute deliberate-practice drill, and a calibrated follow-up question.

---

## 3. Running a Session in the Desktop Studio

1. **Optional Context Pinning:** Open **Settings** and paste/attach your **Resume / CV** and target **Job Description** so generated questions and critiques align with your background.
2. **Select Domain:** Use the **Practice Domain** selector (`#practice-domain-select`) in the action toolbar (`Mixed`, `Coding`, `System Design`, `Behavioral`, `CS Concepts`).
3. **Ask Question:** Click **`Ask Question`** (`#practice-question-btn`). Glassline posts the formatted question and evaluation rubric signals into the conversation thread without leaking the solution.
4. **Respond in Text:** Type your complete answer into the bottom composer (`#chat-manual-input`) and press **Enter** (or click **Send**). Because a practice question is active (`activePracticeQuestion !== null`), Glassline routes your submission straight into coaching evaluation!
5. **Iterate or Re-Coach:** You can refine an answer in chat or click **`Coach & Plan`** (`#practice-evaluate-btn`) at any time to re-evaluate your response and generate an updated model rewrite and improvement plan.
6. **Reset Turn:** Click the Clear button (`#clear-btn`) to clear the thread and invoke `practice-reset-session`.

---

## 4. Running a Practice Session via Cursor, Claude Code, Antigravity, or Codex

Once connected via MCP (`node source/scripts/run-mcp-server.js`), your IDE or CLI coding agent acts directly as an interactive text interviewer:

1. **Load Candidate Profile:** The agent calls `glassline_get_session_context` to read your pinned resume, job context, and previously saved study notes.
2. **Agent Asks Question:** The agent calls `glassline_practice_generate_question` with your chosen `domain`, `difficulty`, and optional `topic`, then presents the question in chat without showing the solution.
3. **User Replies in Text:** You write your answer in plain text (or pseudo-code / code block) right in the agent conversation.
4. **Agent Coaches & Suggests Better Answer:** The agent calls `glassline_practice_evaluate_response` with `{ question, candidateAnswer, domain, difficulty }`, returning your rubric score, **How to Respond Instead (Model Answer)**, and **Actionable Improvement Plan**.
5. **Persist Weak Spots:** When you spot a recurring weakness (e.g., *"forgetting write-skew mitigation examples"* or *"needing quantified STAR metrics"*), the agent calls `glassline_save_study_note` so future sessions target that gap.

---

## 5. Offline Built-in Rubric Mode vs Live LLM Mode

- **Offline / No API Key (`Built-in Rubric Mode`):** Ideal for air-gapped classrooms, automated demos, and CI checks (`npm run agents:verify`). Uses curated non-repeating questions in `OFFLINE_QUESTION_BANK` and deterministic heuristic scoring across word count, structural discourse markers, quantitative metrics/complexity tokens, and failure-mode keywords, paired with domain-appropriate model answers.
- **Live AI Mode:** Automatically activated whenever Gemini API, Portkey AI Gateway, or a configured `CliAgentService` (`claude`, `codex`, `agy`, `cursor`) is ready—streaming dynamic follow-ups tailored word-for-word to your written draft and resume.
