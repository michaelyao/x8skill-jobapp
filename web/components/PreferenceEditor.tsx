"use client";

import { useState } from "react";

/**
 * The raw guidelines file, edited in place.
 *
 * A textarea rather than a form per field: the format is meant to be readable and hand-editable
 * (it has comments explaining itself at the top), and a structured editor would hide that. Saving
 * enqueues update_guidelines — the worker parses it before writing, so a typo is reported here
 * rather than silently stopping a guideline from matching.
 */
export default function PreferenceEditor({ initial }: { initial: string }) {
  const [text, setText] = useState(initial);
  const [state, setState] = useState<"idle" | "saving" | "saved" | "error">("idle");
  const [message, setMessage] = useState("");

  const save = async () => {
    setState("saving");
    setMessage("");
    try {
      const res = await fetch("/api/command", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: "update_guidelines", text, priority: 1 }),
      });
      const body = (await res.json()) as { error?: string; id?: string };
      if (!res.ok) {
        setState("error");
        setMessage(body.error ?? `save failed (${res.status})`);
        return;
      }
      setState("saved");
      setMessage("Queued for the worker — it writes the file, and the next application uses it.");
    } catch (e) {
      setState("error");
      setMessage(String((e as Error).message));
    }
  };

  return (
    <div className="card">
      <h2 style={{ marginTop: 0 }}>Edit</h2>
      <p className="muted" style={{ fontSize: 13, marginTop: 0 }}>
        One block per guideline: <code>[name]</code>, then <code>MATCH</code> (a regex tried against
        the question), <code>PREFER</code>, <code>AVOID</code>, <code>NOTE</code>. An option list is
        filtered by PREFER and AVOID; free text gets all three as its instruction. Nothing matching
        means the guideline stays silent rather than guessing.
      </p>
      <textarea
        value={text}
        onChange={(e) => setText(e.target.value)}
        spellCheck={false}
        rows={22}
        style={{ width: "100%", fontFamily: "ui-monospace, monospace", fontSize: 13, lineHeight: 1.5 }}
      />
      <div style={{ display: "flex", gap: 10, alignItems: "center", marginTop: 10, flexWrap: "wrap" }}>
        <button className="primary" onClick={save} disabled={state === "saving" || text === initial}>
          {state === "saving" ? "Saving…" : "Save"}
        </button>
        {text === initial ? <span className="muted" style={{ fontSize: 13 }}>No changes yet.</span> : null}
        {message ? (
          <span className={state === "error" ? "pill bad" : "pill accent"} style={{ fontSize: 12 }}>
            {message}
          </span>
        ) : null}
      </div>
    </div>
  );
}
