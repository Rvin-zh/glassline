const test = require("node:test");
const assert = require("node:assert/strict");
const { createFactBank, claimSupported, yearsSpan } = require("../src/fact-bank");

const bank = createFactBank({
  sourceText: "Analytical Engines",
  skills: ["Python"],
  roles: [{
    employer: "Analytical Engines",
    title: "Engineer",
    start: "2018-01",
    end: "2024-01",
    current: false,
    bullets: ["Built a notes compiler used by 3 teams."],
    tools: ["Python"],
    metrics: ["3"]
  }],
  education: [],
  projects: []
});

test("accepts a sentence grounded in the bank", () => {
  assert.equal(
    claimSupported(bank, "Built a notes compiler at Analytical Engines with Python for 3 teams."),
    true
  );
});

test("rejects Kubernetes and a fake employer", () => {
  assert.equal(claimSupported(bank, "Introduced Kubernetes at Initech."), false);
});

test("computes year span from dates and returns null when a date is missing", () => {
  assert.equal(yearsSpan(bank), 6);
  const undated = createFactBank({
    ...bank,
    roles: [{ ...bank.roles[0], start: "", end: "" }]
  });
  assert.equal(yearsSpan(undated), null);
});
