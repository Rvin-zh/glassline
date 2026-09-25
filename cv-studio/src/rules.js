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
  const keptRoles = roles;
  const experience = keptRoles.map((role) => ({
    ...role,
    bullets: (role.bullets || [])
      .map((bullet) => cleanBullet(bullet, role.current))
      .filter(Boolean)
      .slice(0, 5)
  })).filter((role) => role.bullets.length >= 1);
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
    summary: null,
    skills,
    experience,
    education: document.education || [],
    projects
  };
}

module.exports = { BANNED_LABELS, applyRules };
