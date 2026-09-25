const test = require("node:test");
const assert = require("node:assert/strict");
const { atsCheck } = require("../src/ats-check");

const good = {
  name: "Ada",
  contact: { city: "London", email: "ada@example.com", phone: "", link: "" },
  summary: null,
  skills: ["Python"],
  experience: [{ employer: "Analytical Engines", title: "Engineer", start: "2018-01", end: "2024-01", current: false, bullets: ["Built a compiler."] }],
  education: [{ institution: "Cambridge", credential: "BA", year: "2016" }],
  projects: []
};

test("rejects a photo and a second column", () => {
  const photo = atsCheck(good, {
    text: "Skills\nExperience\nEducation",
    pageCount: 1,
    layout: { columns: 1, hasPhoto: true, hasTable: false, hasIcon: false, hasTextBox: false }
  });
  assert.equal(photo.ok, false);
  assert.ok(photo.failures.includes("photo"));
  const columns = atsCheck(good, {
    text: "Skills\nExperience\nEducation",
    pageCount: 1,
    layout: { columns: 2, hasPhoto: false, hasTable: false, hasIcon: false, hasTextBox: false }
  });
  assert.ok(columns.failures.includes("columns"));
});

test("rejects three pages and accepts one page of selectable text", () => {
  const long = atsCheck(good, {
    text: "Skills\nExperience\nEducation",
    pageCount: 3,
    layout: { columns: 1, hasPhoto: false, hasTable: false, hasIcon: false, hasTextBox: false }
  });
  assert.ok(long.failures.includes("pages"));
  const ok = atsCheck(good, {
    text: "Skills\nPython\nExperience\nBuilt a compiler.\nEducation\nCambridge",
    pageCount: 1,
    layout: { columns: 1, hasPhoto: false, hasTable: false, hasIcon: false, hasTextBox: false }
  });
  assert.equal(ok.ok, true);
});
