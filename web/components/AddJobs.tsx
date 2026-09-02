"use client";

import { useEffect, useState } from "react";

interface Outcome {
  url: string;
  code?: string;
  state: "queued" | "already-given" | "already-engaged" | "on-our-list" | "not-a-url";
  detail: string;
}
interface Request {
  code: string;
  url: string;
  company?: string;
  title?: string;
  note?: string;
  at: string;
}

/**
 * Hand over job URLs. They are A SOURCE, like the trackers in job_sites.txt.
 *
 * Built for how he said he would use it: one URL or a list, more than once, with repeats, and
 * repeats of postings the trackers already carry. So it takes a textarea rather than one field, and
 * it reports on EVERY URL separately — because "queued 5" would hide the fact that three of them
 * were already in hand, and knowing which is the whole point of pasting a list.
 */
const TONE: Record<Outcome["state"], string> = {
  queued: "good",
  "on-our-list": "accent",
  "already-given": "muted",
  "already-engaged": "warn",
  "not-a-url": "bad",
};

export function AddJobs() {
  const [urls, setUrls] = useState("");
  const [company, setCompany] = useState("");
  const [title, setTitle] = useState("");
  const [note, setNote] = useState("");
  const [state, setState] = useState<"idle" | "sending">("idle");
  const [outcomes, setOutcomes] = useState<Outcome[]>([]);
  const [error, setError] = useState("");
  const [requests, setRequests] = useState<Request[]>([]);

  async function load() {
    const r = await fetch("/api/request-job").catch(() => null);
    const body = await r?.json().catch(() => ({}));
    if (Array.isArray(body?.requests)) setRequests(body.requests);
  }
  useEffect(() => {
    void load();
  }, []);

  async function send() {
    if (!urls.trim()) return;
    setState("sending");
    setError("");
    const r = await fetch("/api/request-job", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ urls, company, title, note }),
    }).catch(() => null);
    const body = await r?.json().catch(() => ({}));
    setState("idle");
    if (!r?.ok) {
      setError(body?.error ?? "could not take those");
      return;
    }
    setOutcomes(body.outcomes ?? []);
    setUrls("");
    void load();
  }

  const count = (urls.match(/https?:\/\/[^\s,"'<>]+/g) ?? []).length;

  return (
    <>
      <div className="card">
        <h3 style={{ marginTop: 0 }}>Job URLs</h3>
        <p className="muted" style={{ marginTop: 0, fontSize: 13 }}>
          Paste one or as many as you like, one per line. They become listings like any other source,
          get a code, and are applied to under the same guards — nothing is ever submitted without
          you. Give me the same URL twice and it stays one job.
        </p>
        <textarea
          value={urls}
          onChange={(e) => setUrls(e.target.value)}
          rows={6}
          placeholder={"https://job-boards.greenhouse.io/company/jobs/1234567\nhttps://jobs.ashbyhq.com/company/…"}
          style={{ width: "100%", fontFamily: "ui-monospace, monospace", fontSize: 13, padding: 8, boxSizing: "border-box" }}
        />
        <div style={{ display: "flex", gap: 8, marginTop: 8, flexWrap: "wrap" }}>
          <input value={company} onChange={(e) => setCompany(e.target.value)} placeholder="Company (optional)" style={{ padding: 6, fontSize: 13 }} />
          <input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Role (optional)" style={{ padding: 6, fontSize: 13 }} />
          <input value={note} onChange={(e) => setNote(e.target.value)} placeholder="Note to me (optional)" style={{ padding: 6, fontSize: 13, flex: 1, minWidth: 160 }} />
        </div>
        <p className="muted" style={{ fontSize: 12, marginTop: 6, marginBottom: 8 }}>
          Company and role are only worth filling in for a single URL — I read them from the page
          otherwise.
        </p>
        <button className="primary" onClick={() => void send()} disabled={state === "sending" || !count}>
          {state === "sending" ? "Taking them…" : count > 1 ? `Take these ${count} jobs` : "Take this job"}
        </button>
        {error ? <span className="pill bad" style={{ marginLeft: 10, fontSize: 12 }}>{error}</span> : null}
      </div>

      {outcomes.length ? (
        <div className="card" style={{ marginTop: 14 }}>
          <h3 style={{ marginTop: 0 }}>What happened to each</h3>
          {outcomes.map((o) => (
            <div key={o.url} style={{ paddingBottom: 8, fontSize: 13 }}>
              <span className={`pill ${TONE[o.state]}`} style={{ fontSize: 11 }}>{o.state.replace(/-/g, " ")}</span>{" "}
              {o.code ? <a href={`/queue/${o.code}`} className="code">{o.code}</a> : null} {o.detail}
              <div className="muted" style={{ fontSize: 12, wordBreak: "break-all" }}>{o.url}</div>
            </div>
          ))}
        </div>
      ) : null}

      <h2 style={{ marginTop: 20 }}>Everything you have given me</h2>
      {requests.length === 0 ? (
        <p className="empty">Nothing yet.</p>
      ) : (
        <div className="card" style={{ padding: 0 }}>
          <div style={{ overflowX: "auto" }}>
            <table>
              <thead>
                <tr><th>Code</th><th>Company</th><th>URL</th><th>Note</th><th className="right">Given</th></tr>
              </thead>
              <tbody>
                {requests.map((r) => (
                  <tr key={`${r.code}-${r.at}`}>
                    <td className="code"><a href={`/queue/${r.code}`}>{r.code}</a></td>
                    <td>{r.company ?? "—"}</td>
                    <td style={{ maxWidth: 380, overflow: "hidden", textOverflow: "ellipsis" }}>
                      <a href={r.url} target="_blank" rel="noreferrer">{r.url}</a>
                    </td>
                    <td className="muted" style={{ fontSize: 12 }}>{r.note ?? ""}</td>
                    <td className="right muted nowrap">{r.at.slice(0, 16).replace("T", " ")}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </>
  );
}
