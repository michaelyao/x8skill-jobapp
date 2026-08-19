import fs from "node:fs/promises";
import path from "node:path";
import { ROUNDS_DIR, listRounds } from "../knowledge/rounds.js";

/**
 * Delete recorded copies of an application.
 *
 * Rounds are append-only ON PURPOSE — they are the evidence that settles "did the form change?",
 * and evidence you can quietly edit is not evidence. So this refuses to run without --write, names
 * every file before removing it, and defaults to touching only RECONSTRUCTED copies: those were
 * rebuilt from the approval queue rather than observed, so their field list is inferred and a diff
 * against them is partial. Removing an observed copy needs --observed as well, said out loud.
 *
 *   npx tsx src/debug/pruneRounds.ts SBXFMD              # show what would go
 *   npx tsx src/debug/pruneRounds.ts SBXFMD --write
 *   npx tsx src/debug/pruneRounds.ts SBXFMD --write --observed
 */

const args = process.argv.slice(2);
const write = args.includes("--write");
const alsoObserved = args.includes("--observed");
const codes = args.filter((a) => !a.startsWith("--")).map((a) => a.toUpperCase());

if (!codes.length) {
  console.error("usage: npx tsx src/debug/pruneRounds.ts <CODE> [CODE…] [--write] [--observed]");
  process.exit(1);
}

for (const code of codes) {
  const rounds = await listRounds(code);
  if (!rounds.length) {
    console.log(`${code}: no recorded copies`);
    continue;
  }
  const doomed = rounds.filter((r) => alsoObserved || r.reconstructed);
  const keeping = rounds.length - doomed.length;
  console.log(`${code}: ${rounds.length} copies — ${doomed.length} to remove, ${keeping} kept`);

  const dir = path.join(ROUNDS_DIR, code);
  const names = (await fs.readdir(dir).catch(() => [])).filter((n) => n.endsWith(".json"));
  for (const round of doomed) {
    // Match the file by the timestamp it was written under, which is how saveRound names them.
    const stamp = round.at.replace(/[:.]/g, "-");
    const name = names.find((n) => n.startsWith(stamp));
    if (!name) {
      console.log(`   ? could not find the file for ${round.at} — left alone`);
      continue;
    }
    console.log(
      `   ${write ? "removing" : "would remove"} ${name}  [${round.reconstructed ? "reconstructed" : "OBSERVED"}, ${round.fields.length} fields, ${round.answers.length} answers]`,
    );
    if (write) await fs.rm(path.join(dir, name), { force: true });
  }
  if (!write) console.log("   (nothing changed — pass --write)");
}
