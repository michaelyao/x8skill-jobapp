import { getApplication, getQueueEntry, getSiblingApplications } from "@/lib/store";
import { ReviewPanel } from "@/components/ReviewPanel";
import { FeedbackBox } from "@/components/FeedbackBox";
import { SiblingApplications } from "@/components/SiblingApplications";
import { RoleTermFlag } from "@/components/RoleTermFlag";
import { EligibilityFlag } from "@/components/EligibilityFlag";
import { pendingCommands } from "@core/knowledge/commands.js";
import { ledgerStage } from "@core/core/statusVocabulary.js";
import { resumeFactsFrom } from "@core/core/queueReadiness.js";
import { readProfileSnapshot } from "@core/knowledge/profile.js";
import { currentUser } from "@/lib/session";
import {
  fetchStoredJobDescription,
  findNoteIdsByLabels,
  loadX8NoteConfig,
} from "@core/knowledge/x8note.js";

/** What a queued command is, in the words the buttons use. */
const DECISION_WORDS: Record<string, string> = {
  approve: "Approve and submit",
  skip: "Skip",
  manual_submit: "Already submitted by hand",
  mark_closed: "Marking the posting closed",
  change: "A correction",
  retry: "A re-fill",
  apply: "A first fill",
};

export const dynamic = "force-dynamic";

export default async function ReviewPage({ params }: { params: Promise<{ code: string }> }) {
  const { code } = await params;
  const [entry, app, user, siblings, waiting] = await Promise.all([
    getQueueEntry(code),
    getApplication(code),
    currentUser(),
    getSiblingApplications(code),
    pendingCommands().catch(() => []),
  ]);
  /**
   * A DECISION ALREADY IN FLIGHT, said on the page.
   *
   * "I marked this as submitted by hand and it is still sitting in the queue" — and there was no
   * way to tell from here whether the click had landed. The confirmation only ever existed as a
   * client-side note that a reload threw away, so a request that failed and one that succeeded
   * looked identical the moment you navigated. The command queue knows; this shows it.
   */
  const queuedDecision = waiting.find((c) => "code" in c && c.code === code);

  if (!entry) {
    /**
     * NOT "no such job" — a job with no QUEUE entry simply has not reached the review step, and
     * saying only that it is absent is how eight postings added by hand read as lost. The ledger
     * usually knows exactly what happened (an ATS we cannot drive, an authentication gate, a
     * required field that blocked the run), so say that and link to where the detail lives.
     */
    const stage = ledgerStage(app?.status);
    return (
      <>
        <h1>{code}</h1>
        {app ? (
          <div className="card">
            <p style={{ marginTop: 0 }}>
              <strong>{app.company ?? "This job"}</strong>
              {app.title ? ` — ${app.title}` : ""}
            </p>
            <p>
              <span className={`pill ${stage?.tone ?? "muted"}`}>{stage?.label ?? app.status}</span>
            </p>
            <p className="muted">
              {stage?.meaning ??
                "It has a record but never reached the review step, so there is nothing to approve here."}
            </p>
            <p>
              <a href={`/applications/${code}`}>See everything recorded for it</a>
              {app.applyUrl ? (
                <>
                  {" · "}
                  <a href={app.applyUrl} target="_blank" rel="noreferrer">
                    the posting
                  </a>
                </>
              ) : null}
            </p>
          </div>
        ) : (
          <div className="card">
            <p style={{ marginTop: 0 }} className="empty">
              Nothing has been recorded for this code yet.
            </p>
            <p className="muted">
              Look it up on <a href={`/incoming?q=${code}`}>Jobs found</a> — every posting from every
              source is there with its state, whether or not anything has been attempted on it.
            </p>
          </div>
        )}
      </>
    );
  }

  // The description lives in x8note (one store, see DESIGN.md §12); the queue copy is a
  // fallback for entries written before that move.
  const profileSnapshot = await readProfileSnapshot();
  const degree = profileSnapshot ? resumeFactsFrom(profileSnapshot).degree : undefined;

  const cfg = entry.code ? await loadX8NoteConfig() : null;

  let description = entry.jobDescription ?? "";
  if (!description && cfg && entry.code) {
    description = await fetchStoredJobDescription(cfg, entry.code);
  }

  // A link to the posting as x8note holds it. The ledger records the note id at write
  // time, so most jobs cost nothing to link; the by-label lookup is for the ones written
  // before that field existed. No note found means none was ever stored — say nothing
  // rather than offer a link that 404s.
  let noteUrl: string | undefined;
  if (cfg && entry.code) {
    let noteId = app?.x8noteId;
    if (!noteId) noteId = (await findNoteIdsByLabels(cfg, [`jobid_${entry.code}`]))[0];
    if (noteId) noteUrl = `${cfg.baseUrl}/notes/${noteId}`;
  }

  return (
    <>
      <FeedbackBox code={code.toUpperCase()} company={entry.company} title={entry.title} />
      <EligibilityFlag description={description || entry.jobDescription} degree={degree} />
      <RoleTermFlag title={entry.title ?? ""} description={description} />
      {queuedDecision ? (
        <div className="card" style={{ marginBottom: 14, borderColor: "var(--accent)" }}>
          <strong>{DECISION_WORDS[queuedDecision.name] ?? queuedDecision.name} is queued</strong>
          <p className="muted" style={{ marginBottom: 0 }}>
            The worker has not applied it yet, so what you see below is still the old state. It is
            picked up within seconds — reload to see the result.
          </p>
        </div>
      ) : null}
      <SiblingApplications rows={siblings} />
      <ReviewPanel
        entry={JSON.parse(JSON.stringify(entry))}
        description={description}
        noteUrl={noteUrl}
        requisitionId={app?.companyReqId ?? entry.companyReqId}
        role={user?.role ?? "reviewer"}
        hasScreenshot={Boolean(app?.lastRunDir)}
        queuedDecision={queuedDecision ? DECISION_WORDS[queuedDecision.name] ?? queuedDecision.name : undefined}
      />
      <p className="muted" style={{ fontSize: 13, marginTop: 14 }}>
        <a href={`/history/${code}`}>History — every recorded copy of this application</a>
      </p>
    </>
  );
}
