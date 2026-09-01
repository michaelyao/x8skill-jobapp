"use client";

import { useState } from "react";

/**
 * Skip one of the OTHER applications at this employer, from the table that lists them.
 *
 * The common case is four roles at one company and only one worth applying for — and skipping the
 * other three used to mean opening three pages to press the same button. The decision is made while
 * looking at the comparison, so the action belongs there.
 *
 * A skip means no application was filed, which is why it is safe to offer here: it withdraws a draft
 * rather than doing anything at the employer. It still goes through the command queue, so the
 * worker's own guards decide whether the entry may be skipped at all — an application already
 * submitted is refused there, not here.
 */
export function SkipRowButton({ code, title }: { code: string; title?: string }) {
  const [state, setState] = useState<"idle" | "sending" | "done" | "error">("idle");
  const [message, setMessage] = useState("");

  async function skip() {
    setState("sending");
    const response = await fetch("/api/command", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "skip", code }),
    }).catch(() => null);
    const body = await response?.json().catch(() => ({}));
    if (response?.ok) {
      setState("done");
      setMessage("skip queued");
    } else {
      setState("error");
      setMessage(body?.error ?? "could not skip");
    }
  }

  if (state === "done" || state === "error") {
    return (
      <span className={state === "error" ? "pill bad" : "pill"} style={{ fontSize: 11 }}>
        {message}
      </span>
    );
  }
  return (
    <button
      onClick={() => void skip()}
      disabled={state === "sending"}
      title={`Skip ${title ?? code} — withdraws the draft, nothing is sent to the employer`}
      style={{ padding: "2px 8px", fontSize: 11 }}
    >
      {state === "sending" ? "…" : "Skip"}
    </button>
  );
}
