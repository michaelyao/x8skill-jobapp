"use client";

import { useMemo, useState } from "react";
import type { PendingEntry } from "@core/knowledge/approvalQueue.js";

interface Props {
  entry: PendingEntry;
  description: string;
  requisitionId?: string;
  role: string;
  hasScreenshot: boolean;
}

type Answer = { label: string; value: string; draft?: boolean };

/**
 * Statuses that mean this job is finished, and the headline to show for each.
 *
 * Without this the page offered "Approve & submit" on an application that had already gone in
 * — the worker refuses it, but being asked at all reads as though it were still open.
 */
const DECIDED: Record<string, string> = {
  manual_submitted: "Submitted by hand on the employer's site",
  submitted: "Submitted",
  skipped: "Skipped — no application was filed",
};

/**
 * The review surface that replaces the email.
 *
 * Answers are editable in place. An edit is not a "change request" — it becomes the approved
 * value directly: the worker persists the edited list and the ReplayAgent types exactly that,
 * with no LLM involved. "Submitted == approved" holds because the edit happens BEFORE the
 * approval, not after it.
 */
export function ReviewPanel({ entry, description, requisitionId, role, hasScreenshot }: Props) {
  // A held job is the interesting case: the approved answers are stale, and what needs
  // reviewing is what the re-fill actually produced. Show THAT, or approving would authorize
  // a set of values that is no longer what the form holds.
  const hold = entry.reapproval;
  const source = hold?.proposed?.length ? hold.proposed : (entry.answers ?? []);
  const original = useMemo<Answer[]>(
    () => source.map((a) => ({ label: a.label, value: a.value, draft: a.draft })),
    [source],
  );
  const [answers, setAnswers] = useState<Answer[]>(original);
  const [busy, setBusy] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [changeText, setChangeText] = useState("");
  const [showChange, setShowChange] = useState(false);
  // Corrections are worth more than this one application: by default they become the standing
  // answer for that question, so the next form asking it is filled correctly without a review.
  const [remember, setRemember] = useState(true);
  // Inline editing can only fix answers that ARE here. A question the form asked but we never
  // answered — Deepgram's work-authorisation questions — has no row to edit, so there has to be
  // a way to write the answer in by hand and have it stick for every future form.
  const [newQuestion, setNewQuestion] = useState("");
  const [newAnswer, setNewAnswer] = useState("");
  // Marking a job manually submitted is not undoable through the console: it tells every
  // dedupe guard the application exists, and nothing will re-open it afterwards. So it asks
  // once rather than firing on a single mis-click next to "Approve".
  const [confirmManual, setConfirmManual] = useState(false);

  const edited = useMemo(
    () => answers.some((a, i) => a.value !== original[i]?.value),
    [answers, original],
  );
  const editedCount = answers.filter((a, i) => a.value !== original[i]?.value).length;

  /**
   * Fields belonging to one repeated row — "Work Experience 2 — Company*" — are shown together
   * under that row's heading, with the prefix stripped from each label. Six employments as a
   * flat list of "Company*, Job Title*, Company*, Job Title*…" is unreadable, and it was
   * impossible to tell which dates belonged to which employer.
   */
  const groups = useMemo(() => {
    const out: Array<{ title: string | null; items: Array<{ answer: Answer; index: number }> }> = [];
    answers.forEach((answer, index) => {
      // The block name is not always at the front: the date pass prepends "From*" after the
      // block pass has run, so "From* — Work Experience 2 — Month" belongs to Work Experience 2
      // even though it does not begin with it. Anchoring to the start dropped every date field
      // out of its own group.
      const match = /(work experience|experience|employment|education|school|languages?|certifications?)\s*\d+/i.exec(answer.label);
      const title = match ? match[0].replace(/\s+/g, " ") : null;
      const last = out[out.length - 1];
      if (last && last.title === title && title !== null) last.items.push({ answer, index });
      else if (last && last.title === null && title === null) last.items.push({ answer, index });
      else out.push({ title, items: [{ answer, index }] });
    });
    return out;
  }, [answers]);
  /**
   * Remove the block name from a label inside its own group. It is not always a prefix: the date
   * pass prepends "From*" after the block pass has already run, so the label arrives as
   * "From* — Work Experience 1 — Month" and stripping only the front leaves the block wedged in
   * the middle. Remove it wherever it sits, then tidy the orphaned separators.
   */
  const shortLabel = (label: string, title?: string | null) => {
    let out = label;
    if (title) out = out.split(" — ").filter((part) => part.trim().toLowerCase() !== title.toLowerCase()).join(" — ");
    return out.replace(/^\s*—\s*|\s*—\s*$/g, "").trim() || label;
  };

  /**
   * Inside a group, "From* — Month" and "From* — Year" are one date to a human, and reading six
   * employments means reading them quickly. So date parts are laid out on a single line under a
   * shared label, short fields pair up two to a row, and only long text takes the full width.
   */
  type Row = { kind: "single" | "date" | "long"; label: string; items: Array<{ answer: Answer; index: number }> };
  const rowsFor = (items: Array<{ answer: Answer; index: number }>, title?: string | null): Row[] => {
    const stripped = Boolean(title);
    const rows: Row[] = [];
    const dateOf = new Map<string, Row>();
    for (const item of items) {
      const label = stripped ? shortLabel(item.answer.label, title) : item.answer.label;
      const datePart = /^(.*?)\s*—\s*(month|year|day)$/i.exec(label);
      if (datePart) {
        // Workday's end date arrives labelled "From* — To*" because the range shares a heading;
        // to a reader it is simply "To*".
        const key = datePart[1].trim().replace(/^from\*?\s*—\s*/i, "");
        const existing = dateOf.get(key);
        if (existing) {
          existing.items.push(item);
          continue;
        }
        const row: Row = { kind: "date", label: key, items: [item] };
        dateOf.set(key, row);
        rows.push(row);
        continue;
      }
      const long = item.answer.value.length > 90 || item.answer.value.includes("\n");
      rows.push({ kind: long ? "long" : "single", label, items: [item] });
    }
    return rows;
  };

  async function send(name: string, extra: Record<string, unknown> = {}) {
    setBusy(name);
    setNote(null);
    try {
      const response = await fetch("/api/command", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name, code: entry.code, ...extra }),
      });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) {
        setNote(body.error ?? "Failed");
        return;
      }
      setNote(body.message ?? "Queued — the worker picks it up within a few seconds.");
    } catch {
      setNote("Could not reach the server");
    } finally {
      setBusy(null);
    }
  }

  async function approve() {
    // Teach first, then submit: the worker drains commands in order, so the correction is in
    // the answer store before anything else runs — and it survives even if the submit fails.
    if (edited && remember) {
      const corrections = answers
        .filter((a, i) => a.value !== original[i]?.value && a.value.trim())
        .map((a) => ({ question: a.label, answer: a.value }));
      if (corrections.length) await send("update_answers", { entries: corrections });
    }
    await send("approve", edited || hold ? { answers: answers.map((a) => ({ ...a, type: "text" })) } : {});
  }

  return (
    <>
      <h1>{entry.title}</h1>
      <p className="sub">
        {entry.company} · <span className="code">{entry.code}</span>
        {requisitionId ? <> · req <span className="code">{requisitionId}</span></> : null}
        {" · "}
        <a href={entry.applyUrl} target="_blank" rel="noreferrer">open posting</a>
      </p>

      <div className="card" style={{ borderColor: "var(--accent)" }}>
        <div style={{ display: "flex", gap: 10, flexWrap: "wrap", alignItems: "center" }}>
          <button className="primary" onClick={approve} disabled={busy !== null}>
            {busy === "approve" ? "Sending…" : edited ? `Approve with ${editedCount} edit${editedCount === 1 ? "" : "s"}` : "Approve & submit"}
          </button>
          <button onClick={() => send("skip")} disabled={busy !== null}>Skip</button>
          {confirmManual ? (
            <button
              className="primary"
              style={{ background: "var(--good, #2f9e44)" }}
              disabled={busy !== null}
              onClick={async () => {
                setConfirmManual(false);
                await send("manual_submit");
              }}
            >
              {busy === "manual_submit" ? "Recording…" : "Confirm — it is already submitted"}
            </button>
          ) : (
            <button onClick={() => setConfirmManual(true)} disabled={busy !== null}>
              I submitted this myself…
            </button>
          )}
          <button onClick={() => setShowChange((v) => !v)} disabled={busy !== null}>Request re-fill…</button>
          <button onClick={() => send("send_review_email")} disabled={busy !== null}>Send to my email</button>
          {edited ? <span className="pill warn">{editedCount} edited — these become the approved answers</span> : null}
          {edited ? (
            <label className="muted" style={{ fontSize: 13, display: "flex", gap: 6, alignItems: "center" }}>
              <input type="checkbox" checked={remember} onChange={(e) => setRemember(e.target.checked)} />
              Remember these corrections for future applications
            </label>
          ) : null}
        </div>

        {showChange ? (
          <div style={{ marginTop: 12 }}>
            <label htmlFor="change">Describe what to change — the agent re-fills the form and comes back for approval</label>
            <textarea id="change" rows={3} value={changeText} onChange={(e) => setChangeText(e.target.value)} placeholder="e.g. use the Pittsburgh address" />
            <button style={{ marginTop: 8 }} disabled={!changeText.trim() || busy !== null} onClick={() => send("change", { instruction: changeText.trim() })}>
              Send re-fill request
            </button>
            <p className="muted" style={{ fontSize: 12 }}>
              For a small correction, just edit the answer below and approve — that is exact and does not re-run the agent.
            </p>
          </div>
        ) : null}

        {confirmManual ? (
          <p className="muted" style={{ fontSize: 13, marginTop: 12, marginBottom: 0 }}>
            This records that you filled and submitted the application on the employer&apos;s site yourself. It is
            <strong> not a skip</strong>: the job counts as submitted, so no future run re-opens or re-files it.
            Nothing is sent to the ATS.
          </p>
        ) : null}

        {note ? <p style={{ marginBottom: 0, marginTop: 12, color: "var(--accent)" }}>{note}</p> : null}
      </div>

      {DECIDED[entry.status] ? (
        <div className="card" style={{ borderColor: "var(--good, #2f9e44)", marginBottom: 14 }}>
          <h3 style={{ marginTop: 0 }}>{DECIDED[entry.status]}</h3>
          <p className="muted" style={{ fontSize: 13, marginBottom: 0 }}>
            {entry.decidedAt ? `Recorded ${entry.decidedAt.slice(0, 16).replace("T", " ")}` : "Recorded"}
            {entry.approvedBy ? ` by ${entry.approvedBy}` : ""}. The answers below are kept for the record — this
            application is closed out and no run will re-open it.
          </p>
        </div>
      ) : null}

      {hold ? (
        <div className="card" style={{ borderColor: "var(--warn)", marginBottom: 14 }}>
          <h3 style={{ color: "var(--warn)", marginTop: 0 }}>Not submitted — the form changed since you approved it</h3>
          <p className="muted" style={{ marginTop: 0, fontSize: 13 }}>
            This was re-filled on {hold.at.slice(0, 16).replace("T", " ")} and stopped before submitting, because
            {hold.reasons.length === 1 ? " one value" : ` ${hold.reasons.length} values`} would have differed from what
            you read. The answers below are what the form holds NOW — approving accepts them.
          </p>
          <ul style={{ fontSize: 13, margin: 0, paddingLeft: 18 }}>
            {hold.reasons.map((r) => (
              <li key={r} style={{ marginBottom: 4 }}>{r}</li>
            ))}
          </ul>
          <p className="muted" style={{ fontSize: 13, marginBottom: 0 }}>
            <a href={`/history/${entry.code}`}>Compare every recorded copy →</a>
          </p>
        </div>
      ) : null}

      <h2>Answers ({answers.length})</h2>
      <div className="card">
        {answers.length === 0 ? <p className="muted" style={{ margin: 0 }}>No structured answers recorded.</p> : null}
        {groups.map((group, gi) => {
          const rows = rowsFor(group.items, group.title);
          const edit = (i: number) => (e: { target: { value: string } }) =>
            setAnswers((prev) => prev.map((p, j) => (j === i ? { ...p, value: e.target.value } : p)));
          const revert = (i: number) => () =>
            setAnswers((prev) => prev.map((p, j) => (j === i ? { ...p, value: original[i].value } : p)));
          const badges = (a: Answer, i: number) => (
            <>
              {a.draft ? <span className="pill warn">draft</span> : null}
              {a.value !== original[i]?.value ? <span className="pill accent">edited</span> : null}
            </>
          );

          return (
            <div
              key={`${group.title ?? "loose"}-${gi}`}
              style={
                group.title
                  ? { border: "1px solid var(--line)", borderRadius: 8, padding: "10px 12px", marginBottom: 10 }
                  : { marginBottom: 4 }
              }
            >
              {group.title ? (
                <h4 style={{ margin: "0 0 8px", textTransform: "none", letterSpacing: 0, fontSize: 13, color: "var(--accent)" }}>
                  {group.title}
                </h4>
              ) : null}
              <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(230px, 1fr))", gap: "8px 14px" }}>
                {rows.map((row, ri) => (
                  <div
                    key={`${row.label}-${ri}`}
                    style={row.kind === "long" ? { gridColumn: "1 / -1" } : undefined}
                  >
                    <div style={{ display: "flex", gap: 6, alignItems: "baseline", marginBottom: 3 }}>
                      <span style={{ fontSize: 12, fontWeight: 600 }}>{row.label}</span>
                      {row.items.map(({ answer: a, index: i }) => (
                        <span key={i}>{badges(a, i)}</span>
                      ))}
                    </div>
                    {row.kind === "date" ? (
                      <div style={{ display: "flex", gap: 6 }}>
                        {row.items.map(({ answer: a, index: i }) => (
                          <input
                            key={i}
                            type="text"
                            value={a.value}
                            onChange={edit(i)}
                            title={a.label}
                            placeholder={(/month/i.test(a.label) && "MM") || (/year/i.test(a.label) && "YYYY") || "DD"}
                            style={{ width: /year/i.test(a.label) ? 76 : 60, padding: "4px 6px", fontSize: 13 }}
                          />
                        ))}
                      </div>
                    ) : row.kind === "long" ? (
                      <textarea
                        rows={Math.min(12, row.items[0].answer.value.split("\n").length + 1)}
                        value={row.items[0].answer.value}
                        onChange={edit(row.items[0].index)}
                      />
                    ) : (
                      <input type="text" value={row.items[0].answer.value} onChange={edit(row.items[0].index)} />
                    )}
                    {row.items.some(({ answer: a, index: i }) => a.value !== original[i]?.value) ? (
                      <p className="muted" style={{ fontSize: 11, margin: "3px 0 0" }}>
                        {row.items
                          .filter(({ answer: a, index: i }) => a.value !== original[i]?.value)
                          .map(({ index: i }) => (
                            <button key={i} style={{ padding: "0 6px", fontSize: 11, marginRight: 4 }} onClick={revert(i)}>
                              revert to {original[i]?.value || "(empty)"}
                            </button>
                          ))}
                      </p>
                    ) : null}
                  </div>
                ))}
              </div>
            </div>
          );
        })}
      </div>

      {hasScreenshot ? (
        <>
          <h2>Screenshot</h2>
          <div className="card">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={`/api/screenshot/${entry.code}`} alt="the filled application" style={{ width: "100%", borderRadius: 6, border: "1px solid var(--line)" }} />
          </div>
        </>
      ) : null}

      <div className="card" style={{ marginBottom: 14 }}>
        <h3 style={{ marginTop: 0, fontSize: 14 }}>Answer a question that is missing</h3>
        <p className="muted" style={{ marginTop: 0, fontSize: 13 }}>
          For a question the form asks but we did not fill — it will not appear above, because there
          is no answer to show. Recorded against the question text, so every future form asking it is
          filled correctly. Then use <em>Request a change</em> to re-fill this application.
        </p>
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
          <input
            type="text"
            value={newQuestion}
            onChange={(e) => setNewQuestion(e.target.value)}
            placeholder="Question as the form words it, e.g. Current Location"
            style={{ flex: "2 1 320px" }}
          />
          <input
            type="text"
            value={newAnswer}
            onChange={(e) => setNewAnswer(e.target.value)}
            placeholder="Answer, e.g. Pittsburgh, PA"
            style={{ flex: "1 1 200px" }}
          />
          <button
            disabled={!newQuestion.trim() || !newAnswer.trim() || busy !== null}
            onClick={async () => {
              await send("update_answers", { entries: [{ question: newQuestion.trim(), answer: newAnswer.trim() }] });
              setNewQuestion("");
              setNewAnswer("");
            }}
          >
            Remember this answer
          </button>
        </div>
      </div>

      <h2>Job description</h2>
      <div className="card">
        <pre style={{ whiteSpace: "pre-wrap", margin: 0, font: "inherit", fontSize: 13.5, color: "var(--muted)" }}>
          {description || "(none captured)"}
        </pre>
      </div>

      <p className="muted" style={{ fontSize: 12, marginTop: 18 }}>
        Signed in as {role}. Approving re-opens the form and fills it with these exact values. Anything the
        page asks that these do not cover stops the submit and comes back here for another look — a value you
        have not read is never submitted.
      </p>
    </>
  );
}
