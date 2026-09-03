import { HybridAgent } from "../agent/hybridAgent.js";
import type { Agent, AgentContext, FieldAnswer, FieldSpec, PageSnapshot } from "../agent/types.js";
import type { FilledAnswer } from "../agent/types.js";

/**
 * Cases for replaying an APPROVED set onto a live form.  npm run test:replay
 *
 * An approval is the one thing in this system a human actually decided, so the replay has to
 * honour it exactly — including a decision to leave a field EMPTY. Approving "" for Pony.ai's
 * "Summary (Optional)" meant "no summary on this application"; the replay treated the empty
 * string as "no approved answer", asked the LLM, wrote a nine-line summary, and then held the
 * application for re-approval saying the FORM had changed. It had not.
 */
let pass = 0;
let fail = 0;
const check = (name: string, cond: boolean, got?: unknown) => {
  if (cond) { pass += 1; console.log(`  ✓ ${name}`); }
  else { fail += 1; console.log(`  ✗ ${name}${got === undefined ? "" : ` — got ${JSON.stringify(got)}`}`); }
};

const field = (key: string, label: string, extra: Partial<FieldSpec> = {}): FieldSpec => ({
  key, label, type: "text", required: false, ...extra,
});
const snapshot = (fields: FieldSpec[]): PageSnapshot =>
  ({ fields, submitReady: false } as unknown as PageSnapshot);
const ctx = {} as AgentContext;

/** A fallback that records what it was asked, so "went to the LLM" is observable. */
class SpyAgent implements Agent {
  asked: string[] = [];
  async decide(s: PageSnapshot): Promise<FieldAnswer[]> {
    this.asked.push(...s.fields.map((f) => f.label));
    return s.fields.map((f) => ({
      key: f.key, value: "LLM WROTE THIS", confidence: 0.5, source: "llm" as const,
    }));
  }
}

const approved = (label: string, value: string): FilledAnswer =>
  ({ label, value, type: "text" } as FilledAnswer);

console.log("an approved BLANK is an answer");
{
  const spy = new SpyAgent();
  const agent = new HybridAgent([approved("Summary (Optional)", "")], spy);
  const out = await agent.decide(snapshot([field("f1", "Summary (Optional)")]), ctx);
  check(`it is replayed as empty, not filled`, out[0]?.value === "", out[0]);
  check(`the LLM is never asked about it`, spy.asked.length === 0, spy.asked);
  check(`it is marked blank, so it is not "no answer available"`, out[0]?.blank === true, out[0]);
  check(`and it is not counted as a novel value`, agent.novel.length === 0, agent.novel);
  check(`its source is the approved set`, out[0]?.source === "curated");
}

console.log("\nwhat must still happen");
{
  const spy = new SpyAgent();
  const agent = new HybridAgent([approved("First Name*", "Nathan")], spy);
  const out = await agent.decide(snapshot([field("f1", "First Name*")]), ctx);
  check(`an approved value replays exactly`, out[0]?.value === "Nathan", out[0]);
  check(`and does not reach the LLM`, spy.asked.length === 0);
}
{
  const spy = new SpyAgent();
  const agent = new HybridAgent([approved("First Name*", "Nathan")], spy);
  const out = await agent.decide(snapshot([field("f1", "First Name*"), field("f2", "Why us?*", { required: true })]), ctx);
  check(`a question NOT in the approved set goes to the LLM`, spy.asked.includes("Why us?*"), spy.asked);
  check(`and is recorded as novel, so the materiality gate sees it`,
    agent.novel.some((n) => n.label === "Why us?*"), agent.novel);
  check(`the approved one is untouched`, out.find((a) => a.key === "f1")?.value === "Nathan");
}
{
  // Repeated labels keep their own values, positionally — two work-experience rows, and the
  // SECOND one approved empty.
  const spy = new SpyAgent();
  const agent = new HybridAgent([approved("Role Description", "Amazon work"), approved("Role Description", "")], spy);
  const out = await agent.decide(snapshot([field("a", "Role Description"), field("b", "Role Description")]), ctx);
  check(`the first occurrence keeps its value`, out[0]?.value === "Amazon work", out[0]);
  check(`the second keeps its approved BLANK`, out[1]?.value === "" && out[1]?.blank === true, out[1]);
  check(`neither reaches the LLM`, spy.asked.length === 0, spy.asked);
}
{
  // More occurrences than were approved is a real gap and must still be reported as one.
  const spy = new SpyAgent();
  const agent = new HybridAgent([approved("Role Description", "")], spy);
  await agent.decide(snapshot([field("a", "Role Description"), field("b", "Role Description")]), ctx);
  check(`a THIRD occurrence nobody approved still goes to the LLM`, spy.asked.length === 1, spy.asked);
  check(`and is flagged as more occurrences than were approved`,
    agent.novel.some((n) => n.reason === "more occurrences than were approved"), agent.novel);
}

console.log(`\n${fail ? "✗" : "✓"} ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
