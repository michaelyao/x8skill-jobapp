import { mergeTileBlocks, planTiles, MAX_TILE_HEIGHT, TILE_OVERLAP } from "../knowledge/tiles.js";
import type { ScreenBlock } from "../knowledge/screenBlocks.js";

/** Cases for slicing a tall capture and putting it back together.  npm run test:tiles */
let pass = 0, fail = 0;
const check = (n: string, c: boolean, got?: unknown) => {
  if (c) { pass++; console.log(`  ✓ ${n}`); } else { fail++; console.log(`  ✗ ${n}${got===undefined?"":` — got ${JSON.stringify(got)}`}`); }
};

console.log("planning the slices");
// 1761px is the tallest capture measured working, so it must NOT be sliced.
check(`the tallest known-good page is ONE tile, untouched`, JSON.stringify(planTiles(1761)) === JSON.stringify([{offsetY:0,height:1761}]), planTiles(1761));
check(`exactly the limit is still one tile`, planTiles(MAX_TILE_HEIGHT).length === 1);
const tall = planTiles(12206);
check(`a 12206px page is sliced`, tall.length > 1, tall.length);
check(`no tile exceeds the limit`, tall.every((t) => t.height <= MAX_TILE_HEIGHT), tall.map(t=>t.height));
check(`the slices cover the whole page`, tall[tall.length-1].offsetY + tall[tall.length-1].height === 12206, tall[tall.length-1]);
check(`consecutive slices overlap`, tall[1].offsetY === tall[0].height - TILE_OVERLAP, [tall[0], tall[1]]);
check(`the 3080px case that failed is two tiles`, planTiles(3080).length === 2, planTiles(3080));

console.log("\nputting the blocks back in one coordinate space");
const b = (text: string, y: number): ScreenBlock => ({ label: "text", text, box: [100, y, 500, y + 30], order: 0 });
const merged = mergeTileBlocks([
  { tile: { offsetY: 0, height: 1700 }, blocks: [b("First Name", 200), b("Nathan", 240)] },
  { tile: { offsetY: 1580, height: 1700 }, blocks: [b("Summary", 300), b("CS student at CMU", 340)] },
]);
check(`a second-tile box is shifted by its offset`,
  merged.find((x) => x.text === "Summary")?.box?.[1] === 1880,
  merged.find((x) => x.text === "Summary")?.box);
check(`a first-tile box is unchanged`, merged.find((x) => x.text === "Nathan")?.box?.[1] === 240);
check(`blocks come back in page order`, merged.map((x) => x.text).join("|") === "First Name|Nathan|Summary|CS student at CMU", merged.map(x=>x.text));

// The seam: the same block read from both sides must not become two fields.
const seam = mergeTileBlocks([
  { tile: { offsetY: 0, height: 1700 }, blocks: [b("Postal Code", 1650)] },
  { tile: { offsetY: 1580, height: 1700 }, blocks: [b("Postal Code", 70)] },
]);
check(`a block seen in both tiles is kept once`, seam.length === 1, seam.map(x=>[x.text,x.box?.[1]]));
// ...but a genuinely repeated label elsewhere on the page is NOT a duplicate.
const twice = mergeTileBlocks([
  { tile: { offsetY: 0, height: 1700 }, blocks: [b("Role Description", 300)] },
  { tile: { offsetY: 1580, height: 1700 }, blocks: [b("Role Description", 900)] },
]);
check(`the same label far apart stays twice`, twice.length === 2, twice.map(x=>[x.text,x.box?.[1]]));

console.log(`\n${fail ? "✗" : "✓"} ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
