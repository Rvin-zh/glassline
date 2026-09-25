const test = require("node:test");
const assert = require("node:assert/strict");
const { importResume } = require("../src/import-resume");

test("reads a labeled paste into a fact bank", async () => {
  const result = await importResume({
    kind: "paste",
    text: [
      "Name: Ada Lovelace",
      "Email: ada@example.com",
      "City: London",
      "Skills: Python, SQL",
      "Experience: Analytical Engines | Engineer | 2018-01 | 2024-01",
      "Bullet: Built a notes compiler in Python.",
      "Education: Cambridge | BA | 2016"
    ].join("\n")
  });
  assert.equal(result.ok, true);
  assert.equal(result.bank.roles[0].employer, "Analytical Engines");
  assert.deepEqual(result.bank.skills, ["Python", "SQL"]);
});

test("asks for a paste when the PDF parser returns empty text", async () => {
  const result = await importResume({
    kind: "pdf",
    bytes: Buffer.from("%PDF"),
    parsePdf: async () => ({ text: "   " })
  });
  assert.equal(result.ok, false);
  assert.equal(result.error, "unreadable");
  assert.equal(result.message, "Paste the resume text.");
});
