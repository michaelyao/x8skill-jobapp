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
  /**
   * The heading path this field sits under — "My Information / Phone", "My Information / Address".
   *
   * Workday's page is h3 for the step and h4 for each group, and the same words appear in more
   * than one group: "Country / Territory" is in Address and "Country / Territory Phone Code" is in
   * Phone. Read without that context they are one label away from each other, which is how a
   * dialling code nearly went into the country field.
   *
   * Kept SEPARATE from `label` on purpose. The label is what the answer store matches on and what
   * compareToApproved uses to decide whether an approved application still matches the form;
   * renaming every field would make every queued application look like it had drifted and hold
   * them all for re-approval. This is context, not identity.
   */
  section?: string;
  /** Checkbox groups: every option of one question shares a groupKey. The GROUP can be
   *  required ("Please check one of the boxes below:*") while no individual box is, so the
   *  gate has to check the group, not the boxes. */
  groupKey?: string;
  groupLabel?: string;
  groupRequired?: boolean;
  filled?: boolean; // does the control currently hold a value? (undefined = couldn't tell)
  /**
   * WHAT it currently holds, when the control will say.
   *
   * `filled` alone was not enough. A prefilled field is left as it is — right, for a dialling code
   * the tenant derived — but nothing was then RECORDED for it, and the readiness gate builds its
   * "answered" set from the recorded answers. So Michelin reached Review and was refused with "3
   * field(s) the form marks REQUIRED have no answer: How Did You Hear About Us?, Degree, Do you
   * have friends or relatives…" — two of which the form was holding correctly. The review the
   * candidate reads should show what the form says, not what this run happened to type.
   */
  value?: string;
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
  /**
   * The records that DECIDE a work-authorisation answer, carried so the fill can use them.
   *
   * The tenant may spell this question as sentences ("I am authorized to work in the United
   * States for any employer") rather than Yes/No, and the options are often unknown when the
   * answer is chosen — read-time capture finds none and the fill discovers five. So the decision
   * cannot be made here; the facts that decide it travel to where the options are.
   */
  records?: { authorized?: boolean; needsSponsorship?: boolean };
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

/**
 * Which documents went in, and which the form asked for but did not get. read() excludes file
 * inputs, so a missing REQUIRED upload is invisible to every field-level check — this is the only
 * place it can be reported from.
 */
export interface DocumentUploads {
  /** "resume" | "transcript" */
  attached: string[];
  /** Human-readable reasons, one per document the form wanted and did not get. */
  missing: string[];
}

/**
 * What a repeatable-history fill actually achieved. `expected` comes from the resume and
 * `committed` from the form, so the two can be compared — an application carrying one of seven
 * roles is a failure even though every field on screen looks filled.
 */
export interface HistoryOutcome {
  educationExpected: number;
  educationCommitted: number;
  experienceExpected: number;
  experienceCommitted: number;
  /** Anything that did not go in, in the form's own terms. */
  problems: string[];
  /** Dates and the like that were inferred rather than stated, for the reviewer to see. */
  derived: string[];
  /**
   * What actually went into the repeatable sections, as label/value pairs.
   *
   * These are committed to the form and then vanish from the DOM, so without recording them here
   * the work history is invisible to the review page, to every fact check, and to
   * compareToApproved at submit. A section nobody records is a section nobody can check.
   */
  entries: Array<{ label: string; value: string }>;
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
  /** Is the page a submission confirmation? See GenericDriver.submissionConfirmed. */
  submissionConfirmed?(root: Root): Promise<boolean>;
  /** Attach the resume; true only if a file was actually set this call. */
  /** Attach every document the form asks for. See DocumentUploads. */
  uploadDocuments(root: Root, resumePath: string): Promise<DocumentUploads>;
  /**
   * Delete skills the resume autofill added that the curated plan says do not belong.
   * Returns the labels confirmed gone. Optional: only forms with a skills taxonomy have
   * anything to prune.
   */
  pruneSkills?(root: Root): Promise<string[]>;
  /** Delete duplicate committed profile entries (Workable). See WorkableDriver. */
  pruneDuplicateEntries?(root: Root): Promise<string[]>;
  /** Diagnose a control that would not take a value, from the live page. See GenericDriver. */
  studyFailedField?(
    root: Root,
    field: FieldSpec,
    context: { ats: string; code?: string; runDir?: string },
  ): Promise<string>;
  /** The remedy the last study chose, from a fixed set. See fieldStudy.REMEDIES. */
  lastRemedy?: string;
  /**
   * Perform one of those remedies. The model chooses WHICH; the driver owns the action, and the
   * re-fill that follows is what decides whether it worked.
   */
  applyRemedy?(root: Root, field: FieldSpec, remedy: string): Promise<boolean>;
  /** A remedy already known to work for this field on this ATS, from data/field-notes.json. */
  knownRemedy?(ats: string, label: string): Promise<string | undefined>;
  /** Record whether a remedy recovered the field, so the note is worth reading next time. */
  recordRemedyOutcome?(ats: string, label: string, remedy: string, worked: boolean): Promise<void>;
  /** Click a repeated section's "Add" until it holds `wanted` rows. See WorkdayDriver. */
  expandRepeatedBlocks?(root: Root, wanted: number): Promise<{ section: string; from: number; to: number }[]>;
  /**
   * WHICH PAGE ARE WE ON? Asked, not inferred.
   *
   * The turn loop counted fields and inferred the rest, which is how a rejected page carrying two
   * extra validation fields passed as a page that had turned, and how a run filled My Information
   * three times over. Workday prints "step 3 of 8 — My Experience" on screen; there is no need to
   * guess at it.
   */
  pageLabel?(root: Root): Promise<string>;
  /**
   * Fields the DRIVER fills from its own curated knowledge, with no answer from the agent.
   *
   * A skills taxonomy is the case: skill.txt says that "Python" means eight separate rows, and no
   * answer string can express that. The turn loop skips a field with no value, so the plan never
   * ran — and papering over it with a placeholder answer was worse, because the filler typed the
   * placeholder into the taxonomy and was offered "Skill Development". Declaring ownership is the
   * honest version: no value changes hands, and nothing can be typed by accident.
   */
  fillsWithoutAnswer?(field: FieldSpec): boolean;
  /** Does the PAGE show a resume already attached? Asked when this run did not upload one. */
  hasResumeOnPage?(root: Root, fileName: string): Promise<boolean>;
  /**
   * Fill repeatable Education / Experience sections, which are not ordinary fields: each entry is
   * an editing panel that must be COMMITTED with its own Update button before the next can be
   * added, and the fields vanish from the DOM once committed. The generic reader cannot see that
   * shape at all — it saw one blank entry, filled it, never committed it, and never added the
   * other six roles.
   *
   * Content comes from the resume rather than the LLM: education and work history are facts, and
   * a per-role Summary wants THAT role's bullet points, not a general candidate blurb.
   *
   * Optional: only forms with repeatable history sections have anything to do here.
   */
  fillHistorySections?(root: Root, ctx: AgentContext): Promise<HistoryOutcome>;
  /** Advance to the next page/turn. Returns false if there is no next control. */
  next(root: Root): Promise<boolean>;
  /**
   * Click the final Submit control. ONLY ever called after explicit per-job
   * human confirmation in the terminal — never automatically.
   */
  submit(root: Root): Promise<boolean>;
}
