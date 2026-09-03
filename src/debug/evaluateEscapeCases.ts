/**
 * `npm run test:escapes` — no page script may carry a single-escaped regex token.
 *
 * See evaluateEscapes.ts for what this costs when it slips: `/\s+/g` inside an evaluate template
 * reaches the page as `/s+/g` and replaces every letter "s" with a space, which is how 652 recorded
 * Workday fields ended up labelled "tart Date" and "fir t Year Attended".
 *
 * Half of these cases are about the SCANNER, not the source tree. The first version of it skipped
 * every backslash escape while walking the template — including the lone ones it was written to
 * find — and so reported a clean bill of health for a file that was actively corrupting labels. A
 * checker that cannot fail is worse than no checker, so the fixtures below assert both directions.
 */
import fs from "node:fs";
import path from "node:path";
import { findBrokenEscapes } from "../core/evaluateEscapes.js";

let pass = 0;
let fail = 0;
const check = (name: string, cond: boolean, got?: unknown) => {
  if (cond) { pass += 1; console.log(`  ✓ ${name}`); }
  else { fail += 1; console.log(`  ✗ ${name}${got === undefined ? "" : ` — got ${JSON.stringify(got)}`}`); }
};

console.log("the scanner itself");
const B = String.fromCharCode(92); // one backslash, so these fixtures are unambiguous
check(`a lone ${B}s in an evaluate template is reported`,
  findBrokenEscapes(`page.evaluate(\`(() => t.replace(/${B}s+/g, " "))()\`)`).length === 1);
check(`a doubled ${B}${B}s is correct and is NOT reported`,
  findBrokenEscapes(`page.evaluate(\`(() => t.replace(/${B}${B}s+/g, " "))()\`)`).length === 0);
check(`a lone ${B}b is reported (it is a BACKSPACE, not a word boundary)`,
  findBrokenEscapes(`page.evaluate(\`(() => /_bot${B}b/.test(n))()\`)`).length === 1);
check(`a lone ${B}d is reported`,
  findBrokenEscapes(`page.evaluate(\`(() => /${B}d+/.test(n))()\`)`).length === 1);
check(`a template ASSIGNED to a const is scanned too`,
  findBrokenEscapes(`const READ = \`(() => t.replace(/${B}s+/g, " "))()\`;\nroot.evaluate(READ);`).length === 1);
check(`ordinary module code is left alone`,
  findBrokenEscapes(`export const NEXT = /^(next|save)${B}b/i;\nconst x = "a".replace(/${B}s+/g, "");`).length === 0);
check(`code inside a \${…} interpolation is ordinary code`,
  findBrokenEscapes("page.evaluate(`(() => q('" + "${" + `sel.replace(/${B}s+/g, "")` + "}" + "'))()`)").length === 0);
check(`the reported line number points at the offending line`,
  findBrokenEscapes(`const S = \`(() => {\n  const a = 1;\n  return t.replace(/${B}s+/g, " ");\n})()\`;`)[0]?.line === 3);

console.log("\nevery page script in the tree");
const files: string[] = [];
const walk = (dir: string) => {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) { if (e.name !== "node_modules") walk(p); }
    else if (e.name.endsWith(".ts") || e.name.endsWith(".tsx")) files.push(p);
  }
};
walk("src");
for (const d of ["web/app", "web/components", "web/lib"]) if (fs.existsSync(d)) walk(d);

const offenders: string[] = [];
for (const f of files) {
  for (const h of findBrokenEscapes(fs.readFileSync(f, "utf8"))) {
    offenders.push(`${f}:${h.line} ${h.token} — ${h.text}`);
  }
}
check(`${files.length} files scanned, none carries a single-escaped regex token`,
  offenders.length === 0, offenders.length ? offenders : undefined);
if (offenders.length) for (const o of offenders) console.log(`      ${o}`);

console.log(`\n${fail === 0 ? "✓" : "✗"} ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
