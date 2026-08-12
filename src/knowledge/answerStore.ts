import fs from "node:fs/promises";
import { ANSWERS_JSON_PATH, QA_MARKDOWN_PATH, QA_TEXT_PATH } from "../config.js";
import { normalizeQuestion } from "../utils/normalize.js";
import { writeJson, writeText } from "../utils/log.js";
import type { AnswerEntry, AnswerType, FormQuestion } from "../types.js";

function inferAnswerType(answer: string): AnswerType {
  const normalized = answer.trim().toLowerCase();
  if (normalized === "yes" || normalized === "no" || normalized.includes("agree")) {
    return "single_select";
  }
  return "text";
}

function slugFromQuestion(question: string): string {
  return normalizeQuestion(question).replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 60) || "question";
}

export async function loadAnswers(): Promise<AnswerEntry[]> {
  const raw = await fs.readFile(QA_TEXT_PATH, "utf8");
  const entries: AnswerEntry[] = [];
  const lines = raw.split(/\r?\n/);

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index].trim();
    if (!line.startsWith("Q:") && !line.startsWith("Q;")) {
      continue;
    }
    const question = line.slice(2).trim();
    let answer = "";
    for (let next = index + 1; next < lines.length; next += 1) {
      const candidate = lines[next].trim();
      if (candidate.startsWith("A:")) {
        answer = candidate.slice(2).trim();
        break;
      }
      if (candidate.startsWith("Q:") || candidate.startsWith("Q;")) {
        break;
      }
    }
    if (!question || !answer) {
      continue;
    }
    entries.push({
      id: slugFromQuestion(question),
      question,
      normalizedQuestion: normalizeQuestion(question),
      answer,
      answerType: inferAnswerType(answer),
      source: "seed",
      matchers: [normalizeQuestion(question)],
    });
  }

  // Merge structured facts (address, EEO) not written as Q:/A: pairs.
  for (const fact of parseStructuredFacts(raw)) {
    if (!entries.some((e) => e.normalizedQuestion === fact.normalizedQuestion)) {
      entries.push(fact);
    }
  }

  await writeJson(ANSWERS_JSON_PATH, entries);
  await syncAnswersMarkdown(entries);
  return entries;
}

/**
 * Q&A.txt also contains structured facts that aren't in Q:/A: form — a home
 * address block and EEO fields (Gender/Race/Disability/Veteran). Pull those into
 * the answer library so the agent can use them (especially for EEO questions).
 */
function parseStructuredFacts(raw: string): AnswerEntry[] {
  const extras: AnswerEntry[] = [];
  const add = (id: string, question: string, answer: string | undefined, matchers: string[], answerType: AnswerType = "text") => {
    const value = (answer || "").trim().replace(/[,;]+$/, "").trim();
    if (!value) return;
    extras.push({
      id,
      question,
      normalizedQuestion: normalizeQuestion(question),
      answer: value,
      answerType,
      source: "seed",
      matchers: matchers.map((m) => normalizeQuestion(m)),
    });
  };

  add("home_address", "Home address", raw.match(/\d+\s+[^\n,]+,\s*[^\n,]+,?\s*[A-Z]{2}\s*\d{5}/)?.[0],
    ["address", "home address", "street address", "current address", "mailing address", "address line 1"]);
  add("gender", "Gender", raw.match(/gender\s*:\s*([^\n]+)/i)?.[1],
    ["gender", "gender identity"], "single_select");
  add("race", "Race/Ethnicity", raw.match(/race\s*:\s*([^\n]+)/i)?.[1],
    ["race", "ethnicity", "race ethnicity", "race/ethnicity"], "single_select");
  add("disability", "Disability status", raw.match(/disability\s*:\s*([^\n]+)/i)?.[1],
    ["disability", "disability status"], "single_select");
  add("veteran", "Veteran status", raw.match(/veteran\s*:\s*([^\n]+)/i)?.[1],
    ["veteran", "veteran status", "protected veteran"], "single_select");
  return extras;
}

export function findAnswer(entries: AnswerEntry[], question: FormQuestion): AnswerEntry | undefined {
  const normalized = question.normalizedLabel;
  return entries.find((entry) => {
    if (entry.normalizedQuestion === normalized) {
      return true;
    }
    // Require at least 6 chars for substring matching to avoid accidental hits
    // e.g. "city" (4) matching "capacity" inside a long Q&A question.
    return entry.matchers.some((matcher) => {
      if (matcher === normalized) return true;
      if (normalized.length < 6 || matcher.length < 6) return false;
      return normalized.includes(matcher) || matcher.includes(normalized);
    });
  });
}

export async function addLearnedAnswer(entries: AnswerEntry[], question: FormQuestion, answer: string): Promise<AnswerEntry[]> {
  const normalizedQuestion = question.normalizedLabel;
  const existing = entries.find((entry) => entry.normalizedQuestion === normalizedQuestion);
  if (existing) {
    existing.answer = answer;
    existing.answerType = question.type;
    existing.source = "manual+curated";
  } else {
    entries.push({
      id: slugFromQuestion(question.label),
      question: question.label,
      normalizedQuestion,
      answer,
      answerType: question.type === "unknown" ? inferAnswerType(answer) : question.type,
      source: "manual+curated",
      matchers: [normalizedQuestion],
    });
  }
  await writeJson(ANSWERS_JSON_PATH, entries);
  await syncAnswersMarkdown(entries);
  return entries;
}

export async function syncAnswersMarkdown(entries: AnswerEntry[]): Promise<void> {
  const lines = ["# Q&A", "", "Generated from the seed Q&A file plus learned answers.", ""];
  for (const entry of entries.sort((a, b) => a.question.localeCompare(b.question))) {
    lines.push(`## ${entry.question}`);
    lines.push(`- Answer: ${Array.isArray(entry.answer) ? entry.answer.join(", ") : String(entry.answer)}`);
    lines.push(`- Type: ${entry.answerType}`);
    lines.push(`- Source: ${entry.source}`);
    lines.push("");
  }
  await writeText(QA_MARKDOWN_PATH, lines.join("\n"));
}

