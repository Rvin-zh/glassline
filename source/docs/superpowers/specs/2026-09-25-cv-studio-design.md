# CV Studio

## Goal

Build a local CV studio that turns one real resume into a US-style resume which passes automatic applicant-tracking checks, can be tailored to a pasted job description, and still reads like a person wrote it.

Glassline stays the live interview overlay. This studio does not search for jobs and does not submit applications.

## Non-goals

- No job-board search, scoring of listings, or application tracking.
- No automatic applying, form filling, or detector-evasion for submissions.
- No write-back into Glassline's stored resume or job description in this version. Export is a PDF and a plain-text file.
- No photo, sidebar, skill bars, icons, or multi-column layout.
- No invented employers, titles, dates, metrics, degrees, or tools.

## Decisions

- The template is a US-style resume: no photo, one column, standard headings.
- Default length is one page. A second page is allowed only when the earliest and latest experience dates are more than ten years apart and dropping the oldest role would remove a fact that shares a term with the pasted job. A third page is never produced. If those dates cannot be computed, the export stays on one page.
- The studio is its own program in `cv-studio/` at the repository root. It does not import Glassline, and Glassline does not import it.
- Tailoring and humanization use one chat-model interface. The user supplies their own API key in `cv-studio/.env`, which stays gitignored. Unit tests inject a fake model and do not call the network.
- A baseline export (wording, length, sections, buzzword removal) works with no job description. Keyword tailoring runs only after a job description is pasted.

## Success criteria

1. Import from pasted text, PDF, or DOCX produces a fact bank of employers, titles, dates, and skills. Text that cannot be read returns the original file untouched and asks for a paste.
2. Every exported bullet traces to a fact-bank entry. A company, date, metric, or tool that is not in the bank never appears in the PDF or the text export.
3. The ATS check rejects a photo, a table, an icon, a text box, and a second column. It requires selectable text and the headings Experience, Education, and Skills when those fact-bank sections are non-empty.
4. With a job description, the keyword report lists each requirement as covered, missing, or refused. Refused means the fact bank cannot support the word. Covered words appear in Skills or in a bullet, not as a hidden list.
5. The summary is at most three lines. It states a target title only when the job description or the fact bank contains that title. Proof lines use facts only.
6. None of these labels appear in the export, in any case: results-driven, passionate, dynamic, team player, synergy, go-getter, detail-oriented, thought leader, rockstar, leveraged, spearheaded, utilized.
7. `npm test` in `cv-studio/` covers fact locking, the ATS check, length, the keyword report, and buzzword removal without a network call.

## Resume rules

These rules apply to the baseline export and to every tailored export.

### Length

- One page by default. Second page only under the rule in Decisions. Never three pages.
- Two to five bullets per role. A bullet is one line and at most 25 words.
- Summary is two or three lines, or it is omitted when the fact bank has no proof that matches the job.

### Sections, in order

1. Name and contact: city, email, phone, and one of LinkedIn or GitHub when present in the source. No street address, age, marital status, or photo.
2. Summary, when it has proof.
3. Skills, as a plain comma-separated list. No bars. At most 15 skills. With a job description, list skills that appear in that description first, then remaining fact-bank skills in source order, and stop at 15. With no job description, keep the first 15 skills in source order.
4. Experience, newest first.
5. Education.
6. Projects or certifications only when an entry in the fact bank matches a term in the pasted job. If there is no job description, omit this block.

No objective line and no "references available" line.

### Wording

- Each bullet is a verb, the work, and a result that already exists in the fact bank.
- Past roles use past tense. The current role uses present tense.
- No first person and no "responsible for."
- A number appears only when that number is in the fact bank.

### Keywords

- Use a job-description term only when a fact supports it.
- Place supported terms in Skills and, where natural, inside a bullet.
- Do not repeat a term to raise a count. Once in Skills and once in a bullet is the maximum.
- The report has three lists: covered, missing, and refused.

### Buzzwords and humanization

- Remove these labels exactly, in any case: results-driven, passionate, dynamic, team player, synergy, go-getter, detail-oriented, thought leader, rockstar, leveraged, spearheaded, utilized. This list is complete for this version.
- Replace a removed label with a concrete tool or outcome from the same fact, or delete the label and leave the rest of the sentence.
- Keep bullet lengths uneven. Do not give every role the same number of bullets or the same sentence shape.
- Do not add a claim while humanizing.

### Summary

- Line one: target title, years, and domain, using only titles and domains present in the job description or the fact bank.
- Following lines: at most two proofs from the fact bank that share a term with the job description.
- If there is no job description, omit the summary rather than write a generic one.
- If a proof is not in the fact bank, shorten the summary. Do not fill the gap.

## Architecture

```text
paste / PDF / DOCX
        →  import
        →  fact bank (locked)
        →  baseline rewrite (wording, length, sections, buzzwords)
        →  optional tailor (pasted job description + keyword report)
        →  humanize (phrasing only)
        →  ATS check
        →  PDF + plain text

chat model  ← tailor and humanize only
ATS check and fact lock do not call the model
```

| Unit | Purpose | Depends on |
| --- | --- | --- |
| `import` | Read paste, PDF, or DOCX into a fact bank | File parsers only |
| `fact-bank` | Store employers, titles, dates, skills, education, projects. Answer "does this claim exist?" | Nothing |
| `rules` | Apply length, section order, wording, and buzzword lists | Fact bank |
| `tailor` | Reorder and rephrase toward a job description. Emit the keyword report | Fact bank, rules, model |
| `humanize` | Vary rhythm and strip AI-sounding phrasing without new claims | Fact bank, rules, model |
| `ats-check` | Reject photos, tables, icons, text boxes, and extra columns. Require selectable text and standard headings | Rendered document |
| `export` | Write one-column PDF and UTF-8 text that both pass `ats-check` | Rules, ats-check |

The model client is a single function: given a prompt and the fact bank, return text. `tailor` and `humanize` call it. `import`, `rules`, `ats-check`, and `export` do not.

## Data flow

1. Import writes the fact bank and keeps the source text for audit.
2. Baseline rewrite produces a resume document that obeys the resume rules and contains no job-specific keywords beyond words already in the facts.
3. If a job description is present, tailor returns a new document plus the keyword report. The checker drops any sentence whose employers, dates, metrics, or tools are not in the bank, asks the model once to rewrite that sentence, and drops the sentence if the second try still fails.
4. Humanize edits phrasing on the document that passed the checker. The same checker runs again and drops any new claim.
5. Export renders the document. If `ats-check` fails, export returns the failure list and does not write files.

## Error handling

- Unreadable PDF or DOCX: no fact bank is saved. The user is told to paste the text.
- Empty fact bank: tailor, humanize, and export refuse to run.
- Model timeout or API error: keep the last document that passed the fact checker. Do not write a partial PDF.
- Job description shorter than 40 characters: treat it as missing and produce the baseline export only.
- Second-page rule fails closed: if years of experience cannot be computed from the dates, stay on one page.

## Testing

Tests live in `cv-studio/` and use a fake model.

- Fact lock: a model reply that adds "Kubernetes" or a fake employer is dropped.
- Keyword report: a supported term is covered, an absent term is refused, a job term with no fact is missing.
- ATS check: a two-column fixture and a photo fixture fail; the studio's own export passes.
- Length: a three-page fixture is rejected; a one-page export is accepted.
- Buzzwords: each banned label is absent from the export.
- Summary: with no job description, the export has no summary section.

## What this version does not decide

Glassline import of the plain-text export, job search, and automatic applying are later projects. They are not part of this studio's first implementation plan.
