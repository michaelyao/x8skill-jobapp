"use client";

import { useState } from "react";

/**
 * Re-fill a job that stopped before Review. The common case is one missing answer that has
 * since been added, so a plain Retry sends nothing extra — but a hint can be attached when the
 * fix is specific ("the school is Carnegie Mellon University"), which the re-fill applies the
 * same way an emailed change request does.
 *
 * A retry NEVER submits. It ends with the job back in the queue for a human decision.
 */
export function RetryButton({ code, disabled }: { code: string; disabled?: boolean }) {
  const [state, setState] = useState<"idle" | "sending" | "sent" | "error">("idle");
  const [message, setMessage] = useState("");
  const [showHint, setShowHint] = useState(false);
  const [hint, setHint] = useState("");

  async function retry() {
    setState("sending");
    const instruction = hint.trim();
    const response = await fetch("/api/command", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "retry", code, ...(instruction ? { instruction } : {}) }),
    }).catch(() => null);
    const body = await response?.json().catch(() => ({}));
    if (response?.ok) {
      setState("sent");
      setMessage(instruction ? "queued with hint" : "queued");
    } else {
      setState("error");
      setMessage(body?.error ?? "failed");
    }
  }

  if (state === "sent") return <span className="pill accent">{message}</span>;

  return (
    <>
      <div style={{ display: "flex", gap: 6, justifyContent: "flex-end" }}>
        <button onClick={retry} disabled={disabled || state === "sending"} style={{ padding: "4px 10px", fontSize: 13 }}>
          {state === "sending" ? "…" : "Retry"}
        </button>
        {!showHint ? (
          <button
            onClick={() => setShowHint(true)}
            disabled={disabled}
            title="Tell the re-fill what to do differently"
            style={{ padding: "4px 8px", fontSize: 13 }}
          >
            + hint
          </button>
        ) : null}
      </div>
      {showHint ? (
        <input
          value={hint}
          onChange={(e) => setHint(e.target.value)}
          placeholder="e.g. the school is Carnegie Mellon University"
          style={{ marginTop: 6, width: "100%", fontSize: 13 }}
        />
      ) : null}
      {state === "error" ? <div className="muted" style={{ fontSize: 12 }}>{message}</div> : null}
    </>
  );
}
