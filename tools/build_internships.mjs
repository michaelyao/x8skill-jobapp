// Consolidates internship listings from every URL in job_sites.txt into
// internships_summer2027.csv. Re-runnable — add a new line to job_sites.txt and
// run:  node tools/build_internships.mjs
//
// Supported site types (auto-detected from the URL / content):
//   - github.com/<org>/<repo>   three shapes, auto-detected from the README's own markup:
//                                 Simplify-style HTML <table>
//                                 Vansh-style 5-column markdown pipe table
//                                 header-mapped pipe table (Company|Role|Category|Location|…)
//   - interndock.com/...guide   JS-rendered guide (needs Playwright, already a project dep)
//
// Filters to undergrad software / AI-ML roles in the US, drops PM/marketing/sales/
// quant-trading/hardware and advanced-degree (🎓 / Master's / PhD) roles.
// Orders by region (SF Bay → LA → Seattle → East Coast → Other US → Remote → TBD),
// latest-posted first within each region. Never opens/submits anything.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
// Real "now", floored to midnight UTC so a run is stable within a day. It was hardcoded to
// 2026-08-08 — the day this tool was written — which silently mis-aged everything posted after
// that: dateToDays() sees a date later than TODAY, assumes it must be last year's, and reports a
// three-day-old posting as ~360 days old. That buries the newest roles at the bottom of exactly
// the ordering (latestFirst) that exists to surface them. LIST_TODAY overrides it for tests.
const TODAY = new Date(new Date(process.env.LIST_TODAY || Date.now()).toISOString().slice(0, 10) + "T00:00:00Z");
const SITES = fs.readFileSync(path.join(ROOT, "job_sites.txt"), "utf8")
  .split("\n").map(l => l.trim()).filter(l => l && !l.startsWith("#"));

// ------------------------------------------------------------------ filters
const INCLUDE = /software|\bswe\b|full[\s-]?stack|front[\s-]?end|back[\s-]?end|web dev|mobile|ios\b|android|embedded|systems? engineer|platform|infrastructure|devops|site reliability|\bsre\b|cloud|distributed|compiler|security engineer|cyber\s?security|application (engineer|developer)|developer|programmer|machine learning|\bml\b|\bai\b|artificial intelligence|deep learning|computer vision|\bnlp\b|data engineer|data scien|research engineer|applied (scientist|ml|ai)|robotics software|game (developer|engineer|program)|graphics engineer|blockchain|smart contract|\bqa\b|test engineer|automation engineer/i;
// firmware is NOT a suitable role for Nathan — exclude it (see memory job-role-preferences).
const EXCLUDE = /\bfirmware\b|product manager|product management|program manager|\bpm\b|marketing|\bsales\b|business (analyst|develop)|recruit|talent|people ops|\bhr\b|\bux\b|ui\/ux|ux\/ui|\bdesign(er)?\b|finance|accounting|\baudit|legal|content|community|operations manager|supply chain|logistics|consult|actuar|quant(itative)? (research|trader|trading|analyst)|\btrader\b|mechanical|electrical engineer|civil engineer|chemical engineer|biomedical|\bmba\b|\bphd\b|ph\.d|doctoral|graduate program|master'?s|masters/i;

function keepTitle(t) {
  t = t.replace(/[’‘]/g, "'");
  if (/🎓/.test(t)) return false;             // advanced degree required
  return INCLUDE.test(t) && !EXCLUDE.test(t);
}

// ------------------------------------------------------------------ region
const NONUS = /canada|toronto|vancouver|montreal|ottawa|waterloo|ontario|quebec|\buk\b|united kingdom|london|england|ireland|germany|berlin|munich|france|paris|india|bangalore|bengaluru|hyderabad|pune|gurgaon|mumbai|delhi|noida|china|beijing|shanghai|shenzhen|singapore|japan|tokyo|korea|seoul|australia|sydney|israel|tel aviv|brazil|mexico city|netherlands|amsterdam|sweden|stockholm|switzerland|zurich|spain|madrid|poland|romania|taiwan|hong kong|philippines|vietnam|abu dhabi|dubai/i;
const BAY = /san francisco|\bsf\b|san jose|sunnyvale|palo alto|mountain view|santa clara|cupertino|menlo park|redwood city|foster city|san mateo|berkeley|oakland|fremont|milpitas|bay area|south san francisco|emeryville|burlingame|belmont, ca|los gatos|campbell, ca|alameda|pleasanton|san ramon|union city|hayward|brisbane, ca|san bruno|daly city|newark, ca|walnut creek|dublin, ca/i;
const LA = /los angeles|santa monica|pasadena|irvine|culver city|el segundo|long beach|burbank|torrance|anaheim|costa mesa|playa vista|marina del rey|glendale, ca|manhattan beach|thousand oaks|malibu|west hollywood|hawthorne|newport beach|santa ana|orange, ca|\bsocal\b/i;
const SEA = /seattle|bellevue|redmond|kirkland|tacoma|bothell|renton|, wa\b|\bwa$|washington state/i;
const EAST = /new york|nyc\b|\bny\b|brooklyn|manhattan|boston|cambridge, ma|, ma\b|\bma$|pittsburgh|philadelphia|, pa\b|\bpa$|washington, ?d\.?c|, dc\b|arlington|reston|mclean|herndon|chantilly|, va\b|\bva$|, md\b|\bmd$|annapolis|baltimore|atlanta|, ga\b|\bga$|miami|orlando|tampa|, fl\b|\bfl$|charlotte|raleigh|durham|, nc\b|\bnc$|, sc\b|jersey city|newark, nj|, nj\b|\bnj$|stamford|, ct\b|\bct$|providence|, ri\b|\bnh\b|new hampshire|, de\b|\bvt\b|, me\b/i;
const REMOTE = /remote/i;

function deaccent(x) { return x.normalize("NFD").replace(/[̀-ͯ]/g, ""); }
function region(loc) {
  const l = deaccent((loc || "").replace(/\s+/g, " ").trim());
  if (!l || /^(see posting|posting|n\/a|tbd|multiple)$/i.test(l)) return [8, "8 - Location TBD"];
  if (NONUS.test(l)) return null;
  if (BAY.test(l)) return [1, "1 - SF Bay Area"];
  if (LA.test(l)) return [2, "2 - LA / SoCal"];
  if (SEA.test(l)) return [3, "3 - Seattle Area"];
  if (EAST.test(l)) return [4, "4 - East Coast"];
  if (REMOTE.test(l)) return [6, "6 - Remote (US)"];
  return [5, "5 - Other US"];
}

// ------------------------------------------------------------------ helpers
function stripTags(x) {
  return x
    .replace(/<summary>\s*<strong>\s*(\d+ locations?)\s*<\/strong>\s*<\/summary>/gi, "$1: ")
    .replace(/<br\s*\/?>/gi, " / ").replace(/<\/br>/gi, " / ")
    .replace(/<[^>]+>/g, "").replace(/&amp;/g, "&").replace(/&nbsp;/g, " ")
    .replace(/\s*\/\s*/g, " / ").replace(/\s+/g, " ").trim();
}
// Status/visa badges some lists append to a company or role: 🆕 new, 🆁 rolling, ✓ H-1B history,
// 🛂 sponsorship unclear, 🇺🇸 citizens only. They are metadata, not part of the name — left in
// they end up in the CSV, in the review email, and in the dedupe key.
//
// Matched by RANGE, not by listing the ones seen today. Enumerating them is how 🆁 (U+1F181) got
// missed on the first pass: it was not in the guessed list, and the check written to verify the
// stripping reused the same guessed list, so it reported zero leaks. U+1F170-1F19A is the whole
// squared-letter block (🆁 🆕 🆓 🆖 🅰…) and U+1F1E6-1F1FF every regional-indicator flag, so a new
// badge letter upstream needs no change here.
//
// 🎓 is deliberately EXCLUDED from this: keepTitle() uses it to reject advanced-degree roles, so
// it has to survive long enough to be tested.
const BADGES = /[\u{1F170}-\u{1F19A}\u{1F1E6}-\u{1F1FF}\u{1F6C2}\u{1F525}\u2713\u2705\u23F3\uFE0F]/gu;
function clean(x) { return (x || "").replace(BADGES, "").replace(/\s+/g, " ").trim(); }
function firstHref(x) {
  const m = x.match(/href="([^"]+)"/);
  return m ? m[1].replace(/([?&])utm_source=[^&]*/g, "$1").replace(/&ref=Simplify/g, "").replace(/[?&]$/, "") : "";
}
function cleanUrl(u) { return (u || "").replace(/([?&])utm_source=[^&]*/g, "$1").replace(/[?&]$/, ""); }
/** An apply cell may be an <a href> OR a markdown [Apply](url) link. Try both. */
function anyLink(cell) {
  const html = firstHref(cell);
  if (html) return html;
  const md = (cell || "").match(/\]\(\s*(https?:\/\/[^\s)]+)\s*\)/);
  return md ? cleanUrl(md[1]) : "";
}
function ageToDays(a) {
  a = (a || "").trim();
  let m;
  if (/^\d+\s*h/i.test(a)) return 0;
  if ((m = a.match(/^(\d+)\s*d/i))) return +m[1];
  if ((m = a.match(/^(\d+)\s*w/i))) return +m[1] * 7;
  if ((m = a.match(/^(\d+)\s*mo/i))) return +m[1] * 30;
  return 999;
}
const MONTHS = { Jan:0,Feb:1,Mar:2,Apr:3,May:4,Jun:5,Jul:6,Aug:7,Sep:8,Oct:9,Nov:10,Dec:11 };
/** "Aug 24, 2026" — a stated year, so no guessing. Returns null when there is no year to use. */
function fullDateToDays(d) {
  const m = (d || "").match(/([A-Za-z]{3})[a-z]*\s+(\d{1,2}),?\s+(\d{4})/);
  if (!m || !(m[1] in MONTHS)) return null;
  return Math.round((TODAY - Date.UTC(+m[3], MONTHS[m[1]], +m[2])) / 86400000);
}
function dateToDays(d) {
  const m = (d || "").match(/([A-Za-z]{3})\s+(\d{1,2})/);
  if (!m) return 999;
  let dt = new Date(Date.UTC(2026, MONTHS[m[1]], +m[2]));
  if (dt > TODAY) dt = new Date(Date.UTC(2025, MONTHS[m[1]], +m[2]));
  return Math.round((TODAY - dt) / 86400000);
}

// ------------------------------------------------------------------ fetchers
async function fetchText(url) {
  const res = await fetch(url, { headers: { "User-Agent": "Mozilla/5.0" } });
  if (!res.ok) throw new Error(`${res.status} ${url}`);
  return res.text();
}
async function fetchGithubReadme(repoUrl) {
  const m = repoUrl.match(/github\.com\/([^/]+)\/([^/#?]+)/);
  const repo = `${m[1]}/${m[2]}`;
  for (const branch of ["dev", "main", "master"]) {
    try { return await fetchText(`https://raw.githubusercontent.com/${repo}/${branch}/README.md`); }
    catch { /* try next */ }
  }
  throw new Error(`No README found for ${repo}`);
}

// Simplify-style: HTML <table>, sections by "## <emoji> <name>". Keep SWE + AI/ML.
function parseSimplify(md, srcName) {
  const jobs = [];
  const hdr = (re) => { const i = md.search(re); return i < 0 ? md.length : i; };
  const swe = md.slice(hdr(/##[^\n]*Software Engineering/i), hdr(/##[^\n]*Product Management/i));
  const ai = md.slice(hdr(/##[^\n]*Data Science, AI/i), hdr(/##[^\n]*Quantitative/i));
  let lastCompany = "";
  for (const block of [swe, ai]) {
    for (const r of block.match(/<tr>[\s\S]*?<\/tr>/g) || []) {
      const tds = [...r.matchAll(/<td>([\s\S]*?)<\/td>/g)].map(x => x[1]);
      if (tds.length < 5) continue;
      let company = stripTags(tds[0]);
      if (company === "↳" || !company) company = lastCompany; else lastCompany = company;
      jobs.push({ company, title: stripTags(tds[1]), loc: stripTags(tds[2]),
        link: firstHref(tds[3]), days: ageToDays(tds[4]), posted: tds[4].trim(), src: srcName });
    }
  }
  return jobs;
}

// Vansh-style: markdown pipe table (all categories mixed; title filter decides).
function parseVansh(md, srcName) {
  const jobs = [];
  let lastCompany = "";
  for (const line of md.split("\n").filter(l => l.trim().startsWith("|"))) {
    const cells = line.split("|").slice(1, -1).map(c => c.trim());
    if (cells.length < 5 || /^-+$/.test(cells[0]) || /^company$/i.test(cells[0])) continue;
    let company = stripTags(cells[0]);
    if (company === "↳" || !company) company = lastCompany; else lastCompany = company;
    jobs.push({ company, title: stripTags(cells[1]),
      loc: stripTags(cells[2].replace(/<\/?br\s*\/?>/gi, " / ")),
      link: firstHref(cells[3]), days: dateToDays(cells[4]), posted: cells[4], src: srcName });
  }
  return jobs;
}
// Header-mapped pipe table (zshah-style). Same markdown as Vansh but SEVEN columns —
//   | Company | Role | Category | Location | Skills | Posted | Apply |
// — so parseVansh reads it wrong in the worst way: Category lands in location, Location lands in
// the link column, and every row comes out with link="" and is then dropped by the "no apply
// link" guard. The whole source contributes zero jobs and says nothing. Map by HEADER NAME
// instead of position, so a column added upstream shifts nothing.
//
// Sections matter as much as columns here. This README carries four pipe tables and only some
// are jobs:
//   ## Summer 2027                          → the target cycle
//   ## Recently posted — cycle not stated    → recent, cycle unknown. Kept: the list says these
//                                             are often the earliest drops, and the posting
//                                             itself settles the cycle at review time.
//   ## Fall 2026                             → SKIPPED, wrong cycle (this project is Summer 2027)
//   ## Drop Radar                            → holds TWO tables, neither of them open jobs:
//                                             a forecast of when companies might post, and a
//                                             "Recently closed — roles that left the list".
//                                             Ingesting the first invents jobs that do not exist;
//                                             ingesting the second resurrects dead ones.
//
// A table is only a jobs table if it has an APPLY column. That is the load-bearing check, not the
// section name: both Drop Radar tables fail it wherever upstream chooses to move them, and it is
// the same reasoning as the "no apply link, can't apply" guard further down. The section
// allowlist then handles the one table that IS jobs but the wrong cycle.
const SECTION_KEEP = /^(summer\s*2027|recently posted)/i;

function parseHeaderTable(md, srcName) {
  const jobs = [];
  const skipped = new Map();
  const drop = (why, n = 1) => skipped.set(why, (skipped.get(why) || 0) + n);
  let section = "";
  let cols = null;
  let lastCompany = "";

  for (const line of md.split("\n")) {
    if (line.startsWith("## ")) {
      section = clean(line.slice(3).replace(/\s*\([^)]*\)\s*$/, ""));
      cols = null; // a heading ends the previous table
      continue;
    }
    const trimmed = line.trim();
    if (!trimmed.startsWith("|")) { cols = null; continue; }

    const cells = trimmed.split("|").slice(1, -1).map((c) => c.trim());
    // Header row: remember where each column is, for this table only.
    const names = cells.map((c) => c.toLowerCase().replace(/[^a-z]/g, ""));
    if (names.includes("company") && names.includes("role")) {
      const link = names.indexOf("apply");
      // No Apply column → not open roles. The "Recently closed" table is exactly this shape
      // (Company|Role|Cycle|Closed|Why) and would otherwise re-add roles that just left.
      cols = link < 0
        ? { reject: `"${section}" (no Apply column — closed or forecast rows, not open roles)` }
        : { company: names.indexOf("company"), title: names.indexOf("role"),
            loc: names.indexOf("location"), link, posted: names.indexOf("posted") };
      continue;
    }
    if (!cols || cells.every((c) => /^:?-+:?$/.test(c))) continue;
    if (cols.reject) { drop(cols.reject); continue; }
    if (!SECTION_KEEP.test(section)) {
      drop(`"${section}" (not the Summer 2027 cycle)`);
      continue;
    }

    const at = (i) => (i >= 0 ? cells[i] ?? "" : "");
    let company = clean(stripTags(at(cols.company)));
    if (company === "↳" || !company) company = lastCompany; else lastCompany = company;
    const posted = clean(at(cols.posted));
    const days = fullDateToDays(posted);
    jobs.push({
      company,
      title: clean(stripTags(at(cols.title))),
      loc: clean(stripTags(at(cols.loc).replace(/<\/?br\s*\/?>/gi, " / "))),
      link: anyLink(at(cols.link)),
      days: days == null ? dateToDays(posted) : days,
      posted: posted || "unknown",
      src: srcName,
    });
  }
  for (const [why, n] of skipped) console.log(`  skipped ${n} row(s) under ${why}`);
  return jobs;
}

function parseGithub(md, srcName) {
  if (md.includes("<table>")) return parseSimplify(md, srcName);
  // A "Category" column is the tell: Vansh's table has no such column, and reading a header
  // table positionally is silent data corruption rather than a visible failure.
  if (/^\|[^\n]*\bcompany\b[^\n]*\brole\b[^\n]*\bcategory\b/im.test(md)) return parseHeaderTable(md, srcName);
  return parseVansh(md, srcName);
}

// InternDock: JS-rendered guide. Keep software-ish industry sections.
async function parseInterndock(url, srcName) {
  const { chromium } = await import("playwright");
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    await page.goto(url, { waitUntil: "networkidle", timeout: 60000 });
    await page.waitForTimeout(2500);
    const dom = await page.evaluate(() => {
      const root = document.querySelector("article") || document.querySelector("main") || document.body;
      const out = [];
      const w = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT);
      let n;
      while ((n = w.nextNode())) {
        const tag = n.tagName.toLowerCase();
        if (tag === "h2") out.push({ type: "h2", text: n.textContent.trim() });
        else if (tag === "li") {
          const a = n.querySelector("a[href]");
          if (a && !n.querySelector("ul")) {
            let before = "", after = "", seen = false;
            for (const ch of n.childNodes) {
              if (ch === a) { seen = true; continue; }
              (seen ? (after += ch.textContent) : (before += ch.textContent));
            }
            out.push({ type: "li", role: before.replace(/[\s—–-]+$/, "").trim(),
              tail: after.replace(/^[\s,]+/, "").trim(), href: a.href });
          }
        }
      }
      return out;
    });
    const KEEP = /^(Software Engineering|AI \/ ML \/ Data|Cybersecurity \/ IT)\b/i;
    const jobs = [];
    let inKeep = false;
    for (const n of dom) {
      if (n.type === "h2") { inKeep = KEEP.test(n.text); continue; }
      if (!inKeep) continue;
      const tail = n.tail || "";
      const idx = tail.indexOf(", ");
      jobs.push({ company: idx < 0 ? tail : tail.slice(0, idx).trim(),
        title: n.role, loc: idx < 0 ? "" : tail.slice(idx + 2).trim(),
        link: cleanUrl(n.href), days: 400, posted: "Aug 2026 list", src: srcName });
    }
    return jobs;
  } finally { await browser.close(); }
}

// ------------------------------------------------------------- selftest (--selftest)
// The header-table parser's failure mode is SILENCE: read the columns positionally and every row
// loses its apply link, gets dropped by the "no link" guard, and the source contributes nothing
// while the run still reports success. That is exactly how the zshah source produced zero jobs
// before it was handled. A fixture is cheap insurance; run it with:  npm run test:sources
if (process.argv.includes("--selftest")) {
  const FIXTURE = [
    "## Summer 2027  (2 employer-stated)", "",
    "| Company | Role | Category | Location | Skills | Posted | Apply |",
    "|---|---|---|---|---|---|---|",
    "| Acme \u{1F181} | Software Engineer Intern \u{1F195} | Software | New York +2 more | Python | Aug 20, 2026 | [Apply](https://jobs.ashbyhq.com/acme/abc?utm_source=x) |",
    "| Globex \u2713 | Data Scientist Intern \u{1F6C2}\u{1F1FA}\u{1F1F8} | Data & ML/AI | Plymouth, Minnesota | PyTorch | Aug 12, 2026 | [Apply](https://globex.wd5.myworkdayjobs.com/x/job/y) |",
    "",
    "## Fall 2026  (1 employer-stated)", "",
    "| Company | Role | Category | Location | Skills | Posted | Apply |",
    "|---|---|---|---|---|---|---|",
    "| Initech | Software Engineering Intern | Software | Buffalo, NY | SQL | Aug 19, 2026 | [Apply](https://initech.wd5.myworkdayjobs.com/z) |",
    "",
    "## \u{1F4C5} Drop Radar", "",
    "| Company | Typical opening | Expected this cycle | Status |",
    "|---|---|---|---|",
    "| Atlassian | ~Aug | ~Aug | waiting |",
    "",
    "| Company | Role | Cycle | Closed | Why |",
    "|---|---|---|---|---|",
    "| Toshiba | AI Software Engineering Intern | Fall 2026 | 2026-08-22 | gone from feed |",
  ].join("\n");

  let pass = 0, fail = 0;
  const check = (name, cond, got) => {
    if (cond) { pass++; console.log(`  \u2713 ${name}`); }
    else { fail++; console.log(`  \u2717 ${name}${got === undefined ? "" : ` — got ${JSON.stringify(got)}`}`); }
  };
  console.log("\nHeader-mapped pipe table (zshah-style)\n");
  const jobs = parseHeaderTable(FIXTURE, "fixture");

  check("only the Summer 2027 table is read", jobs.length === 2, jobs.length);
  check("Fall 2026 is not ingested", !jobs.some(j => j.company === "Initech"));
  check("the forecast table is not ingested", !jobs.some(j => j.company === "Atlassian"));
  check("a closed role is not resurrected", !jobs.some(j => j.company === "Toshiba"));
  check("the rolling badge (U+1F181, missed on the first pass) is stripped", jobs[0]?.company === "Acme", jobs[0]?.company);
  check("visa/new badges are stripped from the role", jobs[0]?.title === "Software Engineer Intern", jobs[0]?.title);
  check("H-1B check mark is stripped", jobs[1]?.company === "Globex", jobs[1]?.company);
  check("Location is read, not Category", jobs[0]?.loc === "New York +2 more", jobs[0]?.loc);
  check("a markdown [Apply](url) link is found", jobs[0]?.link.startsWith("https://jobs.ashbyhq.com/acme/abc"), jobs[0]?.link);
  check("utm_source is stripped from the link", !jobs[0]?.link.includes("utm_source"), jobs[0]?.link);
  check("every row has a link", jobs.every(j => j.link), jobs.map(j => j.link));
  // Aug 20 2026 against a pinned today of Aug 24 2026 — the stated year is used, not guessed.
  check("a stated year is honoured", fullDateToDays("Aug 20, 2026") === Math.round((TODAY - Date.UTC(2026, 7, 20)) / 86400000));
  check("a date with no year returns null", fullDateToDays("Aug 20") === null);
  check("region maps the Location column", region(jobs[0].loc)?.[0] === 4, region(jobs[0].loc));

  console.log(`\n${fail ? "\u2717" : "\u2713"} ${pass} passed, ${fail} failed\n`);
  process.exit(fail ? 1 : 0);
}

// ------------------------------------------------------------------ main
const raw = [];
for (const url of SITES) {
  try {
    if (/github\.com/i.test(url)) {
      const name = url.match(/github\.com\/([^/]+)/)[1];
      raw.push(...parseGithub(await fetchGithubReadme(url), name));
    } else if (/interndock\.com/i.test(url)) {
      raw.push(...await parseInterndock(url, "InternDock"));
    } else {
      console.warn(`! No adapter for ${url} — skipped. Add one in build_internships.mjs.`);
      continue;
    }
    console.log(`fetched ${url}`);
  } catch (e) { console.warn(`! Failed ${url}: ${e.message}`); }
}

// Companies to exclude entirely (per user prefs). ByteDance and TikTok are the
// same company — skip both, incl. their portals (lifeattiktok / bytedance).
const EXCLUDE_COMPANY = /\bbytedance\b|\btiktok\b/i;
const EXCLUDE_LINK = /lifeattiktok\.com|jobs\.bytedance\.com|joinbytedance\.com/i;

// filter + region
let kept = [];
for (const j of raw) {
  if (!j.link) continue;            // no apply link (e.g. 🔒 closed listings) — can't apply
  if (EXCLUDE_COMPANY.test(j.company || "") || EXCLUDE_LINK.test(j.link)) continue; // ByteDance/TikTok
  if (!keepTitle(j.title)) continue;
  const reg = region(j.loc);
  if (!reg) continue;
  j.regNum = reg[0]; j.regName = reg[1];
  kept.push(j);
}

// dedupe across sources by company | normalized title | region
const normCompany = c => clean(c).toLowerCase().replace(/,?\s*(inc|llc|ltd|corp|co)\.?$/, "").replace(/[^a-z0-9]+/g, " ").trim();
const normTitle = t => clean(t).toLowerCase().replace(/\[[^\]]*\]/g, " ")
  .replace(/\b(spring|summer|fall|winter|autumn)\b/g, " ").replace(/\b20\d\d\b/g, " ")
  .replace(/\b(intern|internship|internships|co-?op|program)\b/g, " ").replace(/[^a-z0-9]+/g, " ").trim();
const seen = new Map();
for (const j of kept) {
  const key = `${normCompany(j.company)}|${normTitle(j.title)}|${j.regNum}`;
  if (!seen.has(key)) { seen.set(key, j); continue; }
  const e = seen.get(key);
  const better = j.days < e.days || (e.regNum === 8 && j.regNum !== 8) || (!e.link && j.link);
  if (better) { for (const s of e.src.split("+")) if (!j.src.includes(s)) j.src += "+" + s; seen.set(key, j); }
  else { if (!e.src.includes(j.src)) e.src += "+" + j.src; if (!e.link && j.link) e.link = j.link; }
}
kept = [...seen.values()];

// stable short IDs: 6 uppercase letters derived from each job's identity, so a
// given role keeps its ID across regenerations regardless of what else is added.
function fnv1a(str) {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 0x01000193); }
  return h >>> 0;
}
function toLetters(h, len = 6) {
  let s = "";
  for (let i = 0; i < len; i++) { s = String.fromCharCode(65 + (h % 26)) + s; h = Math.floor(h / 26); }
  return s;
}
const identity = j => j.link || `${normCompany(j.company)}|${normTitle(j.title)}|${j.regNum}`;
const usedIds = new Set();
for (const j of [...kept].sort((a, b) => identity(a).localeCompare(identity(b)))) {
  let salt = 0, id;
  do { id = toLetters(fnv1a(identity(j) + (salt ? "#" + salt : ""))); salt++; } while (usedIds.has(id));
  usedIds.add(id);
  j.id = id;
}

kept.sort((a, b) => a.regNum - b.regNum || a.days - b.days || a.company.localeCompare(b.company));

// write CSV
const csv = x => { x = x == null ? "" : String(x); return /[",\n]/.test(x) ? `"${x.replace(/"/g, '""')}"` : x; };
const rows = [["ID", "Region", "Company", "Job Title", "Location", "Posted", "Apply Link", "Source"].join(",")];
for (const j of kept) rows.push([j.id, j.regName, clean(j.company), clean(j.title), j.loc, j.posted, j.link, j.src].map(csv).join(","));
fs.writeFileSync(path.join(ROOT, "internships_summer2027.csv"), rows.join("\n") + "\n");

// write human-readable markdown: Region -> Company -> positions (no links).
// The CSV above stays the link index used to look up a role when you say "apply".
const byRegion = new Map();
for (const j of kept) {
  if (!byRegion.has(j.regName)) byRegion.set(j.regName, new Map());
  const comp = byRegion.get(j.regName);
  const name = clean(j.company);
  if (!comp.has(name)) comp.set(name, []);
  comp.get(name).push(j);
}
const md = [`# Summer 2027 Internships — by Region & Company`, ``,
  `_${kept.length} undergrad software / AI roles, from ${SITES.length} sources. Grouped by region (your priority order), then company. Links are not shown here — they live in \`internships_summer2027.csv\`; tell me a company + position and I'll pull the exact apply link._`, ``];
for (const [regName, comp] of byRegion) {
  const total = [...comp.values()].reduce((n, a) => n + a.length, 0);
  md.push(`## ${regName} — ${comp.size} companies, ${total} roles`, ``);
  // companies ordered: latest posting first, then most roles, then name
  const companies = [...comp.entries()].sort((a, b) => {
    const da = Math.min(...a[1].map(j => j.days)), db = Math.min(...b[1].map(j => j.days));
    return da - db || b[1].length - a[1].length || a[0].localeCompare(b[0]);
  });
  for (const [name, list] of companies) {
    list.sort((x, y) => x.days - y.days);
    const locs = [...new Set(list.map(j => j.loc).filter(Boolean))];
    const oneLoc = locs.length === 1 ? locs[0] : null;
    const head = oneLoc ? `${name} — ${oneLoc}` : name;
    md.push(list.length > 1 ? `### ${head}  (${list.length} roles)` : `### ${head}`);
    for (const j of list) {
      const bits = [clean(j.title)];
      if (!oneLoc && j.loc) bits.push(j.loc);
      bits.push(j.posted);
      md.push(`- \`${j.id}\`  ${bits.join("  ·  ")}`);
    }
    md.push(``);
  }
}
fs.writeFileSync(path.join(ROOT, "internships_summer2027.md"), md.join("\n"));

const byReg = {};
for (const j of kept) byReg[j.regName] = (byReg[j.regName] || 0) + 1;
console.log(`\nWrote internships_summer2027.csv (link index) + internships_summer2027.md (readable) — ${kept.length} roles`);
console.log(byReg);
