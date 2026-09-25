const test = require("node:test");
const assert = require("node:assert/strict");
const { createFactBank } = require("../src/fact-bank");
const { tailor } = require("../src/tailor");

const bank = createFactBank({
  skills: ["Python"],
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
  education: [],
  projects: []
});

const base = {
  name: "Ada",
  contact: { city: "", email: "", phone: "", link: "" },
  summary: null,
  skills: ["Python"],
  experience: bank.roles.map((role) => ({ ...role })),
  education: [],
  projects: []
};

test("covers a supported placed term, misses an unplaced supported term, and refuses an unsupported term", async () => {
  const job = "We need a Python engineer who also knows SQL and Kubernetes in production systems.";
  const result = await tailor(base, job, bank, async () => "Introduced Kubernetes at Initech.");
  assert.ok(result.report.covered.includes("Python"));
  assert.ok(result.report.refused.includes("Kubernetes"));
  assert.equal(JSON.stringify(result.document).includes("Kubernetes"), false);
  assert.equal(JSON.stringify(result.document).includes("Initech"), false);
});
