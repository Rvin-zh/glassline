const { atsCheck } = require("./ats-check");
const { renderText } = require("./render-text");

async function exportResume(document, { outDir, writeFile, renderPdf }) {
  const text = renderText(document);
  const rendered = await renderPdf(text);
  const check = atsCheck(document, {
    text: rendered.text,
    pageCount: rendered.pageCount,
    layout: { columns: 1, hasPhoto: false, hasTable: false, hasIcon: false, hasTextBox: false }
  });
  if (!check.ok) return { ok: false, failures: check.failures };
  const textPath = `${outDir}/resume.txt`;
  const pdfPath = `${outDir}/resume.pdf`;
  await writeFile(textPath, text);
  await writeFile(pdfPath, rendered.bytes || Buffer.from(text));
  return { ok: true, pdfPath, textPath };
}

module.exports = { exportResume };
