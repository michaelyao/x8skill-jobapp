import { notFound } from "next/navigation";
import { getHistory } from "@/lib/history";
import { getQueueEntry, getApplication } from "@/lib/store";

export const dynamic = "force-dynamic";

const when = (iso: string) => iso.slice(0, 19).replace("T", " ").replace("Z", "") + " UTC";

const PHASE_LABEL: Record<string, string> = {
  fill: "Filled",
  refill: "Re-filled after a requested change",
  submit: "Read again at submit time",
};

/** Show where two strings diverge, so a rewording can be judged rather than described. */
function Diverge({ before, after, at }: { before: string; after: string; at: number }) {
  return (
    <div style={{ fontSize: 13 }}>
      <div>
        <span className="muted">was</span> <code>{before.slice(0, at)}</code>
        <mark>{before.slice(at)}</mark>
      </div>
      <div>
        <span className="muted">now</span> <code>{after.slice(0, at)}</code>
        <mark>{after.slice(at)}</mark>
      </div>
    </div>
  );
}

export default async function HistoryDetail({ params }: { params: Promise<{ code: string }> }) {
  const { code } = await params;
  const steps = await getHistory(code);
  if (!steps.length) notFound();

  const entry = await getQueueEntry(code);
  const record = await getApplication(code);
  const title = entry?.title ?? record?.title ?? code;
  const company = entry?.company ?? record?.company ?? "";

  return (
    <>
      <p className="muted" style={{ fontSize: 13 }}>
        <a href="/history">← History</a>
      </p>
      <h1>
        {company} · {title}
      </h1>
      <p className="sub">
        <span className="code">{code}</span> · {steps.length === 1 ? "1 recorded copy" : `${steps.length} recorded copies`} · oldest first
      </p>

      {steps.map((step, i) => {
        const { round, form, answers } = step;
        const formChanged = form && (form.added.length || form.removed.length || form.requiredChanged.length);
        const answersChanged = answers && (answers.changed.length || answers.added.length || answers.removed.length);

        return (
          <div className="card" key={round.at} style={{ marginTop: 14 }}>
            <h3 style={{ marginTop: 0 }}>
              {i + 1}. {PHASE_LABEL[round.phase] ?? round.phase}
              <span className="pill" style={{ marginLeft: 8 }}>{round.phase}</span>
              {round.reconstructed ? (
                <span className="pill warn" style={{ marginLeft: 6 }}>reconstructed</span>
              ) : null}
            </h3>
            <p className="muted" style={{ marginTop: 0, fontSize: 13 }}>
              {when(round.at)} · {round.fields.length} fields seen · {round.answers.length} answers
              {round.outcome ? ` · ${round.outcome}` : ""}
            </p>
            {round.reconstructed ? (
              <p className="muted" style={{ fontSize: 13 }}>
                Rebuilt from the approval queue, not observed live: the answers are exactly what was
                approved, but the field list is inferred from them, so a comparison against this copy
                only covers questions that were answered.
              </p>
            ) : null}

            {i > 0 ? (
              <>
                <h4>What changed since the previous copy</h4>
                {!formChanged && !answersChanged ? (
                  <p style={{ color: "var(--good)", fontSize: 13 }}>
                    Nothing. The form and every answer are identical to copy {i}.
                  </p>
                ) : null}

                {form?.reworded.map((r) => (
                  <div key={r.before} style={{ marginBottom: 8 }}>
                    <span className="pill warn">reworded</span>
                    <Diverge before={r.before} after={r.after} at={r.divergesAt} />
                  </div>
                ))}
                {form?.added
                  .filter((f) => !form.reworded.some((r) => r.after === f.label))
                  .map((f) => (
                    <div key={`a-${f.label}`} style={{ fontSize: 13 }}>
                      <span className="pill warn">new field</span> {f.label}
                      {f.required ? <span className="pill bad" style={{ marginLeft: 6 }}>required</span> : null}
                    </div>
                  ))}
                {form?.removed
                  .filter((f) => !form.reworded.some((r) => r.before === f.label))
                  .map((f) => (
                    <div key={`r-${f.label}`} style={{ fontSize: 13 }}>
                      <span className="pill">removed</span> {f.label}
                    </div>
                  ))}
                {form?.requiredChanged.map((c) => (
                  <div key={`q-${c.label}`} style={{ fontSize: 13 }}>
                    <span className="pill warn">{c.now ? "became required" : "no longer required"}</span> {c.label}
                  </div>
                ))}

                {answers?.changed.map((c) => (
                  <div key={`c-${c.label}`} style={{ fontSize: 13, marginTop: 6 }}>
                    <span className="pill warn">answer changed</span> <strong>{c.label}</strong>
                    <div className="muted">
                      <s>{c.before || "(blank)"}</s> → <span style={{ color: "var(--good)" }}>{c.after || "(blank)"}</span>
                    </div>
                  </div>
                ))}
                {answers?.added.map((a) => (
                  <div key={`aa-${a.label}`} style={{ fontSize: 13 }}>
                    <span className="pill">answer added</span> <strong>{a.label}</strong> — {a.value}
                  </div>
                ))}
                {answers?.removed.map((a) => (
                  <div key={`ar-${a.label}`} style={{ fontSize: 13 }}>
                    <span className="pill">answer dropped</span> <strong>{a.label}</strong> — {a.value}
                  </div>
                ))}
              </>
            ) : null}

            <details style={{ marginTop: 10 }}>
              <summary>This copy in full — {round.answers.length} answers</summary>
              <table style={{ marginTop: 8 }}>
                <thead>
                  <tr><th>Question</th><th>Answer</th></tr>
                </thead>
                <tbody>
                  {round.answers.map((a, n) => (
                    <tr key={`${a.label}-${n}`}>
                      <td>
                        {a.label}
                        {a.draft ? <span className="pill warn" style={{ marginLeft: 6 }}>draft</span> : null}
                      </td>
                      <td>{a.value || <span className="muted">(blank)</span>}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </details>

            {round.fields.length ? (
              <details style={{ marginTop: 6 }}>
                <summary>The form as read — {round.fields.length} fields</summary>
                <table style={{ marginTop: 8 }}>
                  <thead>
                    <tr><th>Field</th><th>Type</th><th>Required</th></tr>
                  </thead>
                  <tbody>
                    {round.fields.map((f, n) => (
                      <tr key={`${f.label}-${n}`}>
                        <td>{f.label}</td>
                        <td className="muted">{f.type}</td>
                        <td>{f.required ? "yes" : ""}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </details>
            ) : null}
          </div>
        );
      })}
    </>
  );
}
