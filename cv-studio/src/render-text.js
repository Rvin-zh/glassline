function renderText(document) {
  const lines = [document.name];
  const contact = [document.contact.city, document.contact.email, document.contact.phone, document.contact.link]
    .filter(Boolean);
  if (contact.length) lines.push(contact.join(" | "));
  if (document.summary) {
    lines.push("", "Summary", document.summary);
  }
  if (document.skills.length) {
    lines.push("", "Skills", document.skills.join(", "));
  }
  if (document.experience.length) {
    lines.push("", "Experience");
    for (const role of document.experience) {
      lines.push(`${role.title}, ${role.employer} (${role.start}–${role.end})`);
      for (const bullet of role.bullets) lines.push(`- ${bullet}`);
    }
  }
  if (document.education.length) {
    lines.push("", "Education");
    for (const item of document.education) {
      lines.push(`${item.credential}, ${item.institution}, ${item.year}`);
    }
  }
  return lines.join("\n");
}

module.exports = { renderText };
