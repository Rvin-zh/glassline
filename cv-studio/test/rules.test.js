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

test("writes a short summary when the job matches facts", () => {
  const job = "We need a Python engineer who writes SQL services for production systems every single day.";
  const doc = applyRules({
    name: "Ada Lovelace",
    contact: { city: "London", email: "ada@example.com", phone: "", link: "" },
    summary: "Results-driven engineer.",
    skills: bank.skills,
    experience: bank.roles.map((role) => ({ ...role })),
    education: bank.education,
    projects: bank.projects
  }, { jobText: job, factBank: bank });
  const lines = doc.summary.split("\n");
  assert.ok(lines.length >= 2 && lines.length <= 3);
  assert.match(doc.summary, /Engineer/);
  assert.equal(doc.summary.toLowerCase().includes("results-driven"), false);
});

test("keeps a long career inside one page unless a second page is allowed", () => {
  const roles = Array.from({ length: 12 }, (_, index) => ({
    employer: `Co${index}`,
    title: "Engineer",
    start: `${2000 + index}-01`,
    end: `${2001 + index}-01`,
    current: false,
    bullets: Array.from({ length: 5 }, (__, bullet) => `Shipped Python module ${index}-${bullet} for clients.`)
  }));
  const wide = createFactBank({ skills: ["Python"], roles, education: [], projects: [] });
  const doc = applyRules({
    name: "Ada",
    contact: { city: "", email: "", phone: "", link: "" },
    summary: null,
    skills: ["Python"],
    experience: roles,
    education: [],
    projects: []
  }, { jobText: "", factBank: wide });
  const lines = 10 + doc.experience.reduce((sum, role) => sum + 1 + role.bullets.length, 0);
  assert.ok(lines <= 45);
  assert.equal(doc.experience[0].start, "2011-01");
});
