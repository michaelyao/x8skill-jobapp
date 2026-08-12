import crypto from "node:crypto";

export function normalizeWhitespace(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

export function normalizeQuestion(value: string): string {
  return normalizeWhitespace(value)
    .toLowerCase()
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
    return parsed.toString();
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

