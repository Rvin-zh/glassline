const test = require("node:test");
const assert = require("node:assert/strict");
const { createFactBank } = require("../src/fact-bank");
const { applyRules, BANNED_LABELS } = require("../src/rules");

const bank = createFactBank({
  skills: ["Python", "SQL"],
  roles: [{
    employer: "Analytical Engines",
    title: "Engineer",
    start: "2018-01",
    end: "2024-01",
    current: false,
    bullets: [
      "Responsible for a results-driven Python service.",
      "I utilized SQL daily."
    ],
    tools: ["Python", "SQL"],
    metrics: []
  }],
  education: [{ institution: "Cambridge", credential: "BA", year: "2016" }],
  projects: [{ name: "Notes", detail: "Compiler" }]
});

test("strips banned labels, first person, and responsible-for", () => {
  const doc = applyRules({
    name: "Ada Lovelace",
    contact: { city: "London", email: "ada@example.com", phone: "", link: "" },
    summary: "Results-driven engineer.",
    skills: bank.skills,
    experience: bank.roles.map((role) => ({ ...role })),
    education: bank.education,
    projects: bank.projects
  }, { jobText: "", factBank: bank });
  const blob = JSON.stringify(doc).toLowerCase();
  for (const label of BANNED_LABELS) {
    assert.equal(blob.includes(label), false, label);
  }
  assert.equal(doc.summary, null);
  assert.equal(doc.projects.length, 0);
  assert.equal(doc.experience[0].bullets.some((line) => /^i\b/i.test(line)), false);
  assert.equal(doc.experience[0].bullets.some((line) => /responsible for/i.test(line)), false);
});

test("keeps at most 15 skills and at most 5 bullets", () => {
  const skills = Array.from({ length: 20 }, (_, i) => `Skill${i}`);
  const doc = applyRules({
    name: "Ada",
    contact: { city: "", email: "", phone: "", link: "" },
    summary: null,
    skills,
    experience: [{
      ...bank.roles[0],
      bullets: Array.from({ length: 8 }, (_, i) => `Shipped module ${i} in Python.`)
    }],
    education: [],
    projects: []
  }, { jobText: "", factBank: createFactBank({ ...bank, skills }) });
  assert.equal(doc.skills.length, 15);
  assert.ok(doc.experience[0].bullets.length <= 5);
  assert.ok(doc.experience[0].bullets.every((line) => line.split(/\s+/).length <= 25));
});
