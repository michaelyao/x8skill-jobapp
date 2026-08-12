// Build a readable (desktop + mobile) HTML email of available openings and send it
// via gog. Includes each posting's original apply URL and freshness. ByteDance and
// firmware roles are excluded (per user prefs). Usage: node tools/email_openings.mjs
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";

const CSV = "internships_summer2027.csv";
const GOG_ACCOUNT = process.env.GOG_ACCOUNT || "myao@studiox8.com";
const TO = process.env.REVIEW_EMAIL_TO || `${process.env.JOB_APP_USERNAME || "nyao2@andrew.cmu.edu"}, ${GOG_ACCOUNT}`;

function parseCsv(text) {
  const rows = [];
  const lines = text.split(/\r?\n/).filter((l) => l.length);
  const headers = splitCsvLine(lines[0]);
  for (const line of lines.slice(1)) {
    const cells = splitCsvLine(line);
    const r = {};
    headers.forEach((h, i) => (r[h] = cells[i] ?? ""));
    rows.push(r);
  }
  return rows;
}
function splitCsvLine(line) {
  const out = [];
  let cur = "", q = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (c === '"') { if (q && line[i + 1] === '"') { cur += '"'; i++; } else q = !q; }
    else if (c === "," && !q) { out.push(cur); cur = ""; }
    else cur += c;
  }
  out.push(cur);
  return out;
}
const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

// Freshness: "0d".."30d" or a date like "Aug 04" / "May 22" / "1mo".
function freshness(posted) {
  const p = (posted || "").trim();
  const m = p.match(/^(\d+)d$/);
  if (m) { const d = +m[1]; return { label: d === 0 ? "today" : `${d}d ago`, tone: d <= 1 ? "new" : d <= 7 ? "recent" : "older", order: d }; }
  if (/^1mo$/i.test(p)) return { label: "~1mo ago", tone: "old", order: 40 };
  if (p) return { label: p, tone: "old", order: 60 }; // an explicit date = older
  return { label: "—", tone: "old", order: 99 };
}
const toneColor = { new: "#16a34a", recent: "#2563eb", older: "#a16207", old: "#6b7280" };

// Exclude ByteDance + TikTok (same company) and firmware roles (user prefs).
const EXCLUDE_CO = /\bbytedance\b|\btiktok\b/i;
const rows = parseCsv(readFileSync(CSV, "utf8")).filter(
  (r) => !EXCLUDE_CO.test(r.Company) && !/lifeattiktok|bytedance/i.test(r["Apply Link"] || "") && !/\bfirmware\b/i.test(r["Job Title"]),
);
// group by region → company
const byRegion = new Map();
for (const r of rows) {
  if (!byRegion.has(r.Region)) byRegion.set(r.Region, new Map());
  const comps = byRegion.get(r.Region);
  if (!comps.has(r.Company)) comps.set(r.Company, []);
  comps.get(r.Company).push(r);
}
const total = rows.length;
const regions = [...byRegion.keys()].sort();

let html = `<div style="font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;max-width:680px;margin:0 auto;color:#111827;line-height:1.5;font-size:15px">
  <h2 style="margin:0 0 2px 0;font-size:20px">Available Openings — Summer 2027</h2>
  <div style="color:#6b7280;margin-bottom:6px">${total} undergrad SWE / AI roles · ByteDance &amp; firmware excluded · from SimplifyJobs, vanshb03, interndock</div>
  <div style="color:#6b7280;font-size:13px;margin-bottom:18px">Each role links to its original posting and shows how fresh it is. Reply with a code (or company + role) and I'll fill it, email you a review, and submit on your APPROVE.</div>`;

for (const region of regions) {
  const comps = byRegion.get(region);
  const nroles = [...comps.values()].reduce((a, v) => a + v.length, 0);
  html += `<h3 style="font-size:16px;margin:22px 0 8px 0;padding-bottom:6px;border-bottom:2px solid #e5e7eb">${esc(region)} <span style="color:#9ca3af;font-weight:400;font-size:13px">— ${comps.size} companies, ${nroles} roles</span></h3>`;
  const companies = [...comps.keys()].sort((a, b) => comps.get(b).length - comps.get(a).length || a.localeCompare(b));
  for (const company of companies) {
    const jobs = comps.get(company).slice().sort((a, b) => freshness(a.Posted).order - freshness(b.Posted).order);
    html += `<div style="margin:10px 0 4px 0;font-weight:700">${esc(company)}${jobs.length > 1 ? ` <span style="color:#9ca3af;font-weight:400;font-size:13px">(${jobs.length})</span>` : ""}</div>`;
    for (const j of jobs) {
      const f = freshness(j.Posted);
      const url = j["Apply Link"] || j["Apply URL"] || "";
      const title = esc(j["Job Title"]);
      const loc = esc(j.Location || "");
      html += `<div style="padding:7px 0;border-bottom:1px solid #f3f4f6">
        <div style="display:flex;flex-wrap:wrap;align-items:baseline;gap:6px">
          <a href="${esc(url)}" style="color:#2563eb;text-decoration:none;font-weight:600">${title}</a>
          <span style="color:#6b7280;font-size:13px">${loc ? "· " + loc : ""}</span>
        </div>
        <div style="font-size:12px;color:#6b7280;margin-top:2px">
          <span style="font-family:monospace;background:#f3f4f6;padding:1px 5px;border-radius:4px">${esc(j.ID)}</span>
          <span style="color:${toneColor[f.tone]};font-weight:600;margin-left:6px">● ${f.label}</span>
          <a href="${esc(url)}" style="color:#9ca3af;margin-left:6px;text-decoration:underline">open posting ↗</a>
        </div>
      </div>`;
    }
  }
}
html += `</div>`;

// Plain-text fallback
let text = `Available Openings — Summer 2027 (${total} roles, ByteDance & firmware excluded)\n\n`;
for (const region of regions) {
  const comps = byRegion.get(region);
  text += `== ${region} ==\n`;
  for (const [company, jobs] of comps) {
    text += `  ${company}\n`;
    for (const j of jobs.slice().sort((a, b) => freshness(a.Posted).order - freshness(b.Posted).order)) {
      const f = freshness(j.Posted);
      text += `    [${j.ID}] ${j["Job Title"]} · ${j.Location} · ${f.label}\n      ${j["Apply Link"]}\n`;
    }
  }
  text += "\n";
}

const args = [
  "-a", GOG_ACCOUNT, "gmail", "send",
  "--from", GOG_ACCOUNT, "--to", TO,
  "--subject", `Available Openings — Summer 2027 (${total} roles)`,
  "--body", text, "--body-html", html,
];
const res = spawnSync("gog", args, { encoding: "utf8" });
console.log(res.status === 0 ? `sent (${total} roles) → ${TO}` : `send failed: ${(res.stdout || "") + (res.stderr || "")}`.slice(0, 300));
