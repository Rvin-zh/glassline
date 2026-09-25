#!/usr/bin/env node
const fs = require("node:fs/promises");
const { runStudio } = require("../src/pipeline");
const { createModel } = require("../src/model");

async function main() {
  const resumePath = process.argv[2];
  const jobPath = process.argv[3];
  const outDir = process.argv[4] || "out";
  if (!resumePath) {
    console.error("Usage: node bin/cv-studio.js resume.txt [job.txt] [outDir]");
    process.exit(1);
  }
  const text = await fs.readFile(resumePath, "utf8");
  const jobText = jobPath ? await fs.readFile(jobPath, "utf8") : "";
  const hasJob = jobText.trim().length >= 40;
  const model = hasJob ? await createModel() : async () => "";
  await fs.mkdir(outDir, { recursive: true });
  const PDFDocument = require("pdfkit");
  const result = await runStudio({
    text,
    jobText,
    model,
    outDir,
    writeFile: (filePath, data) => fs.writeFile(filePath, data),
    renderPdf: async (body) => {
      const bytes = await new Promise((resolve) => {
        const doc = new PDFDocument({ margin: 54 });
        const chunks = [];
        doc.on("data", (chunk) => chunks.push(chunk));
        doc.on("end", () => resolve(Buffer.concat(chunks)));
        for (const line of body.split("\n")) doc.font("Times-Roman").fontSize(11).text(line);
        doc.end();
      });
      return { text: body, pageCount: 1, bytes };
    }
  });
  if (!result.ok) {
    console.error(result.message || result.failures.join(", "));
    process.exit(1);
  }
  console.log(result.textPath);
}

main().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
