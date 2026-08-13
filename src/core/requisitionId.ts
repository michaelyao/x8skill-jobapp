/**
 * Company requisition IDs — the employer's OWN id for a job (Workday "R73630",
 * RTX "01865635", Samsara "JR11987").
 *
 * Why this matters: the ATS posting id identifies a *listing*, not a *job*. The same
 * opening is often posted through more than one channel (a Workday board and a
 * Greenhouse mirror, an aggregator relisting), each with its own id — so ATS ids alone
 * let us apply to one job twice. The requisition id is the thing that stays constant.
 *
 * It is not always exposed: measured across live postings, Workday nearly always shows
 * it, Greenhouse sometimes, Lever/Ashby not at all. So this is a best-effort upgrade to
 * identity, never a requirement — callers must still work when it returns undefined.
 */

/** Explicitly labelled ids: "Job ID: R73630", "Requisition Number 01865635", "Req #1234". */
const LABELLED: RegExp[] = [
  /\b(?:job|requisition|posting|vacancy|position|reference)\s*(?:id|number|no\.?|code|#)\s*[:#-]?\s*([A-Z0-9][A-Z0-9_-]{2,19})\b/i,
  /\breq(?:uisition)?\s*[:#]\s*([A-Z0-9][A-Z0-9_-]{2,19})\b/i,
  /\bjob\s*req(?:uisition)?\s*(?:id)?\s*[:#-]?\s*([A-Z0-9][A-Z0-9_-]{2,19})\b/i,
];

/**
 * Unlabelled but unmistakable shapes: a letter prefix plus digits (R265684, JR0123456,
 * REQ-1234). Bare all-digit runs are deliberately NOT matched here — without a label
 * they collide with years, salaries and counts. A labelled match may be all digits.
 */
const PREFIXED = /\b((?:JR|R|REQ|REQID|RQ)-?\d{4,10})\b/i;

/** Reject captures that are obviously something else even though they matched. */
function isPlausible(candidate: string): boolean {
  const v = candidate.trim();
  if (v.length < 3 || v.length > 20) return false;
  // A bare year or year range ("2026", "20262027") is never a requisition id.
  if (/^(19|20)\d{2}$/.test(v)) return false;
  // Must contain a digit — pure words ("Description", "Summary") are labels, not ids.
  if (!/\d/.test(v)) return false;
  // Reject common non-id words that can follow a label on a crowded page.
  if (/^(and|the|for|with|our|you|apply|posted|full|part|time)$/i.test(v)) return false;
  return true;
}

const normalizeReqId = (raw: string): string => raw.trim().toUpperCase().replace(/^[-_]+|[-_]+$/g, "");

/**
 * Pull a requisition id out of a posting URL — Workday puts it in the last path
 * segment ("…Software-Development-Internship---Summer-2027_R265684").
 */
export function reqIdFromUrl(url: string): string | undefined {
  let decoded = url;
  try {
    decoded = decodeURIComponent(url);
  } catch {
    /* keep the raw string */
  }
  // Prefer the tail of the path, where Workday appends it after an underscore.
  const path = decoded.split(/[?#]/)[0];
  const tail = path.match(/[_/-]((?:JR|R|REQ|REQID|RQ)-?\d{4,10})$/i);
  if (tail?.[1] && isPlausible(tail[1])) return normalizeReqId(tail[1]);
  const anywhere = path.match(PREFIXED);
  if (anywhere?.[1] && isPlausible(anywhere[1])) return normalizeReqId(anywhere[1]);
  return undefined;
}

/**
 * Pull a requisition id out of the visible posting text. Labelled matches win over the
 * bare prefixed shape, since a label is strong evidence and the shape alone is weaker.
 */
export function reqIdFromPageText(text: string): string | undefined {
  const flat = text.replace(/\s+/g, " ");
  for (const re of LABELLED) {
    const m = flat.match(re);
    if (m?.[1] && isPlausible(m[1])) return normalizeReqId(m[1]);
  }
  const bare = flat.match(PREFIXED);
  if (bare?.[1] && isPlausible(bare[1])) return normalizeReqId(bare[1]);
  return undefined;
}

/** URL first (cheap and available before we open anything), then the page text. */
export function findRequisitionId(url: string, pageText?: string): string | undefined {
  return reqIdFromUrl(url) ?? (pageText ? reqIdFromPageText(pageText) : undefined);
}
