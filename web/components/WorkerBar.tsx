"use client";

import { useEffect, useState } from "react";
import type { WorkerStatus } from "@core/knowledge/workerStatus.js";

interface Props {
  initial: { status: WorkerStatus | null; stale: boolean };
  pendingCommands: number;
  /** What is queued, in the order the worker will claim it. See store.describePending. */
  pendingList?: Array<{
    name: string;
    code?: string;
    company?: string;
    createdAt: string;
    priority?: number;
    instruction?: string;
  }>;
}

/**
 * Live worker state. Subscribes to /api/stream (SSE) so an action taken here shows its effect
 * within a second, instead of the page looking frozen until a manual refresh.
 */
export function WorkerBar({ initial, pendingCommands, pendingList = [] }: Props) {
  const [state, setState] = useState(initial);
  const [queued, setQueued] = useState(pendingCommands);
  const [open, setOpen] = useState(false);

  useEffect(() => {
    const source = new EventSource("/api/stream");
    source.addEventListener("state", (event) => {
      try {
        const data = JSON.parse((event as MessageEvent).data);
        setState({ status: data.worker, stale: data.stale });
        setQueued(data.pendingCommands);
        // A command finishing changes the lists on the page, so pull fresh server data.
        if (data.changed) window.location.reload();
      } catch {
        /* ignore a malformed frame */
      }
    });
    return () => source.close();
  }, []);

  const status = state.status;
  const tone = !status || state.stale ? "stale" : status.state === "busy" ? "busy" : "idle";
  const label = !status
    ? "worker has never run — start it with: npm run worker"
    : state.stale
      ? `worker not responding (last tick ${new Date(status.lastTickAt).toLocaleTimeString()}) — is it running?`
      : status.state === "busy"
        ? status.activity ?? "working"
        : "idle, waiting for commands";

  return (
    <div className="worker">
      <span className={`dot ${tone}`} />
      <span>{label}</span>
      {queued > 0 ? (
        /**
         * OPENABLE. It was a bare "15 queued" and there was no way to see what those fifteen were —
         * the candidate asked for a button, which is right: a number you cannot open is a number
         * you have to take on trust, and this one decides how long anything he asked for will wait.
         */
        <button
          type="button"
          className="pill accent"
          onClick={() => setOpen((v) => !v)}
          title="what the worker will take next"
          style={{ cursor: "pointer", border: 0 }}
        >
          {queued} queued {open ? "▾" : "▸"}
        </button>
      ) : null}
      {open && pendingList.length ? (
        <div className="card" style={{ marginTop: 10, width: "100%", padding: "10px 12px" }}>
          <div className="muted" style={{ fontSize: 12, marginBottom: 6 }}>
            In the order the worker will claim them. Decisions first, then anything marked
            <span className="pill accent" style={{ fontSize: 11, margin: "0 4px" }}>now</span>
            , then re-fills, applies and sweeps.
          </div>
          <table>
            <thead>
              <tr>
                <th>What</th>
                <th>Job</th>
                <th>Asked for</th>
              </tr>
            </thead>
            <tbody>
              {pendingList.map((c, i) => (
                <tr key={`${c.name}-${c.code ?? i}-${c.createdAt}`}>
                  <td className="nowrap">
                    {c.name}
                    {c.priority !== undefined ? (
                      <span className="pill accent" style={{ fontSize: 11, marginLeft: 6 }}>now</span>
                    ) : null}
                  </td>
                  <td>
                    {c.code ? (
                      <a href={`/queue/${c.code}`}>{c.code}</a>
                    ) : (
                      <span className="muted">—</span>
                    )}
                    {c.company ? <span className="muted"> · {c.company}</span> : null}
                    {c.instruction ? (
                      <div className="muted" style={{ fontSize: 12 }}>{c.instruction}</div>
                    ) : null}
                  </td>
                  <td className="muted nowrap">
                    {c.createdAt ? new Date(c.createdAt).toLocaleTimeString() : ""}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}
      {open && !pendingList.length ? (
        <div className="muted" style={{ fontSize: 12, marginTop: 8, width: "100%" }}>
          Nothing queued right now — the count refreshes on its own.
        </div>
      ) : null}
    </div>
  );
}
