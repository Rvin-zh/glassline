const { importResume } = require("./import-resume");
const { applyRules } = require("./rules");
const { tailor } = require("./tailor");
const { humanize } = require("./humanize");
const { exportResume } = require("./export-resume");
const { simulateAts, improveForJob } = require("./ats-simulate");

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
  let document = documentFromBank(bank);
  const hasJob = String(jobText || "").trim().length >= 40;
  const before = hasJob ? simulateAts(document, jobText, bank) : null;
  if (hasJob) {
    document = improveForJob(document, jobText, bank).document;
  }
  document = applyRules(document, { jobText, factBank: bank });
  if (hasJob) {
    try {
      const tailored = await tailor(document, jobText, bank, model);
      document = tailored.document;
    } catch (error) {
      const exported = await exportResume(document, { outDir, writeFile, renderPdf });
      return { ...exported, ats: { before, after: before } };
    }
  }
  if (hasJob) {
    try {
      document = await humanize(document, bank, model, jobText);
    } catch (error) {
      const exported = await exportResume(document, { outDir, writeFile, renderPdf });
      return { ...exported, ats: { before, after: simulateAts(document, jobText, bank) } };
    }
  }
  const exported = await exportResume(document, { outDir, writeFile, renderPdf });
  if (!hasJob) return exported;
  const after = simulateAts(document, jobText, bank, { failures: exported.failures || [] });
  if (exported.ok) {
    await writeFile(
      `${outDir}/ats-report.json`,
      JSON.stringify({ before, after }, null, 2)
    );
  }
  return { ...exported, ats: { before, after } };
}

module.exports = { runStudio, documentFromBank };
