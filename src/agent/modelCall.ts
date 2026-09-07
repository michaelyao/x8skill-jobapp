import fs from "node:fs";

/**
 * One model call, airouter first and gemini as the fallback - the same ladder the answering path
 * uses, extracted so a diagnostic can make a call without importing the whole agent.
 *
 * IT CAN SEE, NOW. The candidate asked for the study to "invoke LLM and Vision to study the page",
 * and this client was text-only: `content: user` as a bare string for the Anthropic shape and
 * `parts: [{ text }]` for Gemini. Both APIs take images in exactly those places, so a picture costs
 * one content block rather than a new service.
 *
 * That matters for the problem it is aimed at. Whether a row in a dropdown OPENS or ANSWERS is a
 * visual fact — a chevron on the right-hand edge — and the DOM says it in a hundred tenant-specific
 * ways or not at all. Mastercard's three rows were described to a text model as three plain strings,
 * and it answered with the one that was really a folder.
 */

/** An image to reason about, read from a file the run has just captured. */
export interface ModelImage {
  /** Path to a PNG on disk — a control screenshot, an opened menu, a page slice. */
  path: string;
  /** What it shows, so the model knows what it is looking at. */
  caption?: string;
}

/**
 * A PICTURE WE COULD NOT READ IS SAID OUT LOUD, NOT SILENTLY DROPPED.
 *
 * The first version returned null on any failure, so a missing file downgraded a vision call to a
 * blind text call and the model answered "I don't see any image" — which I then spent a round
 * reading as "airouter strips images". The file was simply not where I said it was: a macOS
 * screenshot is named with U+202F, a narrow no-break space, before "PM", and the ordinary space I
 * typed did not match it.
 *
 * That is PROPOSAL.md weakness 3 reproduced inside the fix for weakness 1, within the hour. An
 * action that fails has to report; only a speculative probe may shrug.
 */
function readPng(image: ModelImage): { base64: string; caption: string } | null {
  let bytes: Buffer;
  try {
    bytes = fs.readFileSync(image.path);
  } catch (error) {
    console.log(
      `    [model] cannot see ${image.path}: ${(error as Error).message.split("\n")[0].slice(0, 90)}`,
    );
    return null;
  }
  // A capture of a 0x0 control is a few bytes of PNG header and nothing to look at; sending it
  // spends a vision call to be told the picture is blank.
  if (bytes.length < 256) {
    console.log(`    [model] ${image.path} is ${bytes.length} bytes — too small to be a picture of anything`);
    return null;
  }
  return { base64: bytes.toString("base64"), caption: image.caption ?? "the control in question" };
}

/**
 * Ask the model. `images` are optional; when none survive reading, the call is exactly the text
 * call it was before, so every existing caller is unaffected.
 */
export async function callModel(
  system: string,
  user: string,
  images: readonly ModelImage[] = [],
): Promise<string> {
  const pictures = images.map(readPng).filter((p): p is { base64: string; caption: string } => p !== null);

  const endpoint = process.env.AIROUTER_API_ENDPOINT;
  const key = process.env.AIROUTER_API_KEY;
  const model = process.env.AIROUTER_MODEL_NAME || "sonnet";
  if (endpoint && key) {
    try {
      /**
       * A string content is still sent when there is no image — the same request as before, byte
       * for byte. Only a call that actually carries a picture takes the block form, so a vision
       * model is never required for the text-only diagnostics that already work.
       */
      const content = pictures.length
        ? [
            ...pictures.flatMap((p) => [
              { type: "text", text: p.caption },
              { type: "image", source: { type: "base64", media_type: "image/png", data: p.base64 } },
            ]),
            { type: "text", text: user },
          ]
        : user;
      const res = await fetch(`${endpoint.replace(/\/$/, "")}/v1/messages`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-api-key": key, "anthropic-version": "2023-06-01" },
        body: JSON.stringify({ model, max_tokens: 300, system, messages: [{ role: "user", content }] }),
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
    const parts = [
      ...pictures.flatMap((p) => [
        { text: p.caption },
        { inline_data: { mime_type: "image/png", data: p.base64 } },
      ]),
      { text: user },
    ];
    const res = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${gkey}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          systemInstruction: { parts: [{ text: system }] },
          contents: [{ parts }],
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
