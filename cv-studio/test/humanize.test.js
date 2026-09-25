const test = require("node:test");
const assert = require("node:assert/strict");
const { createFactBank } = require("../src/fact-bank");
const { BANNED_LABELS } = require("../src/rules");
const { humanize } = require("../src/humanize");

test("drops a humanize reply that adds a tool", async () => {
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
  const doc = {
    name: "Ada",
    contact: { city: "", email: "", phone: "", link: "" },
    summary: null,
    skills: ["Python"],
    experience: [{ ...bank.roles[0] }],
    education: [],
    projects: []
  };
  const next = await humanize(doc, bank, async () => "Passionate engineer who leveraged Kubernetes.");
  const blob = JSON.stringify(next).toLowerCase();
  assert.equal(blob.includes("kubernetes"), false);
  for (const label of BANNED_LABELS) assert.equal(blob.includes(label), false);
});
