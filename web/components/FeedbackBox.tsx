"use client";

import { useEffect, useState } from "react";

interface Note {
  id: string;
  text: string;
  by: string;
  at: string;
  resolvedAt?: string;
  resolution?: string;
}

/**
 * Tell the person maintaining this system what is wrong with THIS application, from the page where
 * you noticed it.
 *
 * The gap this closes: a reviewer opens an application, sees that the transcript never uploaded or
 * the GPA is stale, and the only way to report it is to leave, open a terminal, and describe it from
 * memory. Most problems found that way were never reported at all.
 *
 * It is not a Retry and not a Change. Both of those ask the WORKER to fill the form again, which
 * cannot help when the fault is in the code that reads the form or in the answers it fills from —
 * and that is where most of these turn out to live.
 */
export function FeedbackBox({ code, company, title }: { code: string; company?: string; title?: string }) {
  const [open, setOpen] = useState(false);
  const [text, setText] = useState("");
  const [state, setState] = useState<"idle" | "sending" | "sent" | "error">("idle");
  const [message, setMessage] = useState("");
  const [notes, setNotes] = useState<Note[]>([]);

  async function load() {
    const r = await fetch(`/api/feedback?code=${encodeURIComponent(code)}`).catch(() => null);
    const body = await r?.json().catch(() => ({}));
    if (Array.isArray(body?.notes)) setNotes(body.notes);
  }
  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [code]);

  async function send() {
    const body = text.trim();
    if (!body) return;
    setState("sending");
    const r = await fetch("/api/feedback", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ code, company, title, text: body }),
    }).catch(() => null);
    const json = await r?.json().catch(() => ({}));
    if (r?.ok) {
      setState("sent");
      setMessage("Filed. It will be picked up with the next round of fixes.");
      setText("");
      void load();
    } else {
      setState("error");
      setMessage(json?.error ?? "Could not file that");
    }
  }

  const waiting = notes.filter((n) => !n.resolvedAt);
  const done = notes.filter((n) => n.resolvedAt);

  /**
   * Folded by default, and at the TOP of the page.
   *
   * It has to be the first thing in reach — the problem is noticed while reading the application,
   * and a box below several screens of answers is a box you scroll past. Folded because on most
   * applications there is nothing to say, and an open textarea at the top of every review would
   * push the thing being reviewed down the page.
   *
   * The heading stays a real summary line: it counts what has already been said here, so a note
   * left earlier is visible without opening anything.
   */
  return (
    <div className="card" style={{ marginTop: 0, marginBottom: 14 }}>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        style={{
          all: "unset",
          cursor: "pointer",
          display: "flex",
          alignItems: "center",
          gap: 8,
          width: "100%",
          fontWeight: 600,
        }}
      >
        <span style={{ display: "inline-block", width: 12, transform: open ? "rotate(90deg)" : "none", transition: "transform .12s" }}>
          ›
        </span>
        Something wrong with this application?
        {waiting.length ? (
          <span className="pill warn" style={{ fontSize: 12 }}>
            {waiting.length} waiting
          </span>
        ) : null}
        {done.length ? (
          <span className="muted" style={{ fontSize: 12, fontWeight: 400 }}>
            {done.length} dealt with
          </span>
        ) : null}
      </button>

      {!open ? null : (
      <div style={{ marginTop: 12 }}>
      <p className="muted" style={{ marginTop: 0, fontSize: 13 }}>
        Describe it here rather than in a terminal — a missing transcript, a stale fact, a field
        filled with the wrong thing. This goes to whoever is fixing the system, not to the worker:
        use it when the fault is in the code or the stored answers, and Retry when the form just
        needs filling again.
      </p>
      <textarea
        value={text}
        onChange={(e) => setText(e.target.value)}
        rows={5}
        placeholder={'e.g. "The transcript is required here and was never uploaded — the red star is on the label."'}
        style={{ width: "100%", fontFamily: "inherit", fontSize: 14, padding: 8, boxSizing: "border-box" }}
        onKeyDown={(e) => {
          // Enter makes a new line; the shortcut is deliberate, so a long note is never sent half-written.
          if ((e.metaKey || e.ctrlKey) && e.key === "Enter") void send();
        }}
      />
      <div style={{ display: "flex", alignItems: "center", gap: 10, marginTop: 8 }}>
        <button onClick={() => void send()} disabled={state === "sending" || !text.trim()}>
          {state === "sending" ? "Filing…" : "Send to Claude"}
        </button>
        <span className="muted" style={{ fontSize: 12 }}>⌘/Ctrl + Enter</span>
        {message ? (
          <span className={state === "error" ? "pill bad" : "pill"} style={{ fontSize: 12 }}>
            {message}
          </span>
        ) : null}
      </div>

      {waiting.length ? (
        <div style={{ marginTop: 14 }}>
          <strong style={{ fontSize: 13 }}>Waiting to be picked up</strong>
          {waiting.map((n) => (
            <div key={n.id} style={{ marginTop: 6, fontSize: 13 }}>
              <span className="muted">
                {n.at.slice(0, 16).replace("T", " ")} · {n.by}
              </span>
              <div style={{ whiteSpace: "pre-wrap" }}>{n.text}</div>
            </div>
          ))}
        </div>
      ) : null}

      {done.length ? (
        <div style={{ marginTop: 14 }}>
          <strong style={{ fontSize: 13 }}>Dealt with</strong>
          {done.map((n) => (
            <div key={n.id} style={{ marginTop: 6, fontSize: 13 }}>
              <span className="muted">
                {n.at.slice(0, 16).replace("T", " ")} · {n.by}
              </span>
              <div style={{ whiteSpace: "pre-wrap" }}>{n.text}</div>
              {n.resolution ? (
                <div className="muted" style={{ marginTop: 2 }}>
                  → {n.resolution}
                </div>
              ) : null}
            </div>
          ))}
        </div>
      ) : null}
      </div>
      )}
    </div>
  );
}
