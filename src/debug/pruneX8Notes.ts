/**
 * Remove duplicate notes from the jobdescription notebook, keeping the newest note per
 * posting. The old client POSTed to /api/notes, which only skips a duplicate when title
 * AND content are >90% similar — our bodies embed the status and a timestamp, so every
 * run created another note (96 notes for 35 jobs; one posting had 18).
 *
 * DRY_RUN=1 to preview. Groups by source_url when present, else by the jobid_ label.
 */
import { loadX8NoteConfig } from "../knowledge/x8note.js";

const dry = process.env.DRY_RUN === "1";
const cfg = await loadX8NoteConfig();
if (!cfg) throw new Error("no x8note config (.x8note.config missing or X8NOTE_DISABLE=1)");

const auth = { Authorization: `Bearer ${cfg.token}` };
interface Note {
  id: string;
  title?: string;
  source_url?: string;
  keywords?: string[];
  created_at?: string;
  content?: string;
}

// Page through the whole notebook — limit is capped at 100.
const notes: Note[] = [];
for (let offset = 0; ; offset += 100) {
  const url = `${cfg.baseUrl}/api/notes?notebook=${encodeURIComponent(cfg.notebook)}&limit=100&offset=${offset}&sortBy=created_at&order=desc`;
  const response = await fetch(url, { headers: auth });
  const json = (await response.json()) as { data?: Note[]; hasMore?: boolean };
  notes.push(...(json.data ?? []));
  if (!json.hasMore) break;
}
console.log(`notebook holds ${notes.length} note(s)`);

const keyFor = (n: Note): string =>
  n.source_url?.trim() || (n.keywords ?? []).find((k) => /^jobid_/i.test(k)) || (n.keywords ?? []).find((k) => /^[A-Z]{6}$/.test(k)) || `title:${n.title}`;

const groups = new Map<string, Note[]>();
for (const n of notes) {
  const k = keyFor(n);
  groups.set(k, [...(groups.get(k) ?? []), n]);
}

/** Length of the real job description in a note body, 0 when it says "_none captured_". */
function describedChars(n: Note): number {
  const content = n.content ?? "";
  const idx = content.indexOf("## Job description");
  if (idx < 0) return 0;
  const jd = content.slice(idx + "## Job description".length).trim();
  return jd === "_none captured_" ? 0 : jd.length;
}

const toDelete: Note[] = [];
for (const [key, rows] of groups) {
  if (rows.length < 2) continue;
  // Keep the note that actually HAS a description, newest as the tie-break. Keeping the
  // newest blindly would discard the only copy of a description whenever a later run was
  // blocked before capturing one.
  const sorted = [...rows].sort(
    (a, b) => describedChars(b) - describedChars(a) || String(b.created_at).localeCompare(String(a.created_at)),
  );
  const kept = sorted[0];
  console.log(
    `  ${String(rows.length).padStart(2)} notes → keeping ${kept.created_at} (${describedChars(kept)} chars of JD) for ${key.slice(0, 62)}`,
  );
  toDelete.push(...sorted.slice(1));
}
const losingText = toDelete.filter((n) => describedChars(n) > 0);
if (losingText.length) console.log(`\n⚠ ${losingText.length} note(s) being deleted still contain description text — check before proceeding`);

console.log(`\n${groups.size} distinct posting(s); ${toDelete.length} duplicate note(s) to remove${dry ? " (dry run)" : ""}`);
if (dry || toDelete.length === 0) process.exit(0);

let ok = 0;
for (const n of toDelete) {
  const r = await fetch(`${cfg.baseUrl}/api/notes/${n.id}`, { method: "DELETE", headers: auth });
  if (r.ok) ok += 1;
  else console.log(`  failed to delete ${n.id}: HTTP ${r.status}`);
}
console.log(`deleted ${ok}/${toDelete.length}`);
