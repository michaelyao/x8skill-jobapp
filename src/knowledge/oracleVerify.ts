import { spawn } from "node:child_process";

/**
 * Oracle HCM ("CandidateExperience") puts an email gate in front of the application: enter an
 * address, agree to the terms, and the tenant emails a one-time code. This reads that code out of
 * the inbox gog is authenticated for.
 *
 * The mail is addressed to the PROFILE email (nyao2@andrew.cmu.edu) and reaches the account gog
 * reads (myao@studiox8.com) by forwarding — verified before this was written, not assumed.
 */
const gogAccount = () => process.env.GOG_ACCOUNT || "myao@studiox8.com";

function gog(args: string[], timeoutMs = 60_000): Promise<{ code: number; out: string }> {
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

/**
 * Pull a one-time code out of an email. A PURE function, so it can be tested — the thing that
 * makes this dangerous is not fetching the mail, it is picking the wrong number out of it.
 *
 * Anchored on the words around the code rather than "find some digits": a verification email is
 * full of numbers that are not the code — a requisition id, a year, a phone number, a street
 * address, an unsubscribe id. Submitting the wrong one burns an attempt and some tenants lock the
 * address after a few. If nothing is anchored, this returns null and the caller waits, which is
 * always recoverable; guessing is not.
 */
export function verificationCodeFrom(subject: string, body: string): string | null {
  const text = `${subject}\n${body}`.replace(/ /g, " ");
  const ANCHOR =
    "(?:verification|confirmation|security|access|one[\\s-]?time|single[\\s-]?use|login|sign[\\s-]?in)?\\s*" +
    "(?:code|passcode|pin|otp)";
  const patterns = [
    // "your verification code is 123456" / "access code: 123456"
    new RegExp(`${ANCHOR}\\s*(?:is|:|=)?\\s*\\b(\\d{4,8})\\b`, "i"),
    // "123456 is your verification code"
    new RegExp(`\\b(\\d{4,8})\\b\\s*(?:is\\s+your\\s+)?${ANCHOR}`, "i"),
    // a code alone on its own line, directly under an anchor line
    new RegExp(`${ANCHOR}[^\\n]*\\n+\\s*(\\d{4,8})\\s*(?:\\n|$)`, "i"),
  ];
  for (const re of patterns) {
    const m = text.match(re);
    if (m?.[1] && !isNotACode(m[1])) return m[1];
  }
  return null;
}

/** Numbers that look like codes but never are. */
function isNotACode(digits: string): boolean {
  if (/^(19|20)\d{2}$/.test(digits)) return true; // a year
  if (/^(\d)\1+$/.test(digits)) return true; // 000000, 111111 — placeholder text
  return false;
}

interface GogThread {
  id?: string;
  date?: string;
  from?: string;
  subject?: string;
}

/**
 * Poll for an Oracle verification code. Returns null on timeout.
 *
 * `notBefore` is what keeps a STALE code from being used: applying to a second Oracle tenant an
 * hour later would otherwise match the previous tenant's still-recent email and submit a code that
 * was never valid here. Gmail's `after:` has second granularity, so the timestamp is also
 * re-checked per message.
 */
export async function fetchOracleVerificationCode(opts: {
  timeoutMs: number;
  pollMs: number;
  notBefore: Date;
}): Promise<string | null> {
  const deadline = Date.now() + opts.timeoutMs;
  const afterEpoch = Math.floor(opts.notBefore.getTime() / 1000);
  const queries = [
    `after:${afterEpoch} (subject:(verification OR verify OR "access code" OR "one-time"))`,
    `after:${afterEpoch} (from:oracle OR from:oraclecloud OR from:taleo)`,
    `after:${afterEpoch} ("verification code" OR "access code" OR "one-time passcode")`,
  ];
  while (Date.now() < deadline) {
    for (const q of queries) {
      const search = await gog(["-a", gogAccount(), "gmail", "search", q, "-j", "--max", "10"]);
      let threads: GogThread[] = [];
      try {
        threads = (JSON.parse(search.out) as { threads?: GogThread[] }).threads ?? [];
      } catch {
        threads = [...search.out.matchAll(/"id"\s*:\s*"([0-9a-fA-F]+)"/g)].map((m) => ({ id: m[1] }));
      }
      for (const thread of threads) {
        if (!thread.id) continue;
        const msg = await gog(["-a", gogAccount(), "gmail", "get", thread.id, "-j", "--format", "full"]);
        let subject = thread.subject ?? "";
        let body = msg.out;
        let internalMs = 0;
        try {
          const parsed = JSON.parse(msg.out) as { body?: string; subject?: string; date?: string };
          body = String(parsed.body ?? msg.out);
          subject = parsed.subject ?? subject;
          if (parsed.date) internalMs = Date.parse(parsed.date);
        } catch {
          /* fall back to the raw output */
        }
        // Belt and braces on staleness: `after:` is coarse, so drop anything older than the ask.
        if (internalMs && internalMs < opts.notBefore.getTime() - 60_000) continue;
        const code = verificationCodeFrom(subject, body);
        if (code) return code;
      }
    }
    await new Promise((res) => setTimeout(res, opts.pollMs));
  }
  return null;
}
