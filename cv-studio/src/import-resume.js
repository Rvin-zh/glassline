const { createFactBank } = require("./fact-bank");

function field(text, label) {
  const match = text.match(new RegExp("^" + label + ":\\s*(.+)$", "im"));
  return match ? match[1].trim() : "";
}

function parseLabeled(text) {
  const skills = field(text, "Skills").split(",").map((item) => item.trim()).filter(Boolean);
  const experience = field(text, "Experience").split("|").map((item) => item.trim());
  const education = field(text, "Education").split("|").map((item) => item.trim());
  const bullet = field(text, "Bullet");
  return createFactBank({
    sourceText: text,
    skills,
    roles: experience[0] ? [{
      employer: experience[0] || "",
      title: experience[1] || "",
      start: experience[2] || "",
      end: experience[3] || "",
      current: false,
      bullets: bullet ? [bullet] : [],
      tools: skills,
      metrics: (bullet.match(/\d+/g) || [])
    }] : [],
    education: education[0] ? [{
      institution: education[0],
      credential: education[1] || "",
      year: education[2] || ""
    }] : [],
    projects: []
  });
}

async function importResume({ kind, text, bytes, parsePdf, parseDocx }) {
  let source = text || "";
  if (kind === "pdf") {
    const parsed = await parsePdf(bytes);
    source = parsed.text || "";
  } else if (kind === "docx") {
    const parsed = await parseDocx(bytes);
    source = parsed.value || "";
  }
  if (!String(source).trim()) {
    return { ok: false, error: "unreadable", message: "Paste the resume text." };
  }
  const bank = parseLabeled(source);
  if (!bank.roles.length && !bank.skills.length) {
    return { ok: false, error: "unreadable", message: "Paste the resume text." };
  }
  return { ok: true, bank };
}

module.exports = { importResume, parseLabeled };
