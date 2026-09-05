import type { ElementHandle, Page } from "playwright";

/**
 * PHOTOGRAPHING A FORM THAT IS NOT IN THE PAGE.
 *
 * Several employers host their own careers page and inject the ATS form into it as a cross-origin
 * iframe — Greenhouse's `grnhse_iframe`, reached through a `?gh_jid=` link. Chromium renders such a
 * frame out of process, so a full-page screenshot leaves it WHITE: it paints only where the
 * viewport happens to be when the shutter opens.
 *
 * The candidate found this by reading his own queue. QCJHTQ (Zipline) and XHWWCQ (Stripe) both
 * showed him a review screenshot with the employer's header, the job title, the footer — and
 * nothing at all in the middle, where the application he was being asked to approve should have
 * been. QDLZFL (C3.ai) is 1440x9423 with a 5000px hole in it.
 *
 * A frame renders perfectly well in its OWN renderer, so the answer is to photograph the frame
 * rather than the page around it: one element screenshot of the frame's body returns the whole
 * form, top to bottom. Measured against Zipline: 792x5449, every field from First Name to Submit
 * application, in a single capture. No scrolling, no stitching, no image library.
 */

/**
 * Frames that are never the application form. Screenshotting one of these does not fail quickly —
 * it hangs until the timeout, 30 seconds each, and there are usually several on a careers page.
 */
const UTILITY_FRAME = /recaptcha|hcaptcha|googleapis|googletagmanager|google-analytics|doubleclick|youtube|vimeo|^about:blank$|^$/i;

/**
 * The body of the frame holding the form, or null when the form is in the top document — which is
 * every ATS we drive directly, and where a full-page capture is already correct.
 *
 * Chosen by area, but only among frames that actually LOOK like a form. Size alone would happily
 * pick an embedded video or map and hand back a review screenshot of the wrong thing entirely.
 */
export async function formFrameBody(page: Page): Promise<ElementHandle<HTMLElement | SVGElement> | null> {
  let best: ElementHandle<HTMLElement | SVGElement> | null = null;
  let bestArea = 0;
  for (const frame of page.frames()) {
    if (frame === page.mainFrame()) continue;
    if (UTILITY_FRAME.test(frame.url())) continue;
    try {
      const controls = await frame.$$("input, textarea, select");
      if (controls.length < 2) continue;
      const body = await frame.$("body");
      if (!body) continue;
      const box = await body.boundingBox();
      if (!box || box.width < 300 || box.height < 400) continue;
      const area = box.width * box.height;
      if (area > bestArea) {
        bestArea = area;
        best = body;
      }
    } catch {
      // A frame that will not answer is not the one we are looking for.
    }
  }
  return best;
}

/**
 * Take the picture that will be reviewed. Returns which way it was taken, so the log says so —
 * "the form is in an embedded frame" is the kind of thing worth seeing next to a screenshot path.
 *
 * Falls back to the full page whenever there is no framed form, and also when the frame refuses to
 * be photographed: a picture of the page around the form is poor, but no picture at all is worse.
 */
export async function captureFormShot(page: Page, file: string): Promise<"page" | "frame"> {
  const body = await formFrameBody(page).catch(() => null);
  if (body) {
    try {
      await body.screenshot({ path: file, timeout: 30_000 });
      return "frame";
    } catch {
      // fall through to the page capture
    }
  }
  await page.screenshot({ path: file, fullPage: true }).catch(() => undefined);
  return "page";
}
