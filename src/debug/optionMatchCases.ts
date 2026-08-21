/**
 * Cases for option-label matching.
 *
 * The bug these exist for: General Matter (Greenhouse) offered "Bachelor’s Degree" with a
 * typographic apostrophe while the model answered "Bachelor's Degree" with a straight one. The
 * option was on screen, in a list we had already read, and all four match strategies missed it.
 * The field then burned its full 90s deadline and was reported as "would not take it".
 *
 * Run: npx tsx src/debug/optionMatchCases.ts
 */
import { normaliseOption } from "../agent/drivers/base.js";

let failures = 0;
const same = (a: string, b: string, name: string): void => {
  const ok = normaliseOption(a) === normaliseOption(b);
  if (ok) console.log(`  ✓ ${name}`);
  else {
    failures += 1;
    console.log(`  ✗ ${name}\n      ${JSON.stringify(normaliseOption(a))} !== ${JSON.stringify(normaliseOption(b))}`);
  }
};
const differ = (a: string, b: string, name: string): void => {
  const ok = normaliseOption(a) !== normaliseOption(b);
  if (ok) console.log(`  ✓ ${name}`);
  else {
    failures += 1;
    console.log(`  ✗ ${name} — collapsed two DIFFERENT options to the same string`);
  }
};

console.log("\nMust match — the same option, typed differently");
same("Bachelor's Degree", "Bachelor’s Degree", "straight vs typographic apostrophe (the live bug)");
same("Associate's Degree", "Associate’s Degree", "the option above it in the same list");
same("Master's Degree", "MASTER’S DEGREE", "apostrophe + case");
same("Bachelor's  Degree", "Bachelor’s Degree", "collapsed double space");
same("Full-time", "Full‑time", "hyphen vs non-breaking hyphen");
same("2026 - 2027", "2026 – 2027", "hyphen vs en dash");
same("United States", "United States", "non-breaking space");
same(" Yes ", "Yes", "surrounding whitespace");
same('He said "yes"', 'He said “yes”', "curly double quotes");

console.log("\nMust STAY different — normalising must not merge real options");
differ("Bachelor's Degree", "Master's Degree", "two real degrees");
differ("Associate's Degree", "Bachelor's Degree", "adjacent options in the live list");
differ("Yes", "No", "yes vs no");
differ("Full-time", "Part-time", "full vs part time");
differ("2026", "2027", "adjacent years");
differ("Computer Science", "Computer Engineering", "adjacent disciplines");

console.log(failures === 0 ? `\n✓ all cases pass\n` : `\n✗ ${failures} case(s) failed\n`);
process.exit(failures === 0 ? 0 : 1);
