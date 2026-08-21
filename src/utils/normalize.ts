import crypto from "node:crypto";

export function normalizeWhitespace(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

export function normalizeQuestion(value: string): string {
  return normalizeWhitespace(value)
    .toLowerCase()
    // Strip a leading list marker. Workday numbers its custom questions ("5. If selected for
    // an internship position, are you willing…"), so an answer recorded from a review — where
    // the number is part of the label — did not match the same question elsewhere, or even the
    // same question after the form renumbered it.
    .replace(/^\s*(?:q\s*)?\d{1,2}\s*[.)\-:]\s*/i, "")
    .replace(/[“”"'`]/g, "")
    .replace(/\([^)]*\)/g, " ")
    .replace(/[_*:;?!.]+/g, " ")
    .replace(/\b[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}\b/g, " ")
    .replace(/\b(company|internship|role|position|job)\b/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function normalizeCompany(value: string): string {
  return normalizeWhitespace(value).toLowerCase();
}

/**
 * Workday puts a locale in the path: `<tenant>.wdN.myworkdayjobs.com/<locale>/<site>/job/...`.
 *
 * The job trackers capture whatever locale the poster used. Measured on the live list: 7 of 49
 * Workday URLs were `/fr-CA/`, all of them RTX, and every RTX application failed at `0 field(s),
 * submitReady=false / No next control` — because the page was in FRENCH. The Apply button reads
 * "Postuler", which the APPLY regex does not match, so the driver never even opened the form.
 * (Filling it in French would be worse: every field label would miss the answer store too.)
 *
 * So navigate in English. Also used by normalizeUrl, so the same posting in two locales is ONE
 * job — without that, /fr-CA/ and /en-US/ of the same requisition dedupe as different listings
 * and could both be applied to.
 */
export function workdayEnglishUrl(url: string): string {
  try {
    const parsed = new URL(url);
    if (!/\.myworkdayjobs\.com$/i.test(parsed.hostname)) return url;
    // Only a leading /xx-YY/ segment is a locale. A path segment further in is site or job data.
    parsed.pathname = parsed.pathname.replace(/^\/[a-z]{2}-[A-Z]{2}(?=\/)/, "/en-US");
    return parsed.toString();
  } catch {
    return url;
  }
}

export function normalizeUrl(url: string): string {
  try {
    const parsed = new URL(url);
    parsed.hash = "";
    const keys = [...parsed.searchParams.keys()];
    for (const key of keys) {
      if (key.startsWith("utm_") || key === "ref" || key === "gh_src") {
        parsed.searchParams.delete(key);
      }
    }
    parsed.pathname = parsed.pathname.replace(/\/+$/, "");
    // Fold the Workday locale, so the same posting in two languages is one job. See
    // workdayEnglishUrl: the live list carried both /fr-CA/ and /en-US/ RTX URLs.
    return workdayEnglishUrl(parsed.toString());
  } catch {
    return url.trim();
  }
}

export function stableHash(input: string): string {
  return crypto.createHash("sha1").update(input).digest("hex").slice(0, 12);
}

export function slugify(input: string): string {
  return normalizeWhitespace(input)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

export function isLikelyUsLocation(location: string): boolean {
  const text = normalizeWhitespace(location).toLowerCase();
  if (!text) {
    return false;
  }
  if (/\b(canada|toronto|vancouver|montreal|ottawa|emea|india|mexico|europe|singapore|london)\b/.test(text)) {
    return false;
  }
  if (/\b(united states|usa|u\.s\.|remote\b|nyc|bay area)\b/.test(text)) {
    return true;
  }
  if (/\b[a-z .'-]+,\s*(al|ak|az|ar|ca|co|ct|dc|de|fl|ga|hi|ia|id|il|in|ks|ky|la|ma|md|me|mi|mn|mo|ms|mt|nc|nd|ne|nh|nj|nm|nv|ny|oh|ok|or|pa|ri|sc|sd|tn|tx|ut|va|vt|wa|wi|wv|wy)\b/.test(text)) {
    return true;
  }
  return false;
}

