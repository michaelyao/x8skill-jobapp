/**
 * WHY A CONTROL WOULD NOT TAKE A VALUE - asked of the model, from facts read off the live page.
 *
 * The top layer's job is meaning; this is the meaning of a MECHANICAL failure. The facts are
 * gathered by the driver (what the control is, whether anything covers it, its ancestry, its own
 * HTML) and the reading of them is a judgement: "the real input is hidden behind a styled label",
 * "an open menu is covering it", "it is disabled until another field is set".
 *
 * Every such diagnosis in this project has been made by hand so far, after the run failed and
 * usually after it had cost an application. This asks at the moment of failure, while the page is
 * still open.
 *
 * It DIAGNOSES ONLY. It cannot click, type or change anything, and its answer is recorded as an
 * observation - a fix invented by a model and applied unseen is exactly the false success this
 * codebase spends most of its guards preventing.
 */
import { callModel } from "./modelCall.js";

export async function explainStuckField(label: string, facts: string): Promise<string> {
  const system = [
    "You diagnose why a form control on a web page would not accept a value.",
    "You are given facts read from the live element. Do not invent any others.",
    "Answer in ONE sentence, under 40 words, naming the most likely cause and what a human would click instead.",
    "If the facts do not support a diagnosis, say exactly: the facts do not say why.",
  ].join("\n");
  const user = `Field label: ${label}\nFacts read from the page:\n${facts}`;
  const raw = await callModel(system, user).catch(() => "");
  return raw.replace(/\s+/g, " ").trim().slice(0, 300);
}
