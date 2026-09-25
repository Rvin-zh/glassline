function atsCheck(document, { text, pageCount, layout }) {
  const failures = [];
  if (layout.hasPhoto) failures.push("photo");
  if (layout.hasTable) failures.push("table");
  if (layout.hasIcon) failures.push("icon");
  if (layout.hasTextBox) failures.push("text-box");
  if (layout.columns !== 1) failures.push("columns");
  if (pageCount > 2) failures.push("pages");
  const body = String(text || "");
  if (!body.trim()) failures.push("selectable-text");
  if ((document.skills || []).length && !/skills/i.test(body)) failures.push("heading-skills");
  if ((document.experience || []).length && !/experience/i.test(body)) failures.push("heading-experience");
  if ((document.education || []).length && !/education/i.test(body)) failures.push("heading-education");
  return { ok: failures.length === 0, failures };
}

module.exports = { atsCheck };
