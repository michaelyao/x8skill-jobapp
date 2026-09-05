import fs from "node:fs/promises";
import type { CDPSession, Page } from "playwright";
import type { Tile } from "../knowledge/tiles.js";

/**
 * PHOTOGRAPHING A FORM THAT IS NOT IN THE PAGE.
 *
 * Several employers host their own careers page and inject the ATS form into it as a cross-origin
 * iframe — Greenhouse's `grnhse_iframe`, reached through a `?gh_jid=` link. Chromium renders such
 * a frame out of process and paints it ONLY where the viewport is, so `fullPage` leaves it white.
 *
 * The candidate found this by reading his own queue. QCJHTQ (Zipline) and XHWWCQ (Stripe) both
 * showed him a review screenshot with the employer's header, the job title, the footer — and
 * nothing in the middle, where the application he was being asked to approve should have been.
 * QDLZFL (C3.ai) is 1440x9423 with a 5000px hole. Stripe's apply step is the clean demonstration:
 * 46 form controls inside the frame, ZERO in the top document.
 *
 * THE FIX IS TO MAKE THE WHOLE PAGE BE THE VIEWPORT. `Emulation.setDeviceMetricsOverride` over CDP
 * resizes the viewport to the full document height; everything is then on screen by definition, so
 * the frame paints, and a plain capture (NOT captureBeyondViewport, which is the fullPage path that
 * fails) returns all of it in one image. No scrolling, no stitching, no image library.
 *
 * Measured on Zipline, same page, same moment:
 *
 *   page.screenshot fullPage       1440x6835  ink 0.078   form missing
 *   device-metrics override        1440x6839  ink 0.205   whole form, every field to Submit
 *
 * and — the part that matters, because the worker drives real headed Chrome — headed and headless
 * agree to within 0.0004. Two approaches that looked right were tried first and are NOT what this
 * does: shooting the slices back to back (they still disagree with each other, the frame paints
 * wherever the viewport is), and an element screenshot of the frame's own body (it worked once,
 * then timed out at 30s on the same page in both headed and headless — not something a review
 * screenshot can depend on).
 */

/**
 * Chromium will not paint an unbounded surface, and a page taller than this is a page where
 * something else has gone wrong. Capture what fits and say so rather than failing outright.
 */
const MAX_TALL_PX = 12_000;

async function documentSize(page: Page): Promise<{ width: number; height: number }> {
  try {
    const size = (await page.evaluate(
      `(() => ({
        width: document.documentElement.clientWidth || window.innerWidth || 1440,
        height: Math.max(
          document.documentElement.scrollHeight,
          document.body ? document.body.scrollHeight : 0,
        ),
      }))()`,
    )) as { width: number; height: number };
    return { width: Math.round(size.width) || 1440, height: Math.round(size.height) || 0 };
  } catch {
    return { width: 1440, height: 0 };
  }
}

/**
 * Make the viewport as tall as the document, run `body`, then put it back — always, including when
 * the body throws. Leaving a 9000px viewport behind would break every click that follows.
 */
async function withTallViewport<T>(
  page: Page,
  size: { width: number; height: number },
  body: (cdp: CDPSession, height: number) => Promise<T>,
): Promise<T | null> {
  if (size.height <= 0) return null;
  const height = Math.min(size.height, MAX_TALL_PX);
  /**
   * Playwright's own `viewport` is itself a device-metrics override, so CLEARING ours clears
   * theirs too: measured, the page came back at the real window height of 884 instead of the 1000
   * the run was configured for. Put the original metrics back explicitly rather than clearing.
   */
  const original = page.viewportSize();
  let cdp: CDPSession | null = null;
  try {
    cdp = await page.context().newCDPSession(page);
    await cdp.send("Emulation.setDeviceMetricsOverride", {
      width: size.width,
      height,
      deviceScaleFactor: 1,
      mobile: false,
    });
    // The frame has to be given a moment to paint at its new size before the shutter opens.
    await page.waitForTimeout(800);
    return await body(cdp, height);
  } catch {
    return null;
  } finally {
    if (cdp) {
      if (original) {
        await cdp
          .send("Emulation.setDeviceMetricsOverride", {
            width: original.width,
            height: original.height,
            deviceScaleFactor: 1,
            mobile: false,
          })
          .catch(() => undefined);
      } else {
        await cdp.send("Emulation.clearDeviceMetricsOverride").catch(() => undefined);
      }
      await cdp.detach().catch(() => undefined);
    }
  }
}

/**
 * The picture that will be reviewed. Returns how it was taken, so the log can say when a page
 * needed the tall capture — that is the signal that this employer embeds its form.
 *
 * Falls back to `fullPage` whenever CDP is unavailable or the override fails: a capture that
 * misses an embedded form is poor, and no capture at all is worse.
 */
export async function captureFormShot(page: Page, file: string): Promise<"tall" | "page"> {
  const size = await documentSize(page);
  const done = await withTallViewport(page, size, async (cdp) => {
    const res = (await cdp.send("Page.captureScreenshot", {
      format: "png",
      captureBeyondViewport: false,
    })) as { data: string };
    await fs.writeFile(file, Buffer.from(res.data, "base64"));
    return true;
  });
  if (done) return "tall";
  await page.screenshot({ path: file, fullPage: true }).catch(() => undefined);
  return "page";
}

/**
 * The same capture, cut into the slices the reader wants — one clip per tile, all taken with the
 * whole document on screen, so a slice covering an embedded form holds the form rather than white.
 *
 * Returns one file per tile, null where a tile could not be taken, and null ENTIRELY when the tall
 * capture is not available at all — the caller then falls back to its own tiling.
 */
export async function captureTallTiles(
  page: Page,
  tiles: Tile[],
  fileFor: (index: number) => string,
): Promise<Array<string | null> | null> {
  const size = await documentSize(page);
  return withTallViewport(page, size, async (cdp, height) => {
    const out: Array<string | null> = [];
    for (const [i, tile] of tiles.entries()) {
      const top = Math.min(tile.offsetY, Math.max(0, height - 1));
      const clipHeight = Math.max(1, Math.min(tile.height, height - top));
      try {
        const res = (await cdp.send("Page.captureScreenshot", {
          format: "png",
          captureBeyondViewport: false,
          clip: { x: 0, y: top, width: size.width, height: clipHeight, scale: 1 },
        })) as { data: string };
        const file = fileFor(i);
        await fs.writeFile(file, Buffer.from(res.data, "base64"));
        out.push(file);
      } catch {
        out.push(null);
      }
    }
    return out;
  });
}
