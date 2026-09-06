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
import { findBrokenEscapes, findNonInvokedScripts } from "../core/evaluateEscapes.js";

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
console.log("\nand no page script may be a bare arrow instead of an invoked IIFE");
check(`an inline (el) => template handed to evaluate is reported`,
  findNonInvokedScripts("control.evaluate(`(el) => el.tagName`)").length === 1);
check(`a named const holding (el) => and passed to evaluate is reported`,
  findNonInvokedScripts("const D = `(el) => el.tagName`;\ncontrol.evaluate(D);").length === 1);
check(`an invoked IIFE is correct and is NOT reported`,
  findNonInvokedScripts("page.evaluate(`(() => document.title)()`)").length === 0);
check(`a named IIFE is NOT reported`,
  findNonInvokedScripts("const R = `(() => 1)()`;\nroot.evaluate(R);").length === 0);
// A template that is never given to evaluate is ordinary text, whatever it looks like.
check(`a bare arrow template nobody evaluates is left alone`,
  findNonInvokedScripts("const T = `(el) => el`;\nconsole.log(T);").length === 0);

const bare: string[] = [];
// These two hold the broken shape ON PURPOSE — one describes it, the other tests for it.
const DESCRIBES_THE_PATTERN = ["src/core/evaluateEscapes.ts", "src/debug/evaluateEscapeCases.ts"];
for (const f of files) {
  if (DESCRIBES_THE_PATTERN.some((d) => f.endsWith(d) || f === d)) continue;
  for (const h of findNonInvokedScripts(fs.readFileSync(f, "utf8"))) {
    bare.push(`${f}:${h.line} ${h.name} — ${h.text}`);
  }
}
check(`no page script in the tree is a non-invoked arrow`, bare.length === 0, bare.length ? bare : undefined);
if (bare.length) for (const b of bare) console.log(`      ${b}`);

check(`${files.length} files scanned, none carries a single-escaped regex token`,
  offenders.length === 0, offenders.length ? offenders : undefined);
if (offenders.length) for (const o of offenders) console.log(`      ${o}`);

console.log(`\n${fail === 0 ? "✓" : "✗"} ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
