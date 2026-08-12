import { spawn } from "node:child_process";

// gog reads the myao inbox (which also receives nyao2's forwarded mail). Workday
// password-reset emails land here; we extract the reset link from them.
const gogAccount = () => process.env.GOG_ACCOUNT || "myao@studiox8.com";

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

/** Pull the first Workday-looking reset URL out of an email body. */
function extractResetLink(body: string): string | null {
  const patterns = [
    /https?:\/\/[^\s"'<>]*myworkday[^\s"'<>]*/i,
    /https?:\/\/[^\s"'<>]*(?:reset[-_]?password|resetpassword|passwordreset)[^\s"'<>]*/i,
    /https?:\/\/[^\s"'<>]*(?:token|resetToken)=[^\s"'<>]*/i,
  ];
  for (const re of patterns) {
    const m = body.match(re);
    if (m) return m[0].replace(/[).,;'"]+$/, "");
  }
  return null;
}

/** Pull the account-activation (email-verification) link out of an email body. */
function extractActivateLink(body: string): string | null {
  const m =
    body.match(/https?:\/\/[^\s"'<>]*\/activate\/[^\s"'<>]*/i) ||
    body.match(/https?:\/\/[^\s"'<>]*myworkday[^\s"'<>]*/i);
  return m ? m[0].replace(/[).,;'"]+$/, "") : null;
}

/**
 * Poll the gog inbox for a Workday "verify your candidate account" email and
 * return the activation URL (which validates the account and redirects into the
 * application). Returns null on timeout.
 */
export async function fetchWorkdayActivateLink(opts: {
  timeoutMs: number;
  pollMs: number;
}): Promise<string | null> {
  const deadline = Date.now() + opts.timeoutMs;
  const queries = [
    'newer_than:1h from:otp.workday.com',
    'newer_than:1h (subject:(verify OR activate OR confirm) candidate)',
    'newer_than:1h "confirm your email"',
    'newer_than:1h subject:"verify your candidate account"',
  ];
  while (Date.now() < deadline) {
    for (const q of queries) {
      const search = await gog(["-a", gogAccount(), "gmail", "search", q, "-j", "--max", "10"]);
      const ids = [...search.out.matchAll(/"id"\s*:\s*"([0-9a-fA-F]+)"/g)].map((m) => m[1]);
      for (const id of ids) {
        const msg = await gog(["-a", gogAccount(), "gmail", "get", id, "-j", "--format", "full"]);
        let body = "";
        try {
          body = String((JSON.parse(msg.out) as { body?: string }).body ?? "");
        } catch {
          body = msg.out;
        }
        const link = extractActivateLink(body);
        if (link) return link;
      }
    }
    await new Promise((res) => setTimeout(res, opts.pollMs));
  }
  return null;
}

/**
 * Poll the gog inbox for a Workday password-reset email and return the reset URL.
 * Returns null on timeout. `sinceIso` narrows the search to mail received after
 * the reset was requested (avoids picking up a stale link).
 */
export async function fetchWorkdayResetLink(opts: {
  timeoutMs: number;
  pollMs: number;
}): Promise<string | null> {
  const deadline = Date.now() + opts.timeoutMs;
  const queries = [
    'newer_than:1h subject:(password) reset',
    'newer_than:1h from:workday',
    'newer_than:1h (reset your password OR password reset OR set a new password)',
  ];
  while (Date.now() < deadline) {
    for (const q of queries) {
      const search = await gog(["-a", gogAccount(), "gmail", "search", q, "-j", "--max", "10"]);
      const ids = [...search.out.matchAll(/"id"\s*:\s*"([0-9a-fA-F]+)"/g)].map((m) => m[1]);
      for (const id of ids) {
        const msg = await gog(["-a", gogAccount(), "gmail", "get", id, "--format", "full"]);
        const link = extractResetLink(msg.out);
        if (link) return link;
      }
    }
    await new Promise((res) => setTimeout(res, opts.pollMs));
  }
  return null;
}
