import type { Page } from "playwright";

/**
 * Fetch a Greenhouse job description from the public Boards API. Works for forms
 * embedded on a company domain (careers.<co>.com?gh_jid=...): the job id is the
 * gh_jid, and the board token is the `for=` param on the embed iframe (present
 * after the application form has opened). Returns "" if it can't be resolved.
 */
export async function fetchGreenhouseJobDescription(page: Page, applyUrl: string): Promise<string> {
  const jobId = applyUrl.match(/gh_jid=(\d+)/)?.[1] || applyUrl.match(/jobs\/(\d+)/)?.[1];
  if (!jobId) return "";
  let board = "";
  for (const frame of page.frames()) {
    const m = frame.url().match(/[?&]for=([^&]+)/);
    if (m) {
      board = m[1];
      break;
    }
  }
  if (!board) return "";
  try {
    const res = await fetch(`https://boards-api.greenhouse.io/v1/boards/${board}/jobs/${jobId}`, {
      signal: AbortSignal.timeout(15000),
    });
    if (!res.ok) return "";
    const json = (await res.json()) as { content?: string };
    const html = (json.content || "")
      .replace(/&lt;/g, "<")
      .replace(/&gt;/g, ">")
      .replace(/&amp;/g, "&")
      .replace(/&#39;/g, "'")
      .replace(/&quot;/g, '"')
      .replace(/&nbsp;/g, " ");
    return html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim().slice(0, 20000);
  } catch {
    return "";
  }
}

/**
 * Best-effort capture of the job-description text from the current page.
 * Called right after opening the apply URL, before the adapter navigates into
 * the multi-step form, so we grab the posting itself when it's available
 * (Greenhouse/Ashby show the JD on the apply page; some Workday flows do not).
 */
export async function captureJobDescription(page: Page): Promise<string> {
  try {
    // String form so tsx/esbuild doesn't inject helpers unavailable in the page.
    const text = (await page.evaluate(`() => {
      const selectors = ["[data-automation-id='jobPostingDescription']", "main", "article", "[role='main']", "#content", ".job"];
      for (const selector of selectors) {
        const el = document.querySelector(selector);
        const value = el && el.innerText && el.innerText.trim();
        if (value && value.length > 200) return value;
      }
      return (document.body && document.body.innerText || "").trim();
    }`)) as string;
    return text.replace(/\n{3,}/g, "\n\n").slice(0, 20000);
  } catch {
    return "";
  }
}
