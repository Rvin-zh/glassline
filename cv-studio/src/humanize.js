const { claimSupported } = require("./fact-bank");
const { applyRules } = require("./rules");

async function humanize(document, factBank, model) {
  const drafted = await model({
    prompt: [
      "Rephrase these bullets. Do not add employers, tools, dates, or numbers.",
      "Keep lengths uneven. Return one bullet per line.",
      JSON.stringify(document.experience)
    ].join("\n"),
    factBank
  });
  const lines = String(drafted || "").split("\n").map((line) => line.trim()).filter(Boolean);
  const safe = lines.filter((line) => claimSupported(factBank, line));
  const experience = document.experience.map((role, index) => {
    if (index !== 0 || safe.length === 0) return role;
    return { ...role, bullets: safe };
  });
  return applyRules({ ...document, summary: null, experience }, { jobText: "", factBank });
}

module.exports = { humanize };
