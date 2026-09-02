import fs from "node:fs/promises";
import path from "node:path";
import { DATA_DIR } from "../config.js";
import { normalizeUrl } from "../utils/normalize.js";

/**
 * URLs the candidate hands over — A SOURCE, exactly like the trackers in job_sites.txt.
 *
 * Not a special path: these become listings with codes, join the same internship list, and are
 * applied to by the same sweep under the same guards. That framing is his and it is the right one —
 * a job he found himself is not a different KIND of job, it is a different place the job came from.
 *
 * The store doubles as the record of what he gave: which URL, when, and the code it became, so
 * "what did I give you and what happened to it" is answerable. He may hand over one or a list, more
 * than once, with repeats, and repeats of postings the trackers already carry — so the CODE IS
 * DERIVED FROM THE URL rather than minted randomly. The same URL submitted twice is the same code,
 * the same listing, and no second identity. Giving one posting two codes is how MERPVQ and NNSRWS
 * became the same Verkada job twice over, one submitted and the other still inviting a decision.
 *
 * One file per request, like the command queue and the notes: the website writes these, and the
 * outcome lives in the normal stores under that code, so nothing here competes with the worker.
 */
export interface RequestedJob {
  /** Six letters, minted here so the request joins the rest of the system immediately. */
  code: string;
  url: string;
  company?: string;
  title?: string;
  /** Anything the candidate wanted to say about it. */
  note?: string;
  by: string;
  at: string;
}

const REQUESTS_DIR = path.join(DATA_DIR, "requests");

/**
 * A six-letter code DERIVED from the URL, so the same posting always gets the same one.
 *
 * Random would mean the same URL submitted twice becomes two listings, two applications and two
 * chances to send one employer the same form. A hash of the normalized URL cannot do that, and it
 * needs no lookup to be correct.
 */
export function codeForUrl(url: string): string {
  const key = normalizeUrl(url);
  // FNV-1a, 32-bit: small, stable across processes, and no dependency.
  let hash = 0x811c9dc5;
  for (let i = 0; i < key.length; i += 1) {
    hash ^= key.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  const letters = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";
  let out = "";
  for (let i = 0; i < 6; i += 1) {
    out += letters[hash % 26];
    hash = Math.floor(hash / 26) + (i + 1) * 7;
  }
  return out;
}

export async function recordRequest(request: Omit<RequestedJob, "at">): Promise<RequestedJob> {
  await fs.mkdir(REQUESTS_DIR, { recursive: true });
  const full: RequestedJob = { ...request, at: new Date().toISOString() };
  const name = `${full.at.replace(/[:.]/g, "-")}-${full.code}.json`;
  const tmp = path.join(REQUESTS_DIR, `.${name}.tmp`);
  await fs.writeFile(tmp, JSON.stringify(full, null, 2), "utf8");
  await fs.rename(tmp, path.join(REQUESTS_DIR, name));
  return full;
}

/** Newest first — the list is a record of what was asked for, so recency is what matters. */
export async function listRequests(): Promise<RequestedJob[]> {
  const names = (await fs.readdir(REQUESTS_DIR).catch(() => [])).filter((n) => n.endsWith(".json"));
  const out: RequestedJob[] = [];
  for (const name of names) {
    try {
      out.push(JSON.parse(await fs.readFile(path.join(REQUESTS_DIR, name), "utf8")) as RequestedJob);
    } catch {
      /* a half-written request is not worth failing the list for */
    }
  }
  return out.sort((a, b) => b.at.localeCompare(a.at));
}

/**
 * The employer's name, guessed from the URL when the candidate did not give one.
 *
 * Every ATS puts the account name in the path — job-boards.greenhouse.io/VERKADA/jobs/123,
 * jobs.ashbyhq.com/VOLEON/…, apply.workable.com/PONY-DOT-AI/… — and a guess that is close is far
 * better than "unknown" here, because the company name is what dedupe and the sibling table match
 * on. The candidate can override it on the form.
 */
export function companyFromUrl(url: string): string {
  try {
    const { hostname, pathname } = new URL(url);
    const parts = pathname.split("/").filter(Boolean);
    const slug =
      /greenhouse|ashbyhq|workable|lever/.test(hostname) && parts[0]
        ? parts[0]
        : hostname.replace(/^(www|jobs|apply|boards|job-boards|careers)\./, "").split(".")[0];
    return slug
      .replace(/-dot-/g, ".")
      .replace(/[-_]+/g, " ")
      .replace(/\b\w/g, (c) => c.toUpperCase())
      .trim();
  } catch {
    return "";
  }
}
