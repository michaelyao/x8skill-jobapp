import { getAnswerRows } from "@/lib/answers";
import { currentUser } from "@/lib/session";
import { AnswerTable } from "@/components/AnswerTable";

export const dynamic = "force-dynamic";

export default async function AnswersPage() {
  const [rows, user] = await Promise.all([getAnswerRows(), currentUser()]);
  const learned = rows.filter((r) => r.learned).length;

  return (
    <>
      <h1>Answers</h1>
      <p className="sub">
        What gets typed into forms. {rows.length} question{rows.length === 1 ? "" : "s"} — {learned} of them
        corrected by you, which <strong>override</strong> the curated seed. Editing here changes every future
        application; it does not touch applications already filled and waiting in the queue.
      </p>
      <AnswerTable rows={rows} role={user?.role ?? "reviewer"} />
    </>
  );
}
