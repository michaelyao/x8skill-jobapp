import { normalizeQuestion } from "../utils/normalize.js";
import { parseResumeHistory } from "../knowledge/resumeHistory.js";
import { bandContains, degreeLevel, parseGpaBand } from "../core/factChecks.js";
import type { Agent, AgentContext, FieldAnswer, FieldSpec, PageSnapshot } from "./types.js";

// Legal / demographic / compensation fields we must never free-guess. The agent
// may answer these only from curated Q&A or profile data; otherwise it defers to
// a human (needsHuman) and the turn loop routes them to learning mode.
const SENSITIVE =
  /work autho|authoriz|sponsor|visa|citizen|\brace\b|ethnic|hispanic|latino|\bgender\b|\bsex\b|disab|veteran|felony|criminal|conviction|salary|compensation expectation|expected pay|date of birth|social security|\bssn\b/i;

export function isSensitive(label: string): boolean {
  return SENSITIVE.test(label);
}

// Self-identification / EEO / disability questions: NEVER auto-answer these —
// always leave them blank for the human to complete, even if curated data exists.
const EEO_SELF_ID =
  /disabilit|impairment|substantially limits|major life activit|\bveteran\b|protected veteran|\brace\b|ethnic|racial|gender identity|how do you identify|sexual orientation|self.?identif|transgender|pronoun/i;

export function isSelfIdentification(label: string): boolean {
  return EEO_SELF_ID.test(label);
}

/** Index just past the last top-level `{...}` that closed, ignoring braces in strings. */
function lastCompleteObjectEnd(text: string): number {
  let depth = 0;
  let inString = false;
  let escaped = false;
  let end = 0;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === "{") depth += 1;
    else if (ch === "}") {
      depth -= 1;
      if (depth === 0) end = i + 1;
    }
  }
  return end;
}

/**
 * Pull the JSON array out of a model reply, tolerating ``` fences and a reply that
 * was cut off mid-array by the token limit. `repaired` means we closed a truncated
 * array and some field answers were lost (the caller logs it — never silent).
 */
export function stripToJson(text: string): { json: string; repaired: boolean } {
  let body = text.trim();
  // Strip an opening fence even when the CLOSING fence never arrived — requiring the
  // pair left a literal "```json" in the payload and lost the whole turn to a parse error.
  const open = body.match(/^```(?:json)?[ \t]*\r?\n?/i);
  if (open) {
    body = body.slice(open[0].length);
    const close = body.lastIndexOf("```");
    if (close >= 0) body = body.slice(0, close);
  } else {
    const fenced = body.match(/```(?:json)?\s*([\s\S]*?)```/i);
    if (fenced) body = fenced[1];
  }
  const start = body.indexOf("[");
  if (start < 0) return { json: body, repaired: false };
  const end = body.lastIndexOf("]");
  if (end > start) return { json: body.slice(start, end + 1), repaired: false };
  // Array never closed (hit max_tokens mid-answer): keep the objects that arrived
  // whole and close it, so we fill what we got instead of dropping every field.
  const arr = body.slice(start);
  const cut = lastCompleteObjectEnd(arr);
  return cut > 0 ? { json: `${arr.slice(0, cut)}]`, repaired: true } : { json: arr, repaired: false };
}

/** Compact profile summary handed to the LLM as grounding. */
function profileSummary(ctx: AgentContext): string {
  const p = ctx.profile;
  const bits = [
    p.firstName && `First name: ${p.firstName}`,
    p.lastName && `Last name: ${p.lastName}`,
    p.email && `Email: ${p.email}`,
    p.phone && `Phone: ${p.phone}`,
    p.linkedin && `LinkedIn: ${p.linkedin}`,
    p.github && `GitHub: ${p.github}`,
    p.gpa && `GPA: ${p.gpa}`,
    p.school && `School: ${p.school}`,
  ].filter(Boolean);
  return bits.join("\n");
}

/** Companies the candidate has worked for, from the resume's "### Company — ..." headings. */
export function extractEmployers(resumeText: string): string[] {
  const employers: string[] = [];
  for (const m of resumeText.matchAll(/^#{2,4}\s+(.+?)\s+[—–-]\s+/gm)) {
    const name = m[1].trim();
    if (name && !/education|skills|work experience|award/i.test(name)) employers.push(name);
  }
  return [...new Set(employers)];
}

function curatedSummary(ctx: AgentContext): string {
  return ctx.answers
    .map((a) => `Q: ${a.question}\nA: ${Array.isArray(a.answer) ? a.answer.join(", ") : a.answer}`)
    .join("\n\n");
}

/**
 * Today, in the LOCAL timezone, as the form expects it. A self-identification page rejected an
 * application with "Enter today's date" because the model guessed — and after 5pm Pacific its
 * guess was the UTC date, one day ahead. Never derive this from toISOString().
 */
function localToday(): { iso: string; month: string; day: string; year: string; long: string } {
  const now = new Date();
  const month = String(now.getMonth() + 1).padStart(2, "0");
  const day = String(now.getDate()).padStart(2, "0");
  const year = String(now.getFullYear());
  return {
    iso: `${year}-${month}-${day}`,
    month,
    day,
    year,
    long: now.toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric" }),
  };
}

function buildPrompt(snapshot: PageSnapshot, ctx: AgentContext): { system: string; user: string } {
  const today = localToday();
  const system = [
    "You are filling a job application form on behalf of a candidate.",
    `TODAY IS ${today.long} (${today.iso}) — month ${today.month}, day ${today.day}, year ${today.year}.`,
    `- Any field asking for today's date, the date signed, or the date of completion takes exactly that date: ${today.month}/${today.day}/${today.year}. When it is split into Month / Day / Year sub-fields, answer each with "${today.month}", "${today.day}" and "${today.year}" respectively. Do not compute it yourself and never use a different timezone's date — the form validates it against its own clock.`,
    "For each field, produce the best answer grounded ONLY in the candidate's resume, profile, and curated Q&A provided.",
    "Rules:",
    "- Never invent facts (names, numbers, employers, dates) not supported by the provided data.",
    "- For select/radio fields, the value MUST be exactly one of the given options.",
    '- EXCEPTION — a field with "searchableTypeahead": true is a type-to-search box whose "optionsSample" is only the first few of thousands of choices (e.g. every university in the world). Answer with the candidate\'s REAL value (their actual school, city, employer) even when it does not appear in the sample, and do NOT set needsHuman merely because it is missing from the sample. The value is matched against the live filtered list when it is entered.',
    '- For a searchableTypeahead you MAY answer with two or three comma-separated alternatives, ordered most specific first: "Python, Computer Science". Each is tried against the live list and the first one the list actually offers is selected. Use this when you cannot tell how the list names things — the "optionsSample" shows its vocabulary and granularity, so if the sample reads "Accounting, Actuarial Science, Aerospace Engineering" a broader field belongs in your list as well as the specific skill. Never leave a skills or field-of-study box unanswered because you are unsure of the exact wording.',
    "- For checkboxes, value is 'Yes' or 'No'.",
    '- ANSWER LENGTH: if a question can be answered Yes or No, answer exactly "Yes" or "No" — nothing more. This holds even when the question is three lines long, even when the input is a big text box, and even when you could justify the answer. "Yes, I am fully willing and able to relocate… I have previous experience doing exactly this…" is padding: it reads as machine-written and a human reviewer has to delete it. Keep every factual answer as short as the question allows.',
    '- ROLE DESCRIPTION / responsibilities boxes inside a work-experience row take BULLETS, not a paragraph. One bullet per accomplishment, each starting "- ", newline between them, taken from the resume bullets for THAT employer and kept in the resume\'s own words. Merging them into flowing prose ("Developed X, eliminating the manual review process and saving each team member ~2 hours per week. Built Y…") is harder to read than the resume it came from and reads as machine-written. Never invent a bullet the resume does not have.',
    "- OPEN-ENDED free-text fields (e.g. 'Why do you want to work here?', 'Tell us about yourself', cover letter, 'What interests you'): DRAFT a concise, specific, first-person answer (~80-150 words) grounded in the candidate's real resume experience and the job description. Set draft=true, needsHuman=false, confidence around 0.7. Do not fabricate experience — only use what's in the resume.",
    "- SENSITIVE fields (work authorization, sponsorship, citizenship, demographics, disability, veteran, criminal history, salary, DOB, SSN): answer ONLY if the curated Q&A or profile clearly provides it; otherwise set needsHuman=true and leave value empty. Never guess these.",
    "- For factual fields (name, email, phone, school, dates): use the provided data. If it is genuinely absent, set needsHuman=true and leave value empty — do NOT guess.",
    '- If an OPTIONAL field asks for something the candidate simply does not have (a phone extension, a middle name, a second address, a portfolio they lack), the correct answer is EMPTY: set "blank": true with an empty value and needsHuman=false. Do not set needsHuman for these — nothing needs to be asked, there is genuinely nothing to enter.',
    "- WORK EXPERIENCE BLOCKS: the form usually has fewer blocks than the candidate has positions. Fill them in the order listed above — the FIRST block takes position 1 (most recent), the second block position 2, and so on. Never put an older position in the first block: a form with a single block must get the most recent role, not the oldest. Keep each block internally consistent — the title, employer, location and dates in one block must all belong to the SAME position.",
    "- For 'have you previously worked for X / are you a former employee of X / do you work for X' questions: answer Yes ONLY if X (or its parent/subsidiary) appears in the candidate's Employment history below; otherwise No. Do NOT rely on any generic curated answer for this.",
    "- Do NOT answer or reference any submit button.",
    'Respond with ONLY a JSON array: [{"key":"...","value":"...","confidence":0.0-1.0,"needsHuman":false,"draft":false,"blank":false,"reasoning":"short"}]. One object per field, using the exact keys given.',
  ].join("\n");

  const fieldsForLlm = snapshot.fields.map((f) => ({
    key: f.key,
    label: f.label,
    type: f.type,
    required: f.required,
    // A type-to-filter combobox only reveals a slice of its choices before you type
    // (Greenhouse's School field: 100 entries starting at "Aalborg University"). Passing
    // that slice as `options` made the model obey the "must be exactly one of the given
    // options" rule and defer the field as needsHuman whenever the real answer wasn't in
    // the slice — which silently blocked the whole job. Send it as a labelled sample.
    ...(f.searchable ? { searchableTypeahead: true, optionsSample: f.options?.slice(0, 10) } : { options: f.options }),
    sensitive: f.sensitive ?? isSensitive(f.label),
  }));

  const user = [
    `Company: ${ctx.company}`,
    `Role: ${ctx.title}`,
    ctx.changeInstruction
      ? `\n*** USER CORRECTION (highest priority — the user reviewed a prior draft and asked for these changes; apply them exactly, overriding any conflicting default): ***\n${ctx.changeInstruction}`
      : "",
    ctx.jobDescription ? `\nJob description (context):\n${ctx.jobDescription.slice(0, 3000)}` : "",
    `\nCandidate profile:\n${profileSummary(ctx)}`,
    `\nEmployment history, MOST RECENT FIRST (the resume's order — position 1 is the current/latest role):\n${
      extractEmployers(ctx.resumeText)
        .map((name, i) => `  ${i + 1}. ${name}`)
        .join("\n") || "  (none parsed)"
    }`,
    `\nCandidate resume:\n${ctx.resumeText.slice(0, 6000)}`,
    ctx.answers.length ? `\nCurated Q&A (authoritative, especially for sensitive fields):\n${curatedSummary(ctx)}` : "",
    `\nFields to answer (JSON):\n${JSON.stringify(fieldsForLlm, null, 2)}`,
  ]
    .filter(Boolean)
    .join("\n");

  return { system, user };
}

async function callAirouter(system: string, user: string): Promise<string> {
  const endpoint = process.env.AIROUTER_API_ENDPOINT;
  const key = process.env.AIROUTER_API_KEY;
  const model = process.env.AIROUTER_MODEL_NAME || "sonnet";
  if (!endpoint || !key) throw new Error("AIROUTER not configured");
  const res = await fetch(`${endpoint.replace(/\/+$/, "")}/v1/messages`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-api-key": key, "anthropic-version": "2023-06-01" },
    // 2048 truncated mid-array on 20+ field pages (each drafted free-text answer runs
    // ~150 words), which used to lose every answer in the turn to a parse error.
    body: JSON.stringify({ model, max_tokens: 8192, system, messages: [{ role: "user", content: user }] }),
    // 120s aborted on 64-field pages (CTC), dropping us to the weaker fallback for no
    // reason — a big field list with drafted free-text legitimately takes longer.
    signal: AbortSignal.timeout(240000),
  });
  if (!res.ok) throw new Error(`AIROUTER HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const json = (await res.json()) as { content?: Array<{ text?: string }> };
  const text = (json.content || []).map((c) => c.text || "").join("");
  if (!text) throw new Error("AIROUTER returned empty content");
  return text;
}

async function callGemini(system: string, user: string): Promise<string> {
  const key = process.env.GEMINI_API_KEY;
  if (!key) throw new Error("GEMINI_API_KEY not configured");
  const res = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${key}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: system }] },
        contents: [{ parts: [{ text: user }] }],
        // gemini-2.5-flash reasons by default and charges that against maxOutputTokens,
        // so on a 64-field page it burned the whole budget thinking and returned just
        // "```json" with no array at all. Reasoning off, and a budget big enough for a
        // long field list.
        generationConfig: { temperature: 0.2, maxOutputTokens: 16384, thinkingConfig: { thinkingBudget: 0 } },
      }),
      signal: AbortSignal.timeout(120000),
    },
  );
  if (!res.ok) throw new Error(`Gemini HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const json = (await res.json()) as { candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }> };
  const text = (json.candidates?.[0]?.content?.parts || []).map((p) => p.text || "").join("");
  if (!text) throw new Error("Gemini returned empty content");
  return text;
}

/** LLM-primary agent: AIROUTER first, Gemini as backup, with sensitive guardrails. */
export class LlmAgent implements Agent {
  async decide(snapshot: PageSnapshot, ctx: AgentContext): Promise<FieldAnswer[]> {
    if (snapshot.fields.length === 0) return [];
    const { system, user } = buildPrompt(snapshot, ctx);

    let raw: string;
    let provider: string;
    try {
      raw = await callAirouter(system, user);
      provider = "airouter";
    } catch (airouterError) {
      console.warn(`  [agent] AIROUTER failed (${(airouterError as Error).message}); falling back to Gemini.`);
      raw = await callGemini(system, user);
      provider = "gemini";
    }

    let parsed: Array<Partial<FieldAnswer>>;
    let { json, repaired } = stripToJson(raw);
    try {
      parsed = JSON.parse(json);
    } catch {
      // One bad reply must not cost the whole application. Fannie Mae PTPDDZ died exactly here:
      // the model returned an opening fence and nothing after it, so stripToJson correctly
      // produced "" and JSON.parse threw — with 17 required fields still pending and two retry
      // passes unused. The exception also unwound past the ledger write, so the job left no
      // record at all: not in the queue, not in applications.json, only a line in the log.
      //
      // So: ask once more, then degrade to "no answers this turn". The turn loop already knows
      // what to do with that — re-read, retry the stragglers, and if a required field is still
      // empty STOP and report blockedRequired. That is a diagnosable outcome with a ledger entry
      // behind it. An exception is not.
      console.warn(
        `  [agent] ${provider} reply was not JSON (${raw.trim().length} char(s): ${JSON.stringify(raw.slice(0, 120))}) — asking once more.`,
      );
      try {
        raw = provider === "airouter" ? await callAirouter(system, user) : await callGemini(system, user);
        ({ json, repaired } = stripToJson(raw));
        parsed = JSON.parse(json);
      } catch {
        console.warn(
          `  [agent] ${provider} still did not return JSON — leaving this turn's ${snapshot.fields.length} field(s) unanswered for the retry pass.`,
        );
        return [];
      }
    }
    if (repaired) {
      console.warn(
        `  [agent] ${provider} reply was cut off mid-array — recovered ${parsed.length} of ${snapshot.fields.length} field answer(s); the rest fall to the retry pass.`,
      );
    }

    const byKey = new Map(snapshot.fields.map((f) => [f.key, f]));
    const answers: FieldAnswer[] = [];
    for (const item of parsed) {
      const field = item.key != null ? byKey.get(String(item.key)) : undefined;
      if (!field) continue;
      let value = item.value == null ? "" : String(item.value);
      let needsHuman = Boolean(item.needsHuman);
      let confidence = typeof item.confidence === "number" ? item.confidence : 0;
      const draft = Boolean(item.draft);
      const blank = Boolean(item.blank);

      // Guardrail: sensitive/EEO fields (work-auth, sponsorship, gender, race,
      // veteran, disability, salary) are answered ONLY from the curated Q&A /
      // profile — never fabricated. If the model returned no grounded value,
      // defer to the human rather than guess.
      if ((field.sensitive ?? isSensitive(field.label)) && !value) {
        needsHuman = true;
        confidence = 0;
      }
      // Guardrail: a bare "Yes"/"No" in a FREE-TEXT field is almost always a yes/no
      // curated answer bleeding into a question that wants real content — e.g. the
      // curated "Do you have a preferred name? → No" landing in Lever's text field
      // "Preferred Name | What would you like us to call you?", which then submits the
      // literal word "No" as the candidate's name. Only accept it when the label
      // actually reads as a yes/no question (auxiliary-verb opener, or an "if yes/no"
      // follow-up); otherwise defer rather than write nonsense into the application.
      if ((field.type === "text" || field.type === "textarea") && /^(yes|no)\.?$/i.test(value.trim())) {
        // The auxiliary verb is not always at the front. Workday numbers its questions and
        // front-loads a condition — "5. If selected for an internship position, are you willing
        // and able to relocate…" — which an anchored test reads as free text, so a correct "Yes"
        // was thrown away and the required field blocked the whole run.
        const label = field.label.toLowerCase().replace(/^\s*(?:q\s*)?\d{1,2}\s*[.)\-:]\s*/i, "");
        // "Why do you want to work here?" contains "do you" and is emphatically not a yes/no
        // question. An opener that demands an explanation wins over any auxiliary verb later.
        const wantsProse = /^(why|how|what|which|when|where|who|describe|tell|explain|elaborate|list|share|walk)\b/.test(label);
        const yesNoQuestion =
          !wantsProse &&
          (/^(do|does|did|are|is|was|were|have|has|had|will|would|can|could|should|may|must|shall)\b/.test(label) ||
          /\b(are|is|was|were|do|does|did|have|has|had|will|would|can|could|should)\s+(you|your|there|the candidate)\b/.test(label) ||
          /\b(willing|able|authoriz|eligible|require sponsorship|consent|agree)\b/.test(label) ||
          /\(\s*yes\s*\/\s*no\s*\)/.test(label) ||
          /\bif (yes|no)\b/.test(label));
        if (!yesNoQuestion) {
          console.warn(`  [agent] ignoring bare "${value.trim()}" for free-text field "${field.label.slice(0, 60)}" — needs a real answer.`);
          needsHuman = true;
          value = "";
          confidence = 0;
        }
      }

      // Guardrail: select value must map to a real option. Accept an exact match,
      // or the answer as the option's leading token before a comma/paren/dash — so
      // curated "No" maps to "No, I don't have a disability" — without loose
      // substring matches (e.g. "No" ✗ "Now employed"). Otherwise defer.
      if (field.options && field.options.length && value) {
        const lv = value.trim().toLowerCase();
        const lead = (o: string) => o.split(/[,(:—–-]/)[0].trim().toLowerCase();
        const match =
          field.options.find((o) => o.toLowerCase() === lv) ||
          field.options.find((o) => lead(o) === lv) ||
          field.options.find((o) => lv.length >= 4 && o.toLowerCase().includes(lv));
        if (!match) {
          // A type-to-filter combobox (School / Discipline typeahead) exposed only an
          // async slice of its options, so "no match" here means "not in the sample",
          // not "not a real option". Keep the value: fillReactSelect types to filter
          // and can ONLY click an option that actually exists, so a bad value fails
          // loudly at fill time instead of being silently skipped as needsHuman.
          // "How did you hear about us?" is a closed list that every tenant words differently:
          // one offers LinkedIn, the next offers "Campus/University | Job Board/Website |
          // EMEAInternetJobSites | Social Media | Other". Answering with a channel the list does
          // not name left a required field empty. The channel matters far less than answering
          // truthfully-enough, so fall back through a preference order over the OFFERED options.
          const preference = [
            /campus|university|college|career (fair|center)|school/i,
            /company (web)?site|our website|careers page/i,
            /job board|job ?site|website|indeed|handshake|linkedin|glassdoor/i,
            /referral|employee/i,
            /social media|twitter|facebook|instagram/i,
            /other/i,
          ];
          const heardAbout = /how did you (hear|find|learn)|source|referral source/i.test(field.label);
          const fallback = heardAbout
            ? preference.map((rx) => field.options!.find((o) => rx.test(o))).find(Boolean)
            : undefined;
          if (fallback) {
            value = fallback;
          } else if (field.searchable) {
            confidence = Math.min(confidence, 0.5);
          } else {
            needsHuman = true;
            confidence = Math.min(confidence, 0.3);
          }
        } else {
          value = match;
        }
      }
      answers.push({ key: field.key, value, confidence, needsHuman, draft, blank, source: "llm", reasoning: item.reasoning });
    }
    console.log(`  [agent] ${provider} answered ${answers.length}/${snapshot.fields.length} fields.`);
    // An answer you corrected is used EXACTLY, not as a hint. The curated store is passed to
    // the model as context, and the model paraphrases: "100K annualized" came back as "100K"
    // after that exact wording had been recorded from a review. Whatever the model produced,
    // an exact question match in the store wins — that is what "remember what I edited" has to
    // mean, or the same correction has to be made again on the next form.
    // Walk the FIELDS, not the model's reply. A field the model skipped entirely produced no
    // answer to override, so "Country Phone Code*" was reported as unanswerable for eighteen
    // turns while the value sat recorded in the store. A recorded answer must not depend on the
    // model having mentioned the field.
    for (const field of snapshot.fields) {
      const stored = ctx.answers.find((entry) => entry.normalizedQuestion === normalizeQuestion(field.label));
      if (!stored) continue;
      let answer = answers.find((a) => a.key === field.key);
      if (!answer) {
        answer = { key: field.key, value: "", confidence: 0, needsHuman: true, source: "curated" };
        answers.push(answer);
      }
      const value = Array.isArray(stored.answer) ? stored.answer.join(", ") : String(stored.answer ?? "");
      if (!value.trim() || value.trim() === answer.value.trim()) continue;
      // Some stored answers DESCRIBE having nothing to enter rather than being a value — the
      // seed for Phone Extension reads "(none — no extension; leave this field empty)". Typing
      // that into the form is worse than leaving it blank, which is what it actually means.
      const bare = value.trim().replace(/^\(+|\)+$/g, "").trim();
      const meansEmpty =
        /^(none|n\/?a|na|nothing|not applicable|no extension|no middle name)$/i.test(bare) ||
        /^nothing\b/i.test(bare) ||
        /leave (this|the) field empty|leave (it|this) blank/i.test(value);
      // "No" and "None of the above" are REAL answers — only a value that says there is nothing
      // to enter becomes an empty field.
      if (meansEmpty) {
        answer.value = "";
        answer.blank = true;
        answer.needsHuman = false;
        answer.source = "curated";
        continue;
      }
      // For a closed list the stored wording may not be one of the options; leave those alone
      // rather than writing a value the widget cannot take.
      if (field.options?.length && !field.searchable) {
        const lv = value.trim().toLowerCase();
        const lead = (o: string) => o.split(/[,(:—–-]/)[0].trim().toLowerCase();
        if (!field.options.some((o) => o.toLowerCase() === lv || lead(o) === lv)) continue;
      }
      console.log(`  [agent] using your recorded answer for "${field.label.slice(0, 52)}": ${JSON.stringify(value.slice(0, 60))}`);
      answer.value = value;
      answer.source = "curated";
      answer.confidence = 1;
      answer.needsHuman = false;
      answer.draft = false;
    }

    // An address is ONE thing. Motorola rejected an application with "94085 is not a valid postal
    // code for Pennsylvania": the street came from the real home address in Sunnyvale while the
    // state was inferred from the resume's Pittsburgh schooling. Whenever a page asks for address
    // parts, they are all taken from the SAME stored address so they cannot disagree.
    const home = ctx.answers.find((a) => /^home address$/i.test(a.question.trim()));
    const homeText = home ? (Array.isArray(home.answer) ? home.answer.join(", ") : String(home.answer ?? "")) : "";
    const parts = /^(.+?),\s*([^,]+),\s*([A-Za-z .]{2,20})\s+(\d{5})(?:-\d{4})?$/.exec(homeText.trim());
    if (parts) {
      const STATES: Record<string, string> = {
        ca: "California", pa: "Pennsylvania", ny: "New York", wa: "Washington", or: "Oregon",
        tx: "Texas", il: "Illinois", ma: "Massachusetts", nj: "New Jersey", az: "Arizona",
      };
      const [, street, city, stateRaw, postal] = parts;
      const state = STATES[stateRaw.trim().toLowerCase()] ?? stateRaw.trim();
      const pick = (label: string): string | undefined => {
        const l = label.toLowerCase();
        if (/address line ?2|apt|suite|unit\b/.test(l)) return "";
        if (/address line ?1|street address|^address\b/.test(l)) return street.trim();
        if (/\bcity\b|town/.test(l)) return city.trim();
        if (/\bstate\b|province|region$/.test(l)) return state;
        if (/postal code|zip/.test(l)) return postal;
        return undefined;
      };
      for (const field of snapshot.fields) {
        const wanted = pick(field.label);
        if (wanted === undefined) continue;
        // A state dropdown may word it either way; leave a closed list alone unless it offers this.
        if (wanted && field.options?.length && !field.searchable) {
          const lv = wanted.toLowerCase();
          if (!field.options.some((o) => o.toLowerCase() === lv || o.toLowerCase().startsWith(lv))) continue;
        }
        let answer = answers.find((a) => a.key === field.key);
        if (!answer) {
          answer = { key: field.key, value: "", confidence: 0, needsHuman: true, source: "profile" };
          answers.push(answer);
        }
        if (answer.value.trim() === wanted) continue;
        if (wanted || field.required === false) {
          console.log(`  [agent] address field "${field.label.slice(0, 40)}" → ${JSON.stringify(wanted)} (from your home address)`);
          answer.value = wanted;
          answer.source = "profile";
          answer.confidence = 1;
          answer.needsHuman = false;
          answer.blank = wanted === "";
        }
      }
    }

    /**
     * DEGREE LEVEL and GPA are facts, so they are decided from the resume rather than left to the
     * model. Both were being got wrong on live applications in ways that look filled and get
     * believed:
     *   Degree*                            -> "Associate's Degree"          the wrong level
     *   Degree                             -> "Information Systems"         a field of study
     *   Degree                             -> "Python (Programming Language)"  a skill
     *   What is your cumulative GPA?*      -> "3.0-3.5"                     excludes a real 3.53
     *
     * applicationSanity/factChecks BLOCKS all of these, but blocking alone would just park every
     * such job on /blocked forever — the model would keep choosing the same wrong option. This
     * picks the right one instead, and the guardrail stays as the backstop.
     */
    const eduFacts = parseResumeHistory(ctx.resumeText || ctx.profile?.rawText || "").education[0];
    const wantLevel = eduFacts?.degree ? degreeLevel(eduFacts.degree) : undefined;
    const realGpa = Number(ctx.profile?.gpa ?? eduFacts?.gpa ?? "");

    for (const field of snapshot.fields) {
      const label = field.label ?? "";
      const answer = answers.find((a) => a.key === field.key);
      if (!answer) continue;

      // A degree-LEVEL question, not a subject one ("Field of study" wants Information Systems).
      const isDegreeLevel =
        /\b(degree|education level|level of education|highest (level of )?education)\b/i.test(label) &&
        !/\b(field of study|discipline|major|subject|concentration|area of study)\b/i.test(label);
      if (isDegreeLevel && wantLevel) {
        if (field.options?.length) {
          const match = field.options.find((o) => degreeLevel(o) === wantLevel);
          if (match && answer.value !== match) {
            console.log(`  [agent] degree → ${JSON.stringify(match)} (the resume says ${JSON.stringify(eduFacts?.degree)}, not ${JSON.stringify(answer.value)})`);
            answer.value = match;
            answer.source = "profile";
            answer.confidence = 1;
            answer.needsHuman = false;
          }
        } else if (degreeLevel(answer.value) !== wantLevel && eduFacts?.degree) {
          console.log(`  [agent] degree → ${JSON.stringify(eduFacts.degree)} (was ${JSON.stringify(answer.value)}, which is not a ${wantLevel} degree)`);
          answer.value = eduFacts.degree;
          answer.source = "profile";
          answer.confidence = 1;
          answer.needsHuman = false;
        }
      }

      // GPA: the exact figure in a text box, and the band that CONTAINS it in a dropdown.
      if (/\bgpa\b|grade point average|overall result/i.test(label) && !Number.isNaN(realGpa) && realGpa > 0) {
        if (field.options?.length) {
          const band = field.options.find((o) => {
            const parsed = parseGpaBand(o);
            return parsed && bandContains(parsed, realGpa);
          });
          if (band && answer.value !== band) {
            console.log(`  [agent] GPA band → ${JSON.stringify(band)} (contains the real ${realGpa}; was ${JSON.stringify(answer.value)})`);
            answer.value = band;
            answer.source = "profile";
            answer.confidence = 1;
            answer.needsHuman = false;
          }
        } else if (answer.value.trim() !== String(realGpa)) {
          const parsed = parseGpaBand(answer.value);
          // Only correct a value that is a NUMBER or a band and disagrees. Free-text answers like
          // "see transcript" are left alone.
          if (parsed && !bandContains(parsed, realGpa)) {
            console.log(`  [agent] GPA → ${realGpa} (was ${JSON.stringify(answer.value)})`);
            answer.value = String(realGpa);
            answer.source = "profile";
            answer.confidence = 1;
            answer.needsHuman = false;
          }
        }
      }
    }

    // "How did you hear about us?" — prefer the campus channel when the list offers one, per the
    // standing preference (university > company site > job board > referral > social > other).
    for (const field of snapshot.fields) {
      if (!/how did you (hear|find|learn)/i.test(field.label) || !field.options?.length) continue;
      const campus = field.options.find((o) => /campus|university|college|career (fair|center)|school/i.test(o));
      if (!campus) continue;
      const answer = answers.find((a) => a.key === field.key);
      if (!answer || answer.value === campus) continue;
      console.log(`  [agent] "how did you hear" → ${JSON.stringify(campus)} (campus is preferred over ${JSON.stringify(answer.value)})`);
      answer.value = campus;
      answer.source = "curated";
      answer.confidence = 1;
      answer.needsHuman = false;
    }

    return answers;
  }
}
