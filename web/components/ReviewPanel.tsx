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

  const edited = useMemo(
    () => answers.some((a, i) => a.value !== original[i]?.value),
    [answers, original],
  );
  const editedCount = answers.filter((a, i) => a.value !== original[i]?.value).length;

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

  const approve = () =>
    send("approve", edited || hold ? { answers: answers.map((a) => ({ ...a, type: "text" })) } : {});

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
          <button onClick={() => setShowChange((v) => !v)} disabled={busy !== null}>Request re-fill…</button>
          <button onClick={() => send("send_review_email")} disabled={busy !== null}>Send to my email</button>
          {edited ? <span className="pill warn">{editedCount} edited — these become the approved answers</span> : null}
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

        {note ? <p style={{ marginBottom: 0, marginTop: 12, color: "var(--accent)" }}>{note}</p> : null}
      </div>

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
        {answers.map((a, i) => {
          const changed = a.value !== original[i]?.value;
          return (
            <div key={`${a.label}-${i}`} style={{ paddingBottom: 14, marginBottom: 14, borderBottom: i === answers.length - 1 ? "none" : "1px solid var(--line)" }}>
              <div style={{ display: "flex", gap: 8, alignItems: "baseline", marginBottom: 5 }}>
                <strong style={{ fontSize: 14 }}>{a.label}</strong>
                {a.draft ? <span className="pill warn">draft — please read</span> : null}
                {changed ? <span className="pill accent">edited</span> : null}
              </div>
              {a.value.length > 90 || a.value.includes("\n") ? (
                <textarea
                  rows={Math.min(10, Math.ceil(a.value.length / 90) + 1)}
                  value={a.value}
                  onChange={(e) => setAnswers((prev) => prev.map((p, j) => (j === i ? { ...p, value: e.target.value } : p)))}
                />
              ) : (
                <input
                  type="text"
                  value={a.value}
                  onChange={(e) => setAnswers((prev) => prev.map((p, j) => (j === i ? { ...p, value: e.target.value } : p)))}
                />
              )}
              {changed ? (
                <p className="muted" style={{ fontSize: 12, margin: "5px 0 0" }}>
                  was: {original[i]?.value || "(empty)"}{" "}
                  <button style={{ padding: "1px 7px", fontSize: 12 }} onClick={() => setAnswers((prev) => prev.map((p, j) => (j === i ? { ...p, value: original[i].value } : p)))}>
                    revert
                  </button>
                </p>
              ) : null}
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
