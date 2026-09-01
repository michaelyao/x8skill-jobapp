import { getApplication, getQueueEntry, getSiblingApplications } from "@/lib/store";
import { ReviewPanel } from "@/components/ReviewPanel";
import { FeedbackBox } from "@/components/FeedbackBox";
import { SiblingApplications } from "@/components/SiblingApplications";
import { RoleTermFlag } from "@/components/RoleTermFlag";
import { currentUser } from "@/lib/session";
import { fetchStoredJobDescription, loadX8NoteConfig } from "@core/knowledge/x8note.js";

export const dynamic = "force-dynamic";

export default async function ReviewPage({ params }: { params: Promise<{ code: string }> }) {
  const { code } = await params;
  const [entry, app, user, siblings] = await Promise.all([
    getQueueEntry(code),
    getApplication(code),
    currentUser(),
    getSiblingApplications(code),
  ]);

  if (!entry) {
    return (
      <>
        <h1>{code}</h1>
        <p className="empty">No queued application with this code.</p>
      </>
    );
  }

  // The description lives in x8note (one store, see DESIGN.md §12); the queue copy is a
  // fallback for entries written before that move.
  let description = entry.jobDescription ?? "";
  if (!description && entry.code) {
    const cfg = await loadX8NoteConfig();
    if (cfg) description = await fetchStoredJobDescription(cfg, entry.code);
  }

  return (
    <>
      <FeedbackBox code={code.toUpperCase()} company={entry.company} title={entry.title} />
      <RoleTermFlag title={entry.title ?? ""} description={description} />
      <SiblingApplications rows={siblings} />
      <ReviewPanel
        entry={JSON.parse(JSON.stringify(entry))}
        description={description}
        requisitionId={app?.companyReqId ?? entry.companyReqId}
        role={user?.role ?? "reviewer"}
        hasScreenshot={Boolean(app?.lastRunDir)}
      />
      <p className="muted" style={{ fontSize: 13, marginTop: 14 }}>
        <a href={`/history/${code}`}>History — every recorded copy of this application</a>
      </p>
    </>
  );
}
