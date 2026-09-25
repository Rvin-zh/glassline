async function createModel(env = process.env) {
  const apiKey = env.CV_STUDIO_API_KEY;
  if (!apiKey) throw new Error("Missing CV_STUDIO_API_KEY");
  return async function model({ prompt }) {
    const response = await fetch("https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=" + apiKey, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }] })
    });
    if (!response.ok) throw new Error("Model request failed");
    const body = await response.json();
    return body.candidates?.[0]?.content?.parts?.map((part) => part.text).join("\n") || "";
  };
}

module.exports = { createModel };
