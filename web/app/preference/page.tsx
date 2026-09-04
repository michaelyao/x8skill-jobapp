import fs from "node:fs/promises";
import { GUIDELINES_PATH } from "@core/config.js";
import { parseGuidelines } from "@core/knowledge/guidelines.js";
import PreferenceEditor from "@/components/PreferenceEditor";

export const dynamic = "force-dynamic";

/**
 * HOW TO ANSWER A KIND OF QUESTION — the candidate's own rules, editable here.
 *
 * Q&A.txt answers one question exactly. Some questions cannot be enumerated that way because
 * every employer words them differently ("Are you applying to work on something specific at
 * Acme?"), and the preference behind all of them is his, not mine. It lived in two regexes in
 * llmAgent until he asked for somewhere to write it down.
 *
 * Saving enqueues update_guidelines; the WORKER writes the file. The website's copy is mounted
 * read-only and one process does the writing — the same discipline as every other state file.
 */
export default async function PreferencePage() {
  let text = "";
  let readError = "";
  try {
    text = await fs.readFile(GUIDELINES_PATH, "utf8");
  } catch (e) {
    readError = String((e as Error).message);
  }
  const parsed = text ? parseGuidelines(text) : [];

  return (
    <>
      <h1>Preferences</h1>
      <p className="sub">
        How to answer a <strong>kind</strong> of question — the ones no list can enumerate because
        every employer words them differently. Q&amp;A answers one question exactly; this answers a
        class of them. Facts stay in the resume and Q&amp;A: nothing here may answer a question
        about the degree, the GPA or the history.
      </p>

      {readError ? (
        <p className="empty">guidelines.txt could not be read here: {readError}</p>
      ) : (
        <>
          <div className="card" style={{ marginBottom: 14 }}>
            <h2 style={{ marginTop: 0 }}>In force now — {parsed.length} guideline(s)</h2>
            {parsed.length === 0 ? (
              <p className="muted" style={{ marginBottom: 0 }}>
                Nothing readable in the file, so no guideline applies.
              </p>
            ) : (
              parsed.map((g) => (
                <div key={g.name} style={{ marginBottom: 14 }}>
                  <div style={{ fontWeight: 600 }}>{g.name}</div>
                  <div className="muted" style={{ fontSize: 12, marginBottom: 4 }}>
                    matches: <code>{String(g.match).replace(/^\/|\/i$/g, "")}</code>
                  </div>
                  {g.prefer.length ? (
                    <div style={{ fontSize: 13 }}>
                      <strong>prefer</strong>{" "}
                      {g.prefer.map((t) => (
                        <span key={t} className="pill accent" style={{ fontSize: 12, marginRight: 4 }}>
                          {t}
                        </span>
                      ))}
                    </div>
                  ) : null}
                  {g.avoid.length ? (
                    <div style={{ fontSize: 13, marginTop: 4 }}>
                      <strong>avoid</strong>{" "}
                      {g.avoid.map((t) => (
                        <span key={t} className="pill bad" style={{ fontSize: 12, marginRight: 4 }}>
                          {t}
                        </span>
                      ))}
                    </div>
                  ) : null}
                  {g.note ? (
                    <div className="muted" style={{ fontSize: 12, marginTop: 4 }}>{g.note}</div>
                  ) : null}
                </div>
              ))
            )}
          </div>

          <PreferenceEditor initial={text} />
        </>
      )}
    </>
  );
}
