/**
 * One model call, airouter first and gemini as the fallback - the same ladder the answering path
 * uses, extracted so a diagnostic can make a call without importing the whole agent.
 */
export async function callModel(system: string, user: string): Promise<string> {
  const endpoint = process.env.AIROUTER_API_ENDPOINT;
  const key = process.env.AIROUTER_API_KEY;
  const model = process.env.AIROUTER_MODEL_NAME || "sonnet";
  if (endpoint && key) {
    try {
      const res = await fetch(`${endpoint.replace(/\/$/, "")}/v1/messages`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-api-key": key, "anthropic-version": "2023-06-01" },
        body: JSON.stringify({ model, max_tokens: 300, system, messages: [{ role: "user", content: user }] }),
      });
      if (res.ok) {
        const json = (await res.json()) as { content?: Array<{ text?: string }> };
        const text = (json.content || []).map((c) => c.text || "").join("");
        if (text) return text;
      }
    } catch {
      /* fall through to gemini */
    }
  }
  const gkey = process.env.GEMINI_API_KEY;
  if (!gkey) return "";
  try {
    const res = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${gkey}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          systemInstruction: { parts: [{ text: system }] },
          contents: [{ parts: [{ text: user }] }],
        }),
      },
    );
    if (!res.ok) return "";
    const json = (await res.json()) as { candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }> };
    return (json.candidates?.[0]?.content?.parts ?? []).map((p) => p.text || "").join("");
  } catch {
    return "";
  }
}
