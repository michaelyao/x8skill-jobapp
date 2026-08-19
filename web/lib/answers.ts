import "server-only";
import { loadAnswers, loadLearnedAnswers } from "@core/knowledge/answerStore.js";
import { ensureEnv } from "./env";

/**
 * The answer store as one reviewable list.
 *
 * Two files feed it: the hand-curated seed in Q&A.txt, and the corrections in
 * data/learned-answers.json which OVERRIDE the seed. That precedence is invisible in the files
 * themselves, so it is spelled out here: a row says where its value came from, and whether
 * forgetting the correction would fall back to a seed answer or leave the question unanswered.
 */

export interface AnswerRow {
  id: string;
  question: string;
  normalizedQuestion: string;
  answer: string;
  source: string;
  /** True when this value came from a correction rather than the seed file. */
  learned: boolean;
  /** For a learned row: the seed value it is overriding, if any. */
  overrides?: string;
}

const asText = (value: unknown): string => (Array.isArray(value) ? value.join(", ") : String(value ?? ""));

export async function getAnswerRows(): Promise<AnswerRow[]> {
  ensureEnv();
  const [all, learned] = await Promise.all([loadAnswers().catch(() => []), loadLearnedAnswers().catch(() => [])]);
  const learnedByKey = new Map(learned.map((e) => [e.normalizedQuestion, e]));

  return all
    .map((entry) => {
      const isLearned = learnedByKey.has(entry.normalizedQuestion);
      return {
        id: entry.id,
        question: entry.question,
        normalizedQuestion: entry.normalizedQuestion,
        answer: asText(entry.answer),
        source: entry.source,
        learned: isLearned,
      } satisfies AnswerRow;
    })
    .sort((a, b) => Number(b.learned) - Number(a.learned) || a.question.localeCompare(b.question));
}
