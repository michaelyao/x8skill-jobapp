import type { ScreenBlock } from "./screenBlocks.js";

/**
 * A TALL PAGE HAS TO BE READ IN SLICES.
 *
 * Measured against the live service on 2026-09-02, with paddleocr unreachable so everything falls
 * to the gemini vision fallback:
 *
 *     1440 x  1761  (1:1.2)   read in  9-16s
 *     1440 x  3080  (1:2.1)   FAILS after 301s
 *     1440 x 12206  (1:8.5)   FAILS after 301s
 *
 * It is the PIXEL HEIGHT, not the byte size — the 3080px failure is a 160KB file. So a full-page
 * capture of a Workday form, which is what the submit path photographs, could never be read, while
 * the per-page check passed whenever the page happened to be short. Every long application was
 * refused, three attempts each, and handed back to the candidate to approve again.
 *
 * Slicing is not a workaround for one engine's limit: a request that returns in 15 seconds instead
 * of timing out at 300 is better for every engine, and paddleocr's own boxes come back per-tile
 * just the same.
 */
/**
 * Between the tallest capture MEASURED GOOD (1761px, read in 9-16s) and the shortest measured BAD
 * (3080px, dead at 301s). Not a round number for its own sake: slicing a page we know reads fine
 * would add a seam, and a seam is where a field gets cut in half, for no gain.
 */
export const MAX_TILE_HEIGHT = 2000;

/** Overlap, so a field cut in half by a tile edge is whole in one of them. */
export const TILE_OVERLAP = 120;

export interface Tile {
  /** Where this tile starts in the FULL page's coordinate space. */
  offsetY: number;
  height: number;
}

/** How to slice a page of this height. One tile when it already fits. */
export function planTiles(pageHeight: number, maxHeight = MAX_TILE_HEIGHT): Tile[] {
  if (pageHeight <= maxHeight) return [{ offsetY: 0, height: pageHeight }];
  const tiles: Tile[] = [];
  let y = 0;
  while (y < pageHeight) {
    const height = Math.min(maxHeight, pageHeight - y);
    tiles.push({ offsetY: y, height });
    if (y + height >= pageHeight) break;
    y += height - TILE_OVERLAP;
  }
  return tiles;
}

/**
 * Put the tiles' blocks back into ONE coordinate space.
 *
 * Every box a tile reports is relative to that tile, so a value on the third slice would pair with
 * a label a thousand pixels away if the offset were not added back. The overlap then means the
 * same block can appear twice, once from each side of a seam; a block whose text and position
 * match one already kept is dropped, because two copies of a value read as two fields.
 */
export function mergeTileBlocks(
  perTile: Array<{ tile: Tile; blocks: ScreenBlock[] }>,
): ScreenBlock[] {
  const out: ScreenBlock[] = [];
  const seen = new Set<string>();
  let order = 0;
  for (const { tile, blocks } of perTile) {
    for (const b of blocks) {
      const box = b.box
        ? ([b.box[0], b.box[1] + tile.offsetY, b.box[2], b.box[3] + tile.offsetY] as [
            number,
            number,
            number,
            number,
          ])
        : undefined;
      // Round the y to absorb a pixel or two of disagreement between two reads of the same seam.
      const key = `${(b.text ?? "").trim()}@${box ? Math.round(box[1] / 8) : "?"}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ ...b, box, order: order++ });
    }
  }
  return out.sort((a, b) => (a.box?.[1] ?? 0) - (b.box?.[1] ?? 0));
}
