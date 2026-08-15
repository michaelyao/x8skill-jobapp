"use client";

import { useEffect, useState } from "react";
import type { WorkerStatus } from "@core/knowledge/workerStatus.js";

interface Props {
  initial: { status: WorkerStatus | null; stale: boolean };
  pendingCommands: number;
}

/**
 * Live worker state. Subscribes to /api/stream (SSE) so an action taken here shows its effect
 * within a second, instead of the page looking frozen until a manual refresh.
 */
export function WorkerBar({ initial, pendingCommands }: Props) {
  const [state, setState] = useState(initial);
  const [queued, setQueued] = useState(pendingCommands);

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
      {queued > 0 ? <span className="pill accent">{queued} queued</span> : null}
    </div>
  );
}
