const test = require("node:test");
const assert = require("node:assert/strict");
const { createFactBank } = require("../src/fact-bank");
const { simulateAts } = require("../src/ats-simulate");

const bank = createFactBank({
  skills: ["Python", "SQL"],
  roles: [{
    employer: "Analytical Engines",
    title: "Engineer",
    start: "2018-01",
    end: "2024-01",
    current: false,
    bullets: ["Built a notes compiler in Python."],
    tools: ["Python"],
    metrics: []
  }],
  education: [{ institution: "Cambridge", credential: "BA", year: "2016" }],
  projects: []
});

const document = {
  name: "Ada",
  contact: { city: "London", email: "ada@example.com", phone: "", link: "" },
  summary: null,
  skills: ["Python"],
  experience: bank.roles.map((role) => ({ ...role })),
  education: bank.education,
  projects: []
};

test("scores the job from skills the facts can support", () => {
  const job = "We need a Python engineer who also knows SQL and Kubernetes for production systems.";
  const report = simulateAts(document, job, bank);
  assert.equal(report.kind, "job");
  assert.ok(report.covered.includes("Python"));
  assert.ok(report.missing.includes("SQL"));
  assert.ok(report.refused.includes("Kubernetes"));
  assert.ok(report.score > 0 && report.score < 100);
  assert.ok(report.parser.headings.includes("Experience"));
  assert.equal(report.parser.text.includes("Kubernetes"), false);
});

test("lowers the score when the ATS cannot parse the file", () => {
  const clean = simulateAts(document, "We need a Python engineer who ships compilers for production systems daily.", bank);
  const broken = simulateAts(
    document,
    "We need a Python engineer who ships compilers for production systems daily.",
    bank,
    { failures: ["columns", "photo"] }
  );
  assert.ok(broken.score < clean.score);
});
