/**
 * Durability cases for state writes. Run: npx tsx src/debug/atomicWriteCases.ts
 *
 * The property under test: a reader concurrent with a write sees either the old contents or
 * the new contents — never a truncated file, and never a partial JSON document.
 */
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { writeFileAtomic, writeJsonAtomic } from "../utils/atomicWrite.js";

let bad = 0;
const check = (name: string, ok: boolean, extra = "") => {
  if (!ok) bad += 1;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${extra ? `  ${extra}` : ""}`);
};

const dir = await fs.mkdtemp(path.join(os.tmpdir(), "atomic-"));
const file = path.join(dir, "state.json");

// 1. Basic write + read back.
await writeJsonAtomic(file, { a: 1 });
check("writes and reads back", JSON.parse(await fs.readFile(file, "utf8")).a === 1);

// 2. No temp files left behind.
const leftovers = (await fs.readdir(dir)).filter((f) => f.includes(".tmp-"));
check("no temp files left behind", leftovers.length === 0, leftovers.join(","));

// 3. Concurrent readers never observe a partial document. Writes alternate between a small
//    and a large payload; every read must parse and match one of the two shapes.
const small = { size: "small", items: [] as number[] };
const large = { size: "large", items: Array.from({ length: 20000 }, (_, i) => i) };
// Seed with one of the two shapes first. Reads that land before the writer starts see the
// PREVIOUS contents — which is the guarantee working, not tearing — so the file must already
// hold a shape the check accepts.
await writeJsonAtomic(file, small);
let torn = 0;
let reads = 0;
let done = false;

const writer = (async () => {
  for (let i = 0; i < 60; i += 1) {
    await writeJsonAtomic(file, i % 2 === 0 ? small : large);
  }
})();

const reader = (async () => {
  while (!done) {
    try {
      const raw = await fs.readFile(file, "utf8");
      reads += 1;
      const parsed = JSON.parse(raw);
      const consistent =
        (parsed.size === "small" && parsed.items.length === 0) ||
        (parsed.size === "large" && parsed.items.length === 20000);
      if (!consistent) torn += 1;
    } catch {
      // A failed parse or a missing file would both be tearing.
      torn += 1;
    }
  }
})();

await writer;
done = true;
await reader;
check(`${reads} concurrent reads saw no torn file`, torn === 0, `torn=${torn}`);

// 4. Overwriting a much larger file with a smaller one leaves no trailing garbage.
await writeJsonAtomic(file, large);
await writeJsonAtomic(file, small);
const after = await fs.readFile(file, "utf8");
check("shrinking write leaves no trailing bytes", JSON.parse(after).items.length === 0 && !after.includes("19999"));

// 5. Plain text path works too (job-description.txt style).
const textFile = path.join(dir, "note.txt");
await writeFileAtomic(textFile, "hello\n");
check("text write works", (await fs.readFile(textFile, "utf8")) === "hello\n");

await fs.rm(dir, { recursive: true, force: true });
console.log(bad === 0 ? "\nall atomic-write cases pass" : `\n${bad} case(s) FAILED`);
process.exitCode = bad === 0 ? 0 : 1;
