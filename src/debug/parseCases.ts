import { stripToJson } from "../agent/llmAgent.js";

const cases: Array<[string, string]> = [
  ["plain array", `[{"key":"a","value":"x"}]`],
  ["closed fence", "```json\n[{\"key\":\"a\",\"value\":\"x\"}]\n```"],
  ["prose then fence", "Here you go:\n```json\n[{\"key\":\"a\",\"value\":\"x\"}]\n```"],
  // the actual Aug-11 failure: opening fence, no closing fence, array never closed
  ["truncated mid-object", "```json\n[{\"key\":\"a\",\"value\":\"x\"},\n{\"key\":\"b\",\"value\":\"partial answ"],
  ["truncated after object", "```json\n[{\"key\":\"a\",\"value\":\"x\"},"],
  ["brace inside string", `[{"key":"a","value":"use {} and \\" quotes"},{"key":"b","value":"tr`],
  ["fence only, nothing else", "```json\n"],
];

for (const [name, raw] of cases) {
  const { json, repaired } = stripToJson(raw);
  let parsed: unknown = "PARSE FAILED";
  try {
    parsed = JSON.parse(json);
  } catch (e) {
    parsed = `PARSE FAILED: ${(e as Error).message}`;
  }
  console.log(`${name.padEnd(24)} repaired=${String(repaired).padEnd(5)} ${JSON.stringify(parsed)}`);
}
