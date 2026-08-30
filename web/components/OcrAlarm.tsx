import { readOcrHealth } from "@core/knowledge/ocrHealth.js";

/**
 * A red flag across every page when the visual checker is down.
 *
 * It has to be loud and everywhere, because what it means is that NOTHING IS BEING FILLED — the
 * worker holds every apply, retry and approve rather than produce applications nobody has verified.
 * A quiet failure here looks exactly like a quiet day, and the difference between "the queue is not
 * moving because there is no work" and "the queue is not moving because the checker is down" is the
 * whole message.
 */
export async function OcrAlarm() {
  const health = await readOcrHealth().catch(() => null);
  if (!health || health.ok) return null;

  const since = health.lastOkAt ? new Date(health.lastOkAt) : null;
  const mins = since ? Math.round((Date.now() - since.getTime()) / 60000) : null;
  const ago = mins === null ? "not since this was recorded" : mins < 60 ? `${mins} min ago` : `${Math.round(mins / 60)} h ago`;

  return (
    <div
      role="alert"
      style={{
        background: "var(--bad, #c92a2a)",
        color: "#fff",
        padding: "10px 16px",
        fontSize: 14,
        lineHeight: 1.45,
      }}
    >
      <strong>The visual checker (x8ocr) is down — filling has stopped.</strong>{" "}
      {health.reason ? <span style={{ opacity: 0.92 }}>{health.reason}.</span> : null} Nothing is
      being applied to or submitted while it is out, because an application nobody has verified
      looks exactly like one that has been. Last working {ago}; checked{" "}
      {health.checkedAt.slice(0, 16).replace("T", " ")}. Queued work is held, not lost — it runs by
      itself once the service is back.
    </div>
  );
}
