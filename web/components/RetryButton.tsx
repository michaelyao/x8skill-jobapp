"use client";

import { useState } from "react";

export function RetryButton({ code, disabled }: { code: string; disabled?: boolean }) {
  const [state, setState] = useState<"idle" | "sending" | "sent" | "error">("idle");
  const [message, setMessage] = useState("");

  async function retry() {
    setState("sending");
    const response = await fetch("/api/command", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "retry", code }),
    }).catch(() => null);
    const body = await response?.json().catch(() => ({}));
    if (response?.ok) {
      setState("sent");
      setMessage("queued");
    } else {
      setState("error");
      setMessage(body?.error ?? "failed");
    }
  }

  if (state === "sent") return <span className="pill accent">{message}</span>;
  return (
    <>
      <button onClick={retry} disabled={disabled || state === "sending"} style={{ padding: "4px 10px", fontSize: 13 }}>
        {state === "sending" ? "…" : "Retry"}
      </button>
      {state === "error" ? <div className="muted" style={{ fontSize: 12 }}>{message}</div> : null}
    </>
  );
}
