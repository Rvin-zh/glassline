const test = require("node:test");
const assert = require("node:assert/strict");
const { exportResume } = require("../src/export-resume");

const good = {
  name: "Ada Lovelace",
  contact: { city: "London", email: "ada@example.com", phone: "", link: "" },
  summary: null,
  skills: ["Python"],
  experience: [{
    employer: "Analytical Engines",
    title: "Engineer",
    start: "2018-01",
    end: "2024-01",
    current: false,
    bullets: ["Built a notes compiler in Python."]
  }],
  education: [{ institution: "Cambridge", credential: "BA", year: "2016" }],
  projects: []
};

test("writes nothing when the ATS check fails", async () => {
  let writes = 0;
  const result = await exportResume({
    ...good,
    experience: [],
    education: [],
    skills: []
  }, {
    outDir: "/tmp/cv-studio-out",
    writeFile: async () => { writes += 1; },
    renderPdf: async () => ({ text: "", pageCount: 1 })
  });
  assert.equal(result.ok, false);
  assert.equal(writes, 0);
});

test("writes pdf and text for a one-page resume and omits the summary", async () => {
  const files = {};
  const result = await exportResume(good, {
    outDir: "/tmp/cv-studio-out",
    writeFile: async (filePath, data) => { files[filePath] = data; },
    renderPdf: async (text) => ({ text, pageCount: 1 })
  });
  assert.equal(result.ok, true);
  assert.equal(String(files["/tmp/cv-studio-out/resume.txt"]).includes("Summary"), false);
  assert.match(String(files["/tmp/cv-studio-out/resume.txt"]), /Skills/);
  assert.match(String(files["/tmp/cv-studio-out/resume.txt"]), /Experience/);
  assert.match(String(files["/tmp/cv-studio-out/resume.txt"]), /Education/);
});
