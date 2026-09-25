const { keywordReport } = require("./keywords");
const { renderText } = require("./render-text");

function headingsSeen(text) {
  const found = [];
  for (const heading of ["Summary", "Skills", "Experience", "Education", "Projects"]) {
    if (new RegExp(`^${heading}$`, "im").test(text)) found.push(heading);
  }
  return found;
}

function simulateAts(document, description, factBank, options = {}) {
  const parsed = renderText(document);
  const report = keywordReport(document, description, factBank);
  const supported = report.covered.length + report.missing.length;
  const keywordScore = supported === 0 ? 0 : Math.round((100 * report.covered.length) / supported);
  const formatFailures = options.failures || [];
  const score = Math.max(0, keywordScore - formatFailures.length * 15);
  return {
    kind: options.kind === "program" ? "program" : "job",
    score,
    covered: report.covered,
    missing: report.missing,
    refused: report.refused,
    formatFailures,
    parser: {
      text: parsed,
      headings: headingsSeen(parsed)
    }
  };
}

function improveForJob(document, description, factBank) {
  const before = simulateAts(document, description, factBank);
  const skills = [...(document.skills || [])];
  for (const term of before.missing) {
    if (skills.length >= 15) break;
    if (skills.some((skill) => skill.toLowerCase() === term.toLowerCase())) continue;
    skills.push(term);
  }
  const improved = { ...document, skills };
  return {
    document: improved,
    before,
    after: simulateAts(improved, description, factBank)
  };
}

module.exports = { simulateAts, improveForJob };
