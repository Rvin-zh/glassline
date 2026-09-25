const { claimSupported } = require("./fact-bank");
const { applyRules } = require("./rules");
const { keywordReport } = require("./keywords");

async function tailor(document, jobText, factBank, model) {
  const ruled = applyRules(document, { jobText, factBank });
  if (String(jobText || "").trim().length < 40) {
    return { document: ruled, report: { covered: [], missing: [], refused: [] } };
  }
  const drafted = await model({
    prompt: [
      "Rewrite bullets for this job using only the fact bank.",
      "Return one bullet per line.",
      jobText,
      JSON.stringify(factBank)
    ].join("\n"),
    factBank
  });
  const lines = String(drafted || "").split("\n").map((line) => line.trim()).filter(Boolean);
  const accepted = [];
  for (const line of lines) {
    if (claimSupported(factBank, line)) {
      accepted.push(line);
      continue;
    }
    const retry = await model({
      prompt: `Rewrite this bullet using only facts already listed. Drop unknown tools and employers.\n${line}\n${JSON.stringify(factBank)}`,
      factBank
    });
    const second = String(retry || "").split("\n")[0].trim();
    if (second && claimSupported(factBank, second)) accepted.push(second);
  }
  const next = {
    ...ruled,
    experience: ruled.experience.map((role, index) => (
      index === 0 && accepted.length ? { ...role, bullets: accepted } : role
    ))
  };
  const checked = applyRules(next, { jobText, factBank });
  return { document: checked, report: keywordReport(checked, jobText, factBank) };
}

module.exports = { tailor };
