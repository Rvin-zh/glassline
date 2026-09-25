const test = require("node:test");
const assert = require("node:assert/strict");
const { runStudio } = require("../src/pipeline");

test("baseline export has no summary when the job text is short", async () => {
  const files = {};
  const result = await runStudio({
    text: [
      "Name: Ada Lovelace",
      "Email: ada@example.com",
      "City: London",
      "Skills: Python",
      "Experience: Analytical Engines | Engineer | 2018-01 | 2024-01",
      "Bullet: Built a notes compiler in Python.",
      "Education: Cambridge | BA | 2016"
    ].join("\n"),
    jobText: "too short",
    model: async () => {
      throw new Error("model must not run without a real job description");
    },
    outDir: "/tmp/cv-out",
    writeFile: async (filePath, data) => { files[filePath] = String(data); },
    renderPdf: async (text) => ({ text, pageCount: 1, bytes: Buffer.from(text) })
  });
  assert.equal(result.ok, true);
  assert.equal(files["/tmp/cv-out/resume.txt"].includes("Summary"), false);
  assert.match(files["/tmp/cv-out/resume.txt"], /Experience/);
});

test("refuses an empty fact bank", async () => {
  const result = await runStudio({
    text: "hello",
    jobText: "",
    model: async () => "",
    outDir: "/tmp/cv-out",
    writeFile: async () => {},
    renderPdf: async (text) => ({ text, pageCount: 1 })
  });
  assert.equal(result.ok, false);
  assert.equal(result.error, "unreadable");
});
