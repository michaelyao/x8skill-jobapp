import type { BrowserContext, Locator, Page } from "playwright";

export type AtsType = "workday" | "ashby" | "greenhouse" | "lever" | "unknown";

export interface JobListing {
  company: string;
  title: string;
  location: string;
  age: string;
  applyUrl: string;
  simplifyUrl?: string;
  sourceText?: string;
  id?: string; // short stable code from the consolidated CSV (e.g. "LKHZ")
  region?: string; // region bucket from the CSV (e.g. "1 - SF Bay Area")
  source?: string; // which site(s) the listing came from
}

export interface FilteredJob extends JobListing {
  usEligible: boolean;
  needsManualLocationReview: boolean;
}

export interface JobIdentity {
  company: string;
  title: string;
  location: string;
  normalizedApplyUrl: string;
  externalJobId: string; // the ATS's id for this LISTING
  atsType: AtsType;
  identityKey: string;
  /**
   * The employer's own requisition id (Workday "R73630", Samsara "JR11987") when it can
   * be found. This identifies the JOB rather than the listing, so it is the only signal
   * that catches the same opening posted through two different ATS. Often only visible
   * once the posting is open, so it is filled in later via withRequisitionId().
   */
  companyReqId?: string;
}



export interface ProfileData {
  rawText: string;
  firstName?: string;
  lastName?: string;
  email?: string;
  loginEmail?: string;
  loginPassword?: string;
  phone?: string;
  linkedin?: string;
  github?: string;
  gpa?: string;
  school?: string;
  westCoastAddress?: string;
  eastCoastAddress?: string;
  schoolAddress?: string;
  citizenshipAnswer?: string;
  sponsorshipAnswer?: string;
  resumeText?: string;
  preferredResumePath?: string;
}

export type AnswerType = "text" | "textarea" | "single_select" | "multi_select" | "checkbox" | "radio" | "date" | "unknown";

export interface AnswerEntry {
  id: string;
  question: string;
  normalizedQuestion: string;
  answer: string | string[] | boolean;
  answerType: AnswerType;
  source: "seed" | "manual" | "manual+curated";
  matchers: string[];
}

export interface FormQuestion {
  label: string;
  normalizedLabel: string;
  type: AnswerType;
  required: boolean;
  options: string[];
  locatorDescription: string;
}

export interface LearningEvent {
  company: string;
  title: string;
  site: AtsType;
  pageUrl: string;
  question: FormQuestion;
}

export interface FillContext {
  browserContext: BrowserContext;
  page: Page;
  job: JobListing;
  identity: JobIdentity;
  profile: ProfileData;
  answers: AnswerEntry[];
  runDir: string;
  resumePath?: string; // resume file to upload (tailored per job, or the standard one)
}

export interface FillResult {
  filled: string[];
  skipped: string[];
  unknownQuestions: FormQuestion[];
  alreadyApplied: boolean;
  reachedReview: boolean;
}

export interface Adapter {
  readonly type: AtsType;
  detect(page: Page): Promise<boolean>;
  fill(context: FillContext): Promise<FillResult>;
}

export interface QuestionCandidate {
  label: string;
  type: AnswerType;
  required: boolean;
  options: string[];
  control: Locator;
  root?: Locator;
}

export interface RunSummaryItem {
  company: string;
  title: string;
  applyUrl: string;
  outcome: string;
  notes: string[];
}

/**
 * A persistent, cross-run record of a job we engaged with. Stored in
 * data/applications.json (one entry per job, upserted by `id`) plus a
 * per-application folder under data/applications/<id>/ holding the job
 * description and the exact fields we filled.
 *
 * NOTE: the tool never clicks final submit, so `status` reflects how far we
 * got — "prefilled_pending_submit" means the form is ready for you to review
 * and submit manually.
 */
/**
 * A suspected duplicate of an application we already have. Lived in reviewEmail.ts until the
 * review email was removed; it is shown on the website's review page now.
 */
export interface DuplicateWarning {
  confidence: number; // 0..1
  basis: string;
  otherCode?: string;
  otherUrl?: string;
  otherStatus?: string;
}

export interface ApplicationRecord {
  id: string; // stable identity key (from JobIdentity.identityKey)
  code?: string; // short CSV code (e.g. "LKHZ") for cross-referencing the list
  company: string;
  title: string;
  location?: string;
  region?: string;
  applyUrl: string;
  ats: AtsType;
  externalJobId?: string; // the ATS's id for the listing
  companyReqId?: string; // the employer's own requisition id — matches across ATS
  /**
   * The description text is NOT stored inline in the ledger — it lives in this file, next
   * to the application, and is loaded on demand. Inline copies meant rewriting the entire
   * ledger after every job (~81 GB of writes across a 2000-job run).
   */
  jobDescriptionFile?: string;
  jobDescriptionChars?: number; // so a glance at the ledger shows whether text was captured
  /** Structured answers, exactly what the review email showed. Kept in the per-application
   *  record and the x8note note; stripped from the ledger to keep it metadata-only.
   *  Structural rather than importing FilledAnswer — agent/types.ts imports this file. */
  answers?: Array<{ label: string; value: string; draft?: boolean }>;
  duplicateWarning?: {
    confidence: number;
    basis: string;
    otherCode?: string;
    otherUrl?: string;
    otherStatus?: string;
  };
  x8noteId?: string; // the note this application is stored in
  status:
    | "prefilled_pending_submit"
    | "submitted"
    /** Filled and submitted BY HAND on the ATS. A real application — see approvalQueue's
     *  PendingStatus for why this is not a skip. */
    | "manual_submitted"
    | "already_applied_on_site"
    | "skipped_existing"
    | "unsupported_ats"
    | "expired"
    | "error";
  firstSeenAt: string; // ISO — when we first engaged this job
  updatedAt: string; // ISO — most recent run that touched it
  lastRunDir: string;
  jobDescription: string;
  filledFields: string[]; // "label: value" pairs we entered (the application answers)
  unknownQuestions: string[]; // labels we could not answer automatically
  resumeName?: string; // file name of the resume uploaded
  resumeStandard?: boolean; // true → standard resume (name only); false → tailored
  resumeContent?: string; // inlined text of a tailored resume (when available)
  notes: string[];
}
