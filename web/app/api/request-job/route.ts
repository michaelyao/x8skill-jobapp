import { enqueueCommand } from "@core/knowledge/commands.js";
import { loadApplications } from "@core/knowledge/applications.js";
import { loadPendingQueue } from "@core/knowledge/approvalQueue.js";
import { loadInternshipList } from "@core/sources/internshipList.js";
import { codeForUrl, companyFromUrl, listRequests, recordRequest } from "@core/knowledge/requestedJobs.js";
import { ledgerStage, queueStage } from "@core/core/statusVocabulary.js";
import { normalizeUrl } from "@core/utils/normalize.js";
import { isResponse, requireUser } from "@/lib/session";

export const runtime = "nodejs";

/**
 * Take job URLs from the candidate. They are A SOURCE, like the trackers in job_sites.txt — his
 * framing, and the right one: a job he found himself is not a different kind of job.
 *
 * He may hand over one or a list, more than once, with repeats, and repeats of postings the
 * trackers already carry. So every URL is reported on individually and nothing is assumed: the same
 * posting twice must produce one listing and one code, because two codes for one posting is how
 * MERPVQ and NNSRWS became the same Verkada job twice over.
 */
interface Outcome {
  url: string;
  code?: string;
  state: "queued" | "already-given" | "already-engaged" | "on-our-list" | "not-a-url";
  detail: string;
}

const URL_RE = /https?:\/\/[^\s,"'<>]+/g;

export async function POST(request: Request): Promise<Response> {
  const user = await requireUser();
  if (isResponse(user)) return user;

  let body: Record<string, unknown>;
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "Bad request" }, { status: 400 });
  }

  const raw = String(body.urls ?? "").trim();
  if (!raw) return Response.json({ error: "Paste at least one job URL" }, { status: 400 });
  const company = body.company ? String(body.company).trim() : undefined;
  const title = body.title ? String(body.title).trim() : undefined;
  const note = body.note ? String(body.note).trim() : undefined;

  // Anything that looks like a URL, however it was pasted — one per line, comma-separated, or with
  // text around it. Duplicates within one paste collapse here.
  const found = [...new Set(raw.match(URL_RE) ?? [])];
  if (!found.length) return Response.json({ error: "No URLs found in that" }, { status: 400 });
  if (found.length > 50) return Response.json({ error: `That is ${found.length} URLs; 50 at a time` }, { status: 400 });

  const [ledger, queue, listed, requests] = await Promise.all([
    loadApplications(),
    loadPendingQueue(),
    loadInternshipList().catch(() => []),
    listRequests(),
  ]);
  const alreadyRequested = new Map(requests.map((r) => [normalizeUrl(r.url), r.code]));

  const outcomes: Outcome[] = [];
  for (const url of found) {
    let normalized: string;
    try {
      normalized = normalizeUrl(new URL(url).toString());
    } catch {
      outcomes.push({ url, state: "not-a-url", detail: "that is not a URL I can open" });
      continue;
    }

    const engaged =
      ledger.find((a) => a.applyUrl && normalizeUrl(a.applyUrl) === normalized) ??
      queue.find((e) => e.applyUrl && normalizeUrl(e.applyUrl) === normalized);
    if (engaged) {
      outcomes.push({
        url,
        code: "code" in engaged ? engaged.code : undefined,
        state: "already-engaged",
        detail: `already handled as ${("code" in engaged && engaged.code) || "an existing application"} — ${engaged.status}`,
      });
      continue;
    }

    // A posting the trackers already carry keeps ITS code; applying under a new one would give one
    // job two identities.
    const onList = listed.find((j) => j.applyUrl && normalizeUrl(j.applyUrl) === normalized);
    if (onList?.id) {
      await enqueueCommand({ name: "apply", code: onList.id, source: "web", actor: user.username });
      outcomes.push({ url, code: onList.id, state: "on-our-list", detail: `already on our own list as ${onList.id} (${onList.company}) — queued under that code` });
      continue;
    }

    const previous = alreadyRequested.get(normalized);
    if (previous) {
      outcomes.push({ url, code: previous, state: "already-given", detail: `you gave me this one before — it is ${previous}` });
      continue;
    }

    const code = codeForUrl(url);
    await recordRequest({ code, url, company, title, note, by: user.username });
    alreadyRequested.set(normalized, code);
    await enqueueCommand({ name: "apply", code, source: "web", actor: user.username });
    outcomes.push({ url, code, state: "queued", detail: `${company || companyFromUrl(url) || "this one"} — queued as ${code}` });
  }

  return Response.json({ ok: true, outcomes });
}

/** What has been handed over, and the code each became. */
/**
 * The requests WITH WHAT BECAME OF THEM.
 *
 * The list used to be url + code + when, and every code linked to /queue/<code> — which only
 * exists once an application reaches the review step. Eight postings added by hand produced eight
 * dead links: three were an ATS this tool cannot drive at all, two stopped inside Oracle's
 * authentication gate, one never ran. "Where are the jobs I added?" is the question this page is
 * for, and it could not answer it.
 */
export async function GET(): Promise<Response> {
  const user = await requireUser();
  if (isResponse(user)) return user;
  const [requests, queue, apps] = await Promise.all([listRequests(), loadPendingQueue(), loadApplications()]);
  const byCode = new Map(queue.map((e) => [e.code ?? e.key, e]));
  const ledger = new Map(apps.map((a) => [a.code ?? a.id, a]));
  const rows = requests.map((r) => {
    const q = byCode.get(r.code);
    const l = ledger.get(r.code);
    const stage = q ? queueStage(q.status) : ledgerStage(l?.status);
    return {
      ...r,
      // Where the code should actually take you: the review page only exists for a queue entry.
      href: q ? `/queue/${r.code}` : l ? `/applications/${r.code}` : undefined,
      state: stage?.label ?? (l || q ? l?.status ?? q?.status : "not run yet"),
      meaning: stage?.meaning ?? (l || q ? undefined : "It is on the list; the worker has not opened it yet."),
      tone: stage?.tone ?? "muted",
      lastError: q?.lastError ?? undefined,
    };
  });
  return Response.json({ requests: rows });
}
