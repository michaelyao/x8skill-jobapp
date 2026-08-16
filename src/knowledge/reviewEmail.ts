import { spawn } from "node:child_process";

/** One reviewed answer, rendered as a Q/A block in the email. */
export interface ReviewAnswer {
  label: string;
  value: string;
  draft?: boolean;
}

/**
 * An unresolved "is this the same job?" question, with the confidence behind it. Emitted
 * when a job matches an earlier one on company + title but shares no hard identifier, so
 * it cannot be decided automatically without risking either a dropped application or a
 * duplicate one.
 */
export interface DuplicateWarning {
  confidence: number; // 0..1
  basis: string;
  otherCode?: string;
  otherUrl?: string;
  otherStatus?: string;
}

/** The data an application review email / approval poll needs. */
export interface ReviewData {
  company: string;
  title: string;
  code?: string;
  applyUrl: string;
  location?: string;
  region?: string;
  resumeName?: string;
  resumeStandard?: boolean;
  jobDescription: string;
  filledFields: string[]; // "label: value" fallback rendering
  answers?: ReviewAnswer[]; // structured Q/A (preferred rendering)
  companyReqId?: string;
  duplicateWarning?: DuplicateWarning;
}

/** Outcome of scanning the inbox for the user's reply to a review email. */
export interface ReplyDecision {
  decision: "approved" | "skip" | "change" | "none";
  changeText?: string; // the user's words, when they asked for a change
  messageId?: string; // the reply we acted on (so it isn't processed twice)
}

// gog is authorized for myao@studiox8.com (which also receives nyao2's forwarded
// mail). It sends the review email and reads the approval reply from that inbox.
const gogAccount = () => process.env.GOG_ACCOUNT || "myao@studiox8.com";
// Send to BOTH the applicant address and the monitored inbox, so the review
// email reliably lands where the user reads mail (and gog can read it).
export const reviewTo = () =>
  process.env.REVIEW_EMAIL_TO || `${process.env.JOB_APP_USERNAME || "nyao2@andrew.cmu.edu"}, ${gogAccount()}`;

function gog(args: string[], timeoutMs = 60000): Promise<{ code: number; out: string }> {
  return new Promise((resolve) => {
    const child = spawn("gog", args);
    let out = "";
    child.stdout.on("data", (d) => (out += d.toString()));
    child.stderr.on("data", (d) => (out += d.toString()));
    const timer = setTimeout(() => {
      child.kill();
      resolve({ code: 124, out });
    }, timeoutMs);
    child.on("error", (e) => {
      clearTimeout(timer);
      resolve({ code: 1, out: String(e) });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code: code ?? 0, out });
    });
  });
}

export function reviewSubject(d: ReviewData): string {
  return `Review & Approve: ${d.title} @ ${d.company} [${d.code || ""}]`;
}

const esc = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/** Structured answers when available, else parse the "label: value" fallback. */
function answersFor(d: ReviewData): ReviewAnswer[] {
  if (d.answers && d.answers.length) return d.answers;
  return d.filledFields.map((f) => {
    const i = f.indexOf(":");
    const label = i >= 0 ? f.slice(0, i).trim() : f.trim();
    let value = i >= 0 ? f.slice(i + 1).trim() : "";
    const draft = /\(DRAFT\)/i.test(value);
    value = value.replace(/\s*\(DRAFT\)\s*/i, "").replace(/\s*\(you\)\s*/i, "").trim();
    return { label, value, draft };
  });
}

/** Plain-text body (fallback for clients that don't render HTML). */
function reviewBody(d: ReviewData): string {
  const qa = answersFor(d);
  return [
    "This application is filled and paused at the Review step. It has NOT been submitted.",
    "",
    `Company:   ${d.company}`,
    `Role:      ${d.title}`,
    d.location ? `Location:  ${d.location}` : "",
    d.region ? `Region:    ${d.region}` : "",
    `Posting:   ${d.applyUrl}`,
    `Resume:    ${d.resumeName || "?"}${d.resumeStandard === false ? " (tailored)" : " (standard)"}`,
    d.code ? `Code:      ${d.code}` : "",
    "",
    '>>> Reply "APPROVE" to submit, "SKIP" to drop it, or describe any change (e.g. "use the',
    '    Pittsburgh address") and I\'ll update it and email you a fresh copy to approve. <<<',
    "You can reply anytime — even days later. It's saved in the approval queue and submitted",
    "automatically the next time the poller runs after your reply.",
    "",
    "──────── Application answers ────────",
    qa.length ? qa.map((a) => `Q: ${a.label}\nA: ${a.value}${a.draft ? "   (draft — please review)" : ""}`).join("\n\n") : "(none)",
    "",
    "──────── Job description ────────",
    `Posting: ${d.applyUrl}`,
    "",
    d.jobDescription || "(none captured)",
  ]
    .filter((line) => line !== "")
    .join("\n");
}

/** Beautified HTML body: bold questions, distinct answers, framed job description. */
function reviewBodyHtml(d: ReviewData): string {
  const qa = answersFor(d);
  const metaRow = (k: string, v: string) =>
    `<tr><td style="padding:2px 12px 2px 0;color:#6b7280;white-space:nowrap;vertical-align:top">${esc(k)}</td><td style="padding:2px 0;color:#111827">${v}</td></tr>`;
  const link = `<a href="${esc(d.applyUrl)}" style="color:#2563eb;text-decoration:none">${esc(d.applyUrl)}</a>`;

  const answersHtml = qa.length
    ? qa
        .map(
          (a) =>
            `<div style="margin:0 0 14px 0">
               <div style="font-weight:700;color:#111827">${esc(a.label)}</div>
               <div style="margin-top:2px;color:#1f2937"><span style="font-weight:700;color:#059669">A:</span> ${esc(a.value) || "<em style='color:#9ca3af'>(empty)</em>"}${a.draft ? ' <span style="background:#fef3c7;color:#92400e;font-size:12px;padding:1px 6px;border-radius:10px;margin-left:6px">draft — please review</span>' : ""}</div>
             </div>`,
        )
        .join("")
    : "<em style='color:#9ca3af'>(none)</em>";

  const jd = esc(d.jobDescription || "(none captured)");

  return `<div style="font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;max-width:720px;margin:0 auto;color:#111827;line-height:1.5">
    <h2 style="margin:0 0 4px 0;font-size:20px">${esc(d.title)}</h2>
    <div style="color:#6b7280;margin-bottom:14px">${esc(d.company)}${d.code ? ` &middot; <span style="font-family:monospace">${esc(d.code)}</span>` : ""}</div>

    <div style="background:#fffbeb;border:1px solid #fde68a;border-radius:8px;padding:12px 14px;margin-bottom:16px">
      <div style="font-weight:700;color:#92400e;margin-bottom:4px">Not submitted — your call</div>
      <div style="color:#78350f;font-size:14px">
        Reply <b>APPROVE</b> to submit &nbsp;·&nbsp; <b>SKIP</b> to drop &nbsp;·&nbsp; or describe a change
        (e.g. <i>"use the Pittsburgh address"</i>) and I'll update it and send a fresh copy to approve.<br>
        <span style="color:#a16207">Reply anytime — even days later; it's queued and submitted automatically after your reply.</span>
      </div>
    </div>

    ${
      d.duplicateWarning
        ? `<div style="background:#eff6ff;border:1px solid #bfdbfe;border-radius:8px;padding:12px 14px;margin-bottom:16px">
             <div style="font-weight:700;color:#1e40af;margin-bottom:4px">Possible duplicate — ${(d.duplicateWarning.confidence * 100).toFixed(0)}% confidence &middot; needs your call</div>
             <div style="color:#1e3a8a;font-size:14px">
               This looks like a job already in your records${d.duplicateWarning.otherCode ? ` (<span style="font-family:monospace">${esc(d.duplicateWarning.otherCode)}</span>${d.duplicateWarning.otherStatus ? `, ${esc(d.duplicateWarning.otherStatus)}` : ""})` : ""}, but they share no requisition or posting id, so it could equally be a second genuine opening.<br>
               <span style="color:#1d4ed8">Basis: ${esc(d.duplicateWarning.basis)}</span>${d.duplicateWarning.otherUrl ? `<br><a href="${esc(d.duplicateWarning.otherUrl)}" style="color:#2563eb">compare the other posting</a>` : ""}<br>
               Approving submits this as a separate application; reply <b>SKIP</b> if it is the same job.
             </div>
           </div>`
        : ""
    }

    <table style="border-collapse:collapse;font-size:14px;margin-bottom:18px">
      ${metaRow("Company", esc(d.company))}
      ${metaRow("Role", esc(d.title))}
      ${d.location ? metaRow("Location", esc(d.location)) : ""}
      ${d.region ? metaRow("Region", esc(d.region)) : ""}
      ${metaRow("Resume", `${esc(d.resumeName || "?")} ${d.resumeStandard === false ? "(tailored)" : "(standard)"}`)}
      ${d.companyReqId ? metaRow("Requisition", `<span style="font-family:monospace">${esc(d.companyReqId)}</span>`) : ""}
      ${metaRow("Posting", link)}
      ${metaRow("Screenshot", "attached (full page, as filled)")}
    </table>

    <h3 style="font-size:15px;border-bottom:2px solid #e5e7eb;padding-bottom:6px;margin:0 0 12px 0">Application answers</h3>
    ${answersHtml}

    <h3 style="font-size:15px;border-bottom:2px solid #e5e7eb;padding-bottom:6px;margin:22px 0 8px 0">Job description</h3>
    <div style="font-size:13px;margin-bottom:8px">Posting: ${link}</div>
    <div style="background:#f9fafb;border:1px solid #e5e7eb;border-radius:8px;padding:14px 16px;white-space:pre-wrap;font-size:13px;color:#374151;max-height:none">${jd}</div>
  </div>`;
}

/** What a blocked / stopped-before-review job reports for debugging. */
export interface BlockedData {
  company: string;
  title: string;
  code?: string;
  applyUrl: string;
  blockedRequired: string[]; // required fields still empty (why we stopped)
  unknown: string[]; // no answer available — never attempted
  failedToFill?: string[]; // attempted, but the widget would not accept the value
  filledCount: number;
  turns: number;
}

export function blockedSubject(d: BlockedData): string {
  const why = d.blockedRequired[0] ? `blocked: ${d.blockedRequired.join(", ")}` : "stopped before review";
  return `⛔ Not submitted — ${d.title} @ ${d.company} [${d.code || ""}] — ${why}`;
}

function blockedBody(d: BlockedData): string {
  return [
    "This application could NOT be completed, so nothing was submitted and nothing is",
    "queued for approval. No reply is needed — this is a debugging notice.",
    "",
    `Company:  ${d.company}`,
    `Role:     ${d.title}`,
    `Posting:  ${d.applyUrl}`,
    d.code ? `Code:     ${d.code}` : "",
    `Progress: ${d.filledCount} field(s) filled over ${d.turns} turn(s)`,
    "",
    d.blockedRequired.length
      ? `Required fields still empty (why it stopped):\n${d.blockedRequired.map((f) => `  - ${f}`).join("\n")}`
      : "Stopped before reaching the Review step.",
    "",
    d.unknown.length ? `No answer available — never attempted, needs you:\n${d.unknown.map((f) => `  - ${f}`).join("\n")}` : "",
    d.failedToFill?.length ? `Tried, but the field would not take the value:\n${d.failedToFill.map((f) => `  - ${f}`).join("\n")}` : "",
    "",
    "The attached screenshot is the full page as the run left it.",
  ]
    .filter((line) => line !== "")
    .join("\n");
}

function blockedBodyHtml(d: BlockedData): string {
  const link = `<a href="${esc(d.applyUrl)}" style="color:#2563eb;text-decoration:none">${esc(d.applyUrl)}</a>`;
  const list = (items: string[]) =>
    `<ul style="margin:6px 0 0 0;padding-left:20px;color:#1f2937">${items.map((f) => `<li style="margin:2px 0">${esc(f)}</li>`).join("")}</ul>`;

  return `<div style="font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;max-width:720px;margin:0 auto;color:#111827;line-height:1.5">
    <h2 style="margin:0 0 4px 0;font-size:20px">${esc(d.title)}</h2>
    <div style="color:#6b7280;margin-bottom:14px">${esc(d.company)}${d.code ? ` &middot; <span style="font-family:monospace">${esc(d.code)}</span>` : ""}</div>

    <div style="background:#fef2f2;border:1px solid #fecaca;border-radius:8px;padding:12px 14px;margin-bottom:16px">
      <div style="font-weight:700;color:#991b1b;margin-bottom:4px">Not submitted — could not complete the form</div>
      <div style="color:#7f1d1d;font-size:14px">
        Nothing was submitted and nothing is queued. <b>No reply needed</b> — this is a debugging
        notice so you can see the form without digging through the run logs.
      </div>
    </div>

    <table style="border-collapse:collapse;font-size:14px;margin-bottom:18px">
      <tr><td style="padding:2px 12px 2px 0;color:#6b7280;white-space:nowrap">Progress</td><td style="padding:2px 0">${d.filledCount} field(s) filled over ${d.turns} turn(s)</td></tr>
      <tr><td style="padding:2px 12px 2px 0;color:#6b7280;white-space:nowrap">Posting</td><td style="padding:2px 0">${link}</td></tr>
      <tr><td style="padding:2px 12px 2px 0;color:#6b7280;white-space:nowrap">Screenshot</td><td style="padding:2px 0">attached (full page, as the run left it)</td></tr>
    </table>

    ${
      d.blockedRequired.length
        ? `<h3 style="font-size:15px;border-bottom:2px solid #e5e7eb;padding-bottom:6px;margin:0 0 8px 0">Required fields still empty</h3>${list(d.blockedRequired)}`
        : `<h3 style="font-size:15px;border-bottom:2px solid #e5e7eb;padding-bottom:6px;margin:0 0 8px 0">Stopped before the Review step</h3>`
    }
    ${
      d.unknown.length
        ? `<h3 style="font-size:15px;border-bottom:2px solid #e5e7eb;padding-bottom:6px;margin:22px 0 8px 0">No answer available — never attempted, needs you</h3>${list(d.unknown)}`
        : ""
    }
    ${
      d.failedToFill?.length
        ? `<h3 style="font-size:15px;border-bottom:2px solid #e5e7eb;padding-bottom:6px;margin:22px 0 8px 0">Tried, but the field would not take the value</h3>${list(d.failedToFill)}`
        : ""
    }
  </div>`;
}

/**
 * Email the debugging notice for a job that stopped before Review, with the
 * full-page screenshot attached. Deliberately carries NO approve/skip wording: a
 * blocked job is never queued, so no reply can act on it.
 */
export async function sendBlockedEmail(d: BlockedData, attachPath?: string): Promise<string> {
  const args = [
    "-a", gogAccount(),
    "gmail", "send",
    "--from", gogAccount(),
    "--to", reviewTo(),
    "--subject", blockedSubject(d),
    "--body", blockedBody(d),
    "--body-html", blockedBodyHtml(d),
  ];
  if (attachPath) args.push("--attach", attachPath);
  const { code, out } = await gog(args, 90000);
  return code === 0 ? "sent" : `send failed: ${out.slice(0, 200)}`;
}

/** Send the review email (HTML + plain-text), optionally attaching the review screenshot. */
export async function sendReviewEmail(d: ReviewData, attachPath?: string): Promise<string> {
  const args = [
    "-a", gogAccount(),
    "gmail", "send",
    "--from", gogAccount(),
    "--to", reviewTo(),
    "--subject", reviewSubject(d),
    "--body", reviewBody(d),
    "--body-html", reviewBodyHtml(d),
  ];
  if (attachPath) args.push("--attach", attachPath);
  const { code, out } = await gog(args, 90000);
  return code === 0 ? "sent" : `send failed: ${out.slice(0, 200)}`;
}

const APPROVE_RE = /\b(approve|approved|lgtm|looks good|go ahead|submit it|confirmed?|yes)\b/;
const SKIP_RE = /\b(skip|reject|hold off|no thanks|don'?t submit|withdraw|cancel)\b/;
const CHANGE_RE = /\b(change|instead|replace|update|fix|correct|revis|edit|wrong|should be|make it|shorten|rewrite|actually|use the|set .* to)\b/;

/** Strip the quoted original from a reply, leaving just the user's own words. */
function extractUserReply(body: string): string {
  const lines = body.split(/\r?\n/);
  const kept: string[] = [];
  for (const line of lines) {
    if (/^\s*>/.test(line)) break; // quoted block
    if (/wrote:\s*$/i.test(line)) break; // "On <date> X wrote:"
    if (/^\s*-+\s*original message/i.test(line)) break;
    if (/^\s*_{5,}/.test(line)) break;
    if (/>>>\s*reply/i.test(line)) break; // our own instruction line quoted inline
    kept.push(line);
  }
  return kept.join("\n").trim();
}

/** Message ids in a thread, oldest→newest. */
async function threadMessageIds(threadId: string): Promise<string[]> {
  const out = await gog(["-a", gogAccount(), "gmail", "thread", "get", threadId, "-j"]);
  try {
    const d = JSON.parse(out.out) as { thread?: { messages?: Array<{ id?: string }> } };
    return (d.thread?.messages ?? []).map((m) => m.id).filter((x): x is string => Boolean(x));
  } catch {
    return [];
  }
}

/** Classify one message body's own words into a decision. */
function classifyReply(body: string): { decision: ReplyDecision["decision"]; changeText?: string } | null {
  const userWords = extractUserReply(body);
  if (!userWords) return null;
  const lu = userWords.toLowerCase();
  if (CHANGE_RE.test(lu)) return { decision: "change", changeText: userWords.slice(0, 1500) };
  if (SKIP_RE.test(lu)) return { decision: "skip" };
  if (APPROVE_RE.test(lu)) return { decision: "approved" };
  // Real content but no clear keyword → treat as a change (re-review, don't submit).
  return { decision: "change", changeText: userWords.slice(0, 1500) };
}

/**
 * One inbox pass: how has the user replied for THIS job? Returns approved / skip /
 * change / none (+ the change text and the reply's message id). Because we send the
 * review email to the monitored inbox too, that SENT copy sits in the thread — so we
 * walk each matching thread and consider only NON-sent messages (the real replies),
 * newest first. `ignoreIds` are replies already acted on.
 */
/**
 * ONE search that answers "which jobs have a reply at all?".
 *
 * checkApprovalOnce costs a search, a thread fetch and a message fetch PER JOB; with 30+
 * queued that is a hundred subprocesses every poll. Gmail's thread list already carries the
 * subject (which holds the job code) and the message count, so a single call narrows the
 * expensive, safety-critical check down to the handful of threads that actually grew a reply.
 * The attribution rules stay untouched in checkApprovalOnce — this only decides who to ask about.
 */
export async function codesWithReplies(newerThanDays = 14): Promise<Set<string>> {
  const { out } = await gog([
    "-a", gogAccount(), "gmail", "search",
    `newer_than:${newerThanDays}d subject:"Review & Approve"`, "-j", "--max", "100",
  ]);
  const codes = new Set<string>();
  let parsed: { threads?: Array<{ subject?: string; messageCount?: number }> };
  try {
    parsed = JSON.parse(out);
  } catch {
    return codes;
  }
  for (const thread of parsed.threads ?? []) {
    // Our own review email is one message; a reply makes it two. A reply that starts its own
    // thread still carries the code in its subject, so count it too.
    const isReply = /^\s*re:/i.test(thread.subject ?? "");
    if (!isReply && (thread.messageCount ?? 1) < 2) continue;
    const code = (thread.subject ?? "").match(/\[([A-Z]{4,8})\]/)?.[1];
    if (code) codes.add(code.toUpperCase());
  }
  return codes;
}

export async function checkApprovalOnce(
  d: ReviewData,
  opts: { newerThanDays?: number; ignoreIds?: string[] } = {},
): Promise<ReplyDecision> {
  const code = (d.code || "").toLowerCase();
  // SAFETY: a reply is attributed to a job ONLY by its unique code — never by
  // company name. Two roles at the same company (e.g. Cybernetic Labs WVJGTG and
  // KDUGRO) would otherwise cross-contaminate: an approval for one would submit the
  // other. With no code we cannot safely attribute any reply, so never auto-act.
  if (!code) return { decision: "none" };
  const ignore = new Set(opts.ignoreIds ?? []);
  const search = await gog([
    "-a", gogAccount(), "gmail", "search",
    `newer_than:${opts.newerThanDays ?? 14}d subject:"Review & Approve" "${(d.code || "").toUpperCase()}"`, "-j", "--max", "20",
  ]);
  // Search returns one representative per thread; its id doubles as the thread id.
  const threadIds = [...new Set([...search.out.matchAll(/"(?:threadId|id)"\s*:\s*"([0-9a-fA-F]+)"/g)].map((m) => m[1]))];
  for (const threadId of threadIds) {
    const msgIds = await threadMessageIds(threadId);
    // Newest first so a later APPROVE wins over an earlier message.
    for (const mid of [...msgIds].reverse()) {
      if (ignore.has(mid)) continue;
      const msg = await gog(["-a", gogAccount(), "gmail", "get", mid, "-j", "--format", "full"]);
      let parsed: {
        body?: string;
        message?: { labelIds?: string[]; payload?: { headers?: Array<{ name: string; value: string }> } };
      };
      try {
        parsed = JSON.parse(msg.out);
      } catch {
        continue;
      }
      const labels = parsed.message?.labelIds ?? [];
      const subject =
        (parsed.message?.payload?.headers ?? []).find((h) => h.name.toLowerCase() === "subject")?.value ?? "";
      // Skip the review email WE sent — not everything this account sent. The review goes
      // to myao@ as well as nyao2@, so replying from myao@ produces a message labelled
      // SENT; excluding SENT outright silently ignored those approvals. Our own outgoing
      // copy is the one that is not a reply, so the subject is what separates them.
      const isOurOutgoingCopy = labels.includes("SENT") && !/^\s*re:/i.test(subject);
      if (isOurOutgoingCopy) continue;
      const body = String(parsed.body ?? "");
      // Require the UNIQUE code in the reply — never company (see SAFETY note above).
      if (!body.toLowerCase().includes(code)) continue;
      const verdict = classifyReply(body);
      if (verdict) return { ...verdict, messageId: mid };
    }
  }
  return { decision: "none" };
}

/**
 * Short inline grace wait during a fill run. Returns approved / skip / timeout.
 * A change reply is ignored here (left to the async poller) so the fill run just
 * queues and moves on. Long waits are handled by the approval queue + poller.
 */
export async function waitForApproval(
  d: ReviewData,
  opts: { timeoutMs: number; pollMs: number },
): Promise<"approved" | "skip" | "timeout"> {
  const deadline = Date.now() + opts.timeoutMs;
  while (Date.now() < deadline) {
    const { decision } = await checkApprovalOnce(d, { newerThanDays: 1 });
    if (decision === "approved" || decision === "skip") return decision;
    await new Promise((res) => setTimeout(res, opts.pollMs));
  }
  return "timeout";
}

/** Confirmation email after an approved application is actually submitted. */
export async function sendSubmittedEmail(d: ReviewData): Promise<string> {
  const subject = `Submitted: ${d.title} @ ${d.company}${d.code ? ` [${d.code}]` : ""}`;
  const body = [
    `Submitted ✅  ${d.title} @ ${d.company}${d.code ? ` [${d.code}]` : ""}`,
    "",
    `Posting: ${d.applyUrl}`,
    "This application was approved by your reply and has now been submitted.",
  ].join("\n");
  const html = `<div style="font-family:-apple-system,Segoe UI,Roboto,Arial,sans-serif;color:#111827">
    <h2 style="margin:0 0 6px 0">Submitted ✅</h2>
    <div style="color:#374151">${esc(d.title)} @ <b>${esc(d.company)}</b>${d.code ? ` &middot; <span style="font-family:monospace">${esc(d.code)}</span>` : ""}</div>
    <div style="margin-top:8px"><a href="${esc(d.applyUrl)}" style="color:#2563eb">${esc(d.applyUrl)}</a></div>
    <p style="color:#374151">Approved by your reply and now submitted.</p>
  </div>`;
  const { code, out } = await gog([
    "-a", gogAccount(), "gmail", "send",
    "--from", gogAccount(), "--to", reviewTo(),
    "--subject", subject, "--body", body, "--body-html", html,
  ], 90000);
  return code === 0 ? "sent" : `send failed: ${out.slice(0, 200)}`;
}
