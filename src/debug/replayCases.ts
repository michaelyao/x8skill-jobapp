/**
 * Replay-matching cases. Run: npx tsx src/debug/replayCases.ts
 *
 * The one that matters: a Workday experience page repeats "Company*" per employment block.
 * One stored answer must NOT be written into every block.
 */
import { ReplayAgent } from "../agent/replayAgent.js";
import type { FieldSpec, FilledAnswer, PageSnapshot } from "../agent/types.js";

let bad = 0;
const check = (name: string, ok: boolean, extra = "") => {
  if (!ok) bad += 1;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${extra ? `  ${extra}` : ""}`);
};
const a = (label: string, value: string): FilledAnswer => ({ label, type: "text", value });
const f = (label: string, required = true): FieldSpec => ({ key: `${label}#${Math.random()}`, label, type: "text", required });
const snap = (fields: FieldSpec[]): PageSnapshot => ({ url: "x", submitReady: false, nextAvailable: true, fields });

// --- the SBXFMD failure -------------------------------------------------------
// Approved ONE experience block; the page (after repeated resume autofills) shows THREE.
{
  const agent = new ReplayAgent([
    a("Job Title*", "Software Engineering Intern"),
    a("Company*", "Bay Area Rapid Transit (BART)"),
    a("From* — Month", "Jun"),
    a("From* — To* — Month", "Aug"),
  ]);
  const out = await agent.decide(
    snap([f("Job Title*"), f("Company*"), f("From* — Month"), f("From* — To* — Month"),
          f("Job Title*"), f("Company*"), f("From* — Month"), f("From* — To* — Month"),
          f("Job Title*"), f("Company*"), f("From* — Month"), f("From* — To* — Month")]),
    {} as never,
  );
  check("block 1 gets the approved values", out[1].value === "Bay Area Rapid Transit (BART)");
  check("block 2 is NOT given block 1's employer", out[5].value === "" && out[5].needsHuman === true, `got ${JSON.stringify(out[5].value)}`);
  check("block 3 is NOT given block 1's employer", out[9].value === "" && out[9].needsHuman === true);
  check("surplus blocks are reported", agent.surplusOccurrences.length === 8, `${agent.surplusOccurrences.length}`);
}

// --- multiple approved blocks replay in order ---------------------------------
{
  const agent = new ReplayAgent([
    a("Company*", "BART"), a("From* — Year", "2023"),
    a("Company*", "Amazon"), a("From* — Year", "2026"),
  ]);
  const out = await agent.decide(snap([f("Company*"), f("From* — Year"), f("Company*"), f("From* — Year")]), {} as never);
  check("first block → first answer", out[0].value === "BART" && out[1].value === "2023");
  check("second block → second answer, in order", out[2].value === "Amazon" && out[3].value === "2026", `${out[2].value}/${out[3].value}`);
}

// --- previously fixed behaviours must still hold ------------------------------
{
  const agent = new ReplayAgent([a("What is your current GPA? Please specify on a 4 point scale.", "3.53"), a("Gender", "Male")]);
  const out = await agent.decide(snap([f("What is your current GPA? Please specify on a 4 point scale.*"), f("Gender")]), {} as never);
  check("required-marker difference still matches", out[0].value === "3.53");
  check("exact label still matches", out[1].value === "Male");
}
{
  const agent = new ReplayAgent([a("Are you authorized to work in the US? *", "Yes")]);
  const out = await agent.decide(snap([f("Are you authorized to work for all employers? *")]), {} as never);
  check("genuinely reworded question is not guessed", out[0].needsHuman === true && out[0].value === "");
  check("and it is reported as unmatched", agent.unmatchedRequired.length === 1);
}

console.log(bad === 0 ? "\nall replay cases pass" : `\n${bad} case(s) FAILED`);
process.exitCode = bad === 0 ? 0 : 1;
