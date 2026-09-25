const { claimSupported } = require("./fact-bank");

function requirementTerms(jobText) {
  const words = String(jobText).match(/[A-Za-z][A-Za-z0-9+.#-]{2,}/g) || [];
  const skip = new Set("the and for with who also need job role this that from your our".split(" "));
  const unique = [];
  for (const word of words) {
    const key = word.toLowerCase();
    if (skip.has(key) || unique.some((item) => item.toLowerCase() === key)) continue;
    unique.push(word);
  }
  return unique;
}

function keywordReport(document, jobText, factBank) {
  const blob = [
    ...(document.skills || []),
    ...(document.experience || []).flatMap((role) => role.bullets || [])
  ].join(" ").toLowerCase();
  const covered = [];
  const missing = [];
  const refused = [];
  for (const term of requirementTerms(jobText)) {
    if (!claimSupported(factBank, term)) {
      refused.push(term);
      continue;
    }
    if (blob.includes(term.toLowerCase())) covered.push(term);
    else missing.push(term);
  }
  return { covered, missing, refused };
}

module.exports = { keywordReport, requirementTerms };
