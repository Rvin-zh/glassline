function createFactBank(input) {
  return {
    sourceText: String(input.sourceText || ""),
    skills: input.skills || [],
    roles: input.roles || [],
    education: input.education || [],
    projects: input.projects || []
  };
}

function emptyFactBank() {
  return createFactBank({});
}

function tokensOf(bank) {
  const chunks = [
    bank.sourceText,
    ...bank.skills,
    ...bank.roles.flatMap((role) => [
      role.employer, role.title, role.start, role.end,
      ...(role.bullets || []), ...(role.tools || []), ...(role.metrics || [])
    ]),
    ...bank.education.flatMap((item) => [item.institution, item.credential, item.year]),
    ...bank.projects.flatMap((item) => [item.name, item.detail])
  ];
  return new Set(
    chunks.join(" ").toLowerCase().match(/[a-z0-9][a-z0-9+.#-]{1,}/g) || []
  );
}

function claimSupported(bank, sentence) {
  const known = tokensOf(bank);
  const words = String(sentence).toLowerCase().match(/[a-z0-9][a-z0-9+.#-]{2,}/g) || [];
  const content = words.filter((word) => ![
    "built", "with", "for", "and", "the", "used", "teams", "team"
  ].includes(word));
  return content.every((word) => known.has(word));
}

function yearsSpan(bank) {
  const starts = bank.roles.map((role) => role.start).filter(Boolean).sort();
  const ends = bank.roles.map((role) => role.end).filter(Boolean).sort();
  if (!starts.length || !ends.length) return null;
  const startYear = Number(starts[0].slice(0, 4));
  const endYear = Number(ends[ends.length - 1].slice(0, 4));
  if (!Number.isFinite(startYear) || !Number.isFinite(endYear)) return null;
  return endYear - startYear;
}

module.exports = { createFactBank, emptyFactBank, claimSupported, yearsSpan };
