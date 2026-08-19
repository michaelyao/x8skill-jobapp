"use client";

import { useMemo, useState } from "react";
import type { AnswerRow } from "@/lib/answers";

/**
 * Review and edit the answer store.
 *
 * Saving records a correction, which overrides the seed for that question from then on. Forgetting
 * removes the correction so the seed applies again — the only way to undo something I have
 * "remembered", which until now meant editing a JSON file by hand.
 */
export function AnswerTable({ rows, role }: { rows: AnswerRow[]; role: string }) {
  const [filter, setFilter] = useState("");
  const [onlyLearned, setOnlyLearned] = useState(false);
  const [edits, setEdits] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);

  const shown = useMemo(() => {
    const needle = filter.trim().toLowerCase();
    return rows.filter(
      (r) =>
        (!onlyLearned || r.learned) &&
        (!needle || r.question.toLowerCase().includes(needle) || r.answer.toLowerCase().includes(needle)),
    );
  }, [rows, filter, onlyLearned]);

  async function send(name: string, body: Record<string, unknown>, key: string, what: string) {
    setBusy(key);
    setNote(null);
    try {
      const response = await fetch("/api/command", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name, ...body }),
      });
      const payload = await response.json().catch(() => ({}));
      setNote(response.ok ? `${what} — the worker applies it within a few seconds.` : (payload.error ?? "Failed"));
    } catch {
      setNote("Could not reach the server");
    } finally {
      setBusy(null);
    }
  }

  return (
    <>
      <div className="card" style={{ display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" }}>
        <input
          type="text"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          placeholder="Search questions and answers"
          style={{ flex: "1 1 280px" }}
        />
        <label className="muted" style={{ fontSize: 13, display: "flex", gap: 6, alignItems: "center" }}>
          <input type="checkbox" checked={onlyLearned} onChange={(e) => setOnlyLearned(e.target.checked)} />
          only my corrections
        </label>
        <span className="muted" style={{ fontSize: 13 }}>
          {shown.length} shown
        </span>
      </div>

      {note ? <p className="muted" style={{ fontSize: 13 }}>{note}</p> : null}

      <div className="card" style={{ padding: 0, marginTop: 12 }}>
        <table>
          <thead>
            <tr>
              <th style={{ width: "42%" }}>Question</th>
              <th>Answer</th>
              <th style={{ width: 150 }}>Source</th>
              <th className="right" style={{ width: 150 }}>Action</th>
            </tr>
          </thead>
          <tbody>
            {shown.map((r) => {
              const value = edits[r.id] ?? r.answer;
              const changed = value !== r.answer;
              return (
                <tr key={r.id}>
                  <td style={{ fontSize: 13 }}>{r.question}</td>
                  <td>
                    {value.length > 70 || value.includes("\n") ? (
                      <textarea
                        rows={Math.min(8, value.split("\n").length + 1)}
                        value={value}
                        onChange={(e) => setEdits((p) => ({ ...p, [r.id]: e.target.value }))}
                      />
                    ) : (
                      <input type="text" value={value} onChange={(e) => setEdits((p) => ({ ...p, [r.id]: e.target.value }))} />
                    )}
                  </td>
                  <td style={{ fontSize: 12 }}>
                    {r.learned ? <span className="pill good">yours</span> : <span className="pill">seed</span>}
                  </td>
                  <td className="right">
                    <div style={{ display: "flex", gap: 6, justifyContent: "flex-end" }}>
                      <button
                        disabled={!changed || busy !== null || role === "viewer"}
                        onClick={() =>
                          send("update_answers", { entries: [{ question: r.question, answer: value }] }, r.id, "Saved")
                        }
                        style={{ padding: "3px 9px", fontSize: 12 }}
                      >
                        Save
                      </button>
                      {r.learned ? (
                        <button
                          disabled={busy !== null || role === "viewer"}
                          title="Remove my correction so the curated seed applies again"
                          onClick={() => send("forget_answers", { questions: [r.question] }, r.id, "Forgotten")}
                          style={{ padding: "3px 9px", fontSize: 12 }}
                        >
                          Forget
                        </button>
                      ) : null}
                    </div>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </>
  );
}
