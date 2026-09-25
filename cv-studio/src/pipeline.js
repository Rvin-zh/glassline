const { importResume } = require("./import-resume");
const { applyRules } = require("./rules");
const { tailor } = require("./tailor");
const { humanize } = require("./humanize");
const { exportResume } = require("./export-resume");

function documentFromBank(bank) {
  return {
    name: (bank.sourceText.match(/^Name:\s*(.+)$/im) || [])[1] || "",
    contact: {
      city: (bank.sourceText.match(/^City:\s*(.+)$/im) || [])[1] || "",
      email: (bank.sourceText.match(/^Email:\s*(.+)$/im) || [])[1] || "",
      phone: "",
      link: ""
    },
    summary: null,
    skills: bank.skills,
    experience: bank.roles.map((role) => ({ ...role })),
    education: bank.education,
    projects: []
  };
}

async function runStudio({ text, jobText, model, outDir, writeFile, renderPdf }) {
  const imported = await importResume({ kind: "paste", text });
  if (!imported.ok) return imported;
  const bank = imported.bank;
  if (!bank.roles.length) {
    return { ok: false, error: "unreadable", message: "Paste the resume text." };
  }
  let document = applyRules(documentFromBank(bank), { jobText, factBank: bank });
  const hasJob = String(jobText || "").trim().length >= 40;
  if (hasJob) {
    try {
      const tailored = await tailor(document, jobText, bank, model);
      document = tailored.document;
    } catch (error) {
      return exportResume(document, { outDir, writeFile, renderPdf });
    }
  }
  if (hasJob) {
    try {
      document = await humanize(document, bank, model);
    } catch (error) {
      return exportResume(document, { outDir, writeFile, renderPdf });
    }
  }
  return exportResume(document, { outDir, writeFile, renderPdf });
}

module.exports = { runStudio, documentFromBank };
