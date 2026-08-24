import type { Frame, Page } from "playwright";
import type { AnswerEntry, AnswerType, ProfileData } from "../types.js";

/** A form field the reader found on the current page/turn. */
export interface FieldSpec {
  key: string; // stable handle for this field (e.g. automation id or index)
  label: string;
  type: AnswerType;
  required: boolean;
  options?: string[]; // for selects / radios / comboboxes
  help?: string; // nearby helper text, if any
  sensitive?: boolean; // legal/demographic/compensation — guarded
  widget?: "react-select" | "workday-select"; // custom combobox (click-open-pick), not a native control
  searchable?: boolean; // type-to-filter combobox → `options` is an async SAMPLE, not an allowlist
  /** Checkbox groups: every option of one question shares a groupKey. The GROUP can be
   *  required ("Please check one of the boxes below:*") while no individual box is, so the
   *  gate has to check the group, not the boxes. */
  groupKey?: string;
  groupLabel?: string;
  groupRequired?: boolean;
  filled?: boolean; // does the control currently hold a value? (undefined = couldn't tell)
}

/** What the reader returns each turn — the state the agent reasons over. */
export interface PageSnapshot {
  url: string;
  heading?: string;
  jobContext?: string; // job description or page context
  fields: FieldSpec[];
  submitReady: boolean; // the final Submit control is present → STOP, never click
  nextAvailable: boolean; // a next/continue/review control exists
}

/** A field we successfully filled — persisted so submission can replay it exactly. */
export interface FilledAnswer {
  label: string;
  type: AnswerType;
  value: string;
  widget?: FieldSpec["widget"];
  draft?: boolean;
}

/** One answer the agent produced for one field. */
export interface FieldAnswer {
  key: string;
  value: string; // for selects: the exact option label; checkbox: "Yes"/"No"
  confidence: number; // 0..1
  source: "llm" | "curated" | "profile";
  needsHuman?: boolean; // true → route to learning mode instead of auto-filling
  draft?: boolean; // true → LLM-drafted free-text (fill it, but flag for review)
  /** true → the correct answer IS empty (an optional field the candidate has nothing for,
   *  e.g. a phone extension they do not have). Distinct from needsHuman: it is answered,
   *  and must not be reported as "no answer available". */
  blank?: boolean;
  reasoning?: string;
}

/** Everything the agent grounds its answers on. */
export interface AgentContext {
  company: string;
  title: string;
  resumeText: string;
  profile: ProfileData;
  answers: AnswerEntry[]; // curated Q&A store
  jobDescription?: string;
  changeInstruction?: string; // user's emailed correction, applied on a re-fill
}

/** The LLM driver: turns a page snapshot + context into per-field answers. */
export interface Agent {
  decide(snapshot: PageSnapshot, ctx: AgentContext): Promise<FieldAnswer[]>;
}

/** A page or an iframe — the "root" a reader/filler operates on. */
export type Root = Page | Frame;

/**
 * Per-ATS driver: each vendor (Workday/Ashby/Greenhouse) implements how to read
 * the page, fill a field, and navigate. The generic turn loop orchestrates these
 * with the Agent.
 */
export interface AtsDriver {
  readonly type: "workday" | "ashby" | "greenhouse" | "lever" | "workable" | "oracle";
  detect(page: Page): Promise<boolean>;
  /** Resolve the root to operate on (the page, or an embedded application iframe). */
  resolveRoot(page: Page): Promise<Root>;
  /** Open the application form if it's behind an Apply button. */
  openApplication(page: Page): Promise<void>;
  isAlreadyApplied(root: Root): Promise<boolean>;
  read(root: Root): Promise<PageSnapshot>;
  fill(root: Root, field: FieldSpec, answer: FieldAnswer): Promise<boolean>;
  /** Validation messages the form itself is showing (why it refuses to advance). */
  validationErrors?(root: Root): Promise<string[]>;
  /** Attach the resume; true only if a file was actually set this call. */
  uploadDocuments(root: Root, resumePath: string): Promise<boolean>;
  /**
   * Delete skills the resume autofill added that the curated plan says do not belong.
   * Returns the labels confirmed gone. Optional: only forms with a skills taxonomy have
   * anything to prune.
   */
  pruneSkills?(root: Root): Promise<string[]>;
  /** Advance to the next page/turn. Returns false if there is no next control. */
  next(root: Root): Promise<boolean>;
  /**
   * Click the final Submit control. ONLY ever called after explicit per-job
   * human confirmation in the terminal — never automatically.
   */
  submit(root: Root): Promise<boolean>;
}
