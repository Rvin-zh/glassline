const { yearsSpan } = require("./fact-bank");

const LINES_PER_PAGE = 45;
const BANNED_LABELS = [
  "results-driven", "passionate", "dynamic", "team player", "synergy",
  "go-getter", "detail-oriented", "thought leader", "rockstar",
  "leveraged", "spearheaded", "utilized"
];

function stripBanned(text) {
  let next = String(text || "");
  for (const label of BANNED_LABELS) {
    const pattern = new RegExp(label.replace("-", "\\-"), "ig");
    next = next.replace(pattern, "");
  }
  return next.replace(/\s{2,}/g, " ").replace(/\s+([,.])/g, "$1").trim();
}

function cleanBullet(text, current) {
  let line = stripBanned(text)
    .replace(/^i\s+/i, "")
    .replace(/responsible for\s+/ig, "");
  const words = line.split(/\s+/).filter(Boolean).slice(0, 25);
  line = words.join(" ");
  if (!line) return "";
  if (current) return line.replace(/^built\b/i, "Build");
  return line.replace(/^build\b/i, "Built");
}

function sharesJobTerm(role, jobLower) {
  const blob = [role.employer, role.title, ...(role.bullets || [])].join(" ").toLowerCase();
  const tokens = blob.match(/[a-z0-9][a-z0-9+.#-]{3,}/g) || [];
  return tokens.some((token) => jobLower.includes(token));
}

function lineCount(experience) {
  return 10 + experience.reduce((sum, role) => sum + 1 + (role.bullets || []).length, 0);
}

function buildSummary(factBank, job) {
  if (job.trim().length < 40) return null;
  const jobLower = job.toLowerCase();
  const proofs = [];
  for (const role of factBank.roles || []) {
    for (const bullet of role.bullets || []) {
      const cleaned = cleanBullet(bullet, role.current);
      if (!cleaned) continue;
      const tokens = cleaned.toLowerCase().match(/[a-z0-9][a-z0-9+.#-]{3,}/g) || [];
      if (tokens.some((token) => jobLower.includes(token))) proofs.push(cleaned);
    }
  }
  if (!proofs.length) return null;
  const title = (factBank.roles || [])
    .map((role) => role.title)
    .find((item) => item && jobLower.includes(item.toLowerCase())) || "";
  const span = yearsSpan(factBank);
  const line1 = [title, span ? `${span} years` : ""].filter(Boolean).join(", ");
  const lines = [line1, ...proofs.slice(0, 2)].filter(Boolean).slice(0, 3);
  if (lines.length < 2) return null;
  return lines.join("\n");
}

function applyRules(document, { jobText, factBank }) {
  const job = String(jobText || "");
  const hasJob = job.trim().length >= 40;
  const skills = [];
  const sourceSkills = factBank.skills || document.skills || [];
  const ordered = hasJob
    ? [
        ...sourceSkills.filter((skill) => job.toLowerCase().includes(skill.toLowerCase())),
        ...sourceSkills.filter((skill) => !job.toLowerCase().includes(skill.toLowerCase()))
      ]
    : sourceSkills;
  for (const skill of ordered) {
    if (skills.length === 15) break;
    if (!skills.some((item) => item.toLowerCase() === skill.toLowerCase())) skills.push(skill);
  }
  const roles = document.experience || [];
  const experience = roles.map((role) => ({
    ...role,
    bullets: (role.bullets || [])
      .map((bullet) => cleanBullet(bullet, role.current))
      .filter(Boolean)
      .slice(0, 5)
  })).filter((role) => role.bullets.length >= 1);
  const oldest = [...experience].sort((a, b) => String(a.start).localeCompare(String(b.start)))[0];
  const span = yearsSpan(factBank);
  const allowSecond = Boolean(
    span !== null && span > 10 && hasJob && oldest && sharesJobTerm(oldest, job.toLowerCase())
  );
  const newestFirst = [...experience].sort((a, b) => String(b.start).localeCompare(String(a.start)));
  const maxLines = (allowSecond ? 2 : 1) * LINES_PER_PAGE;
  while (newestFirst.length > 1 && lineCount(newestFirst) > maxLines) newestFirst.pop();
  const projects = hasJob
    ? (factBank.projects || []).filter((item) =>
        job.toLowerCase().includes(String(item.name || "").toLowerCase())
      )
    : [];
  return {
    name: document.name,
    contact: {
      city: document.contact?.city || "",
      email: document.contact?.email || "",
      phone: document.contact?.phone || "",
      link: document.contact?.link || ""
    },
    summary: buildSummary(factBank, job),
    skills,
    experience: newestFirst,
    education: document.education || [],
    projects
  };
}

module.exports = { BANNED_LABELS, applyRules };
