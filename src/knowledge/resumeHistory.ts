/**
 * Structured education and work history, parsed out of the plain-text resume.
 *
 * These sections are FACTS, so they come from the resume rather than from the LLM. The agent was
 * filling a Workable experience entry's per-role Summary with a generic candidate blurb ("CS
 * undergraduate at Carnegie Mellon…") because all it had was a label and a pile of resume text;
 * the field wants that role's own bullet points, which only structure can give it.
 *
 * A pure function over text, so it is testable: npm run test:history.
 */

export interface EducationEntry {
  school: string;
  degree: string;
  fieldOfStudy: string;
  gpa?: string;
  /** MM/YYYY */
  startDate?: string;
  endDate?: string;
  /** True when the resume says "Expected"/"Present" rather than a finished date. */
  current: boolean;
  /** Set when a date was DERIVED rather than stated — surfaced so a reviewer can see it. */
  derived?: string[];
}

export interface ExperienceEntry {
  company: string;
  title: string;
  location?: string;
  /** The role's own bullet points, joined — this is what a per-role Summary field wants. */
  summary: string;
  startDate?: string;
  endDate?: string;
  current: boolean;
}

const MONTHS: Record<string, string> = {
  jan: "01", feb: "02", mar: "03", apr: "04", may: "05", jun: "06",
  jul: "07", aug: "08", sep: "09", sept: "09", oct: "10", nov: "11", dec: "12",
};

/**
 * "Aug 2026" → "08/2026". A bare year has no month, and inventing one would be making up
 * precision the resume does not have — so `endOfYear` picks the convention: January for a start,
 * December for an end. Stated months always win.
 */
export function toMonthYear(text: string, endOfYear = false): string | undefined {
  const t = text.trim();
  const withMonth = t.match(/([A-Za-z]{3,9})\.?\s+(\d{4})/);
  if (withMonth) {
    const mm = MONTHS[withMonth[1].slice(0, 4).toLowerCase()] ?? MONTHS[withMonth[1].slice(0, 3).toLowerCase()];
    if (mm) return `${mm}/${withMonth[2]}`;
  }
  const yearOnly = t.match(/^(\d{4})$/);
  if (yearOnly) return `${endOfYear ? "12" : "01"}/${yearOnly[1]}`;
  return undefined;
}

/** "Aug 2026 - Present" / "Jun 2026 - Aug 2026" / "2023 - 2024" */
function parseRange(text: string): { startDate?: string; endDate?: string; current: boolean } {
  const parts = text.split(/\s*(?:-|–|—|to)\s*/i).map((p) => p.trim()).filter(Boolean);
  const current = /present|current|now/i.test(text);
  const startDate = parts[0] ? toMonthYear(parts[0], false) : undefined;
  const endDate = current || !parts[1] ? undefined : toMonthYear(parts[1], true);
  return { startDate, endDate, current };
}

/**
 * Both resume formats have to work, because loadProfile PREFERS the markdown one and the two are
 * not alike. The first version only understood the .txt and silently returned 0 education and 0
 * experience against the .md — the parse "succeeded" and the history sections stayed empty.
 *
 *   .txt   EDUCATION            under a ==== rule, ALL CAPS heading, "Employer -- Location"
 *   .md    ## Education         markdown heading, "### Employer — Location", **bold** markers
 *
 * So: strip decoration, and treat headings by LEVEL rather than by syntax.
 */
const plain = (line: string): string =>
  line.replace(/\*\*/g, "").replace(/^#{1,6}\s+/, "").replace(/\s+/g, " ").trim();

/**
 * 0 = not a heading. Markdown gives its own level; an ALL-CAPS line is the .txt equivalent of a
 * level-2 heading. Getting this right is what keeps "### Amazon — Seattle, WA" (level 3) INSIDE
 * the Work Experience section instead of ending it.
 */
function headingLevel(line: string): number {
  const raw = line.trim();
  if (/^=+$/.test(raw)) return 0; // a rule, not a heading
  const md = raw.match(/^(#{1,6})\s+/);
  if (md) return md[1].length;
  const stripped = plain(raw);
  if (stripped && stripped.length <= 40 && !/[a-z]/.test(stripped) && /[A-Z]/.test(stripped)) return 2;
  return 0;
}

/** The body of one section, by heading name, in either format. */
function section(text: string, heading: RegExp): string {
  const lines = text.split("\n");
  const start = lines.findIndex((l) => headingLevel(l) > 0 && heading.test(plain(l)));
  if (start < 0) return "";
  const level = headingLevel(lines[start]);
  const out: string[] = [];
  for (let i = start + 1; i < lines.length; i += 1) {
    const lvl = headingLevel(lines[i]);
    if (lvl > 0 && lvl <= level) break; // the next section of the same or higher rank
    if (/^=+$/.test(lines[i].trim())) continue; // .txt rule lines carry no content
    out.push(lines[i]);
  }
  return out.join("\n").trim();
}

/** Split "Employer -- Location" / "### Employer — Location" on whichever dash is the separator. */
const SEPARATOR = /\s+(?:--|—)\s+/;

export function parseEducation(resumeText: string): EducationEntry[] {
  const body = section(resumeText, /^EDUCATION$/i);
  if (!body) return [];
  const lines = body.split("\n").map((l) => plain(l)).filter(Boolean);

  // "Carnegie Mellon University -- Pittsburgh, PA" or "**Carnegie Mellon University** — Pittsburgh, PA"
  const head = lines.find((l) => SEPARATOR.test(l) && !l.startsWith("-"));
  if (!head) return [];
  const school = head.split(SEPARATOR)[0].trim();

  // "Major: B.S. in Information Systems | GPA: 3.53 | Expected May 2028"
  const detail = lines.find((l) => /major:|degree:|gpa:/i.test(l)) ?? "";
  const major = detail.match(/(?:major|degree):\s*([^|]+)/i)?.[1]?.trim() ?? "";
  const gpa = detail.match(/gpa:\s*([\d.]+)/i)?.[1];

  // "B.S. in Information Systems" splits into a degree and a field of study.
  const degreeMatch = major.match(/^((?:B\.?S\.?|B\.?A\.?|M\.?S\.?|Ph\.?D\.?|Bachelor[^,|]*|Master[^,|]*))\s*(?:in\s+|,\s*|of\s+)?(.*)$/i);
  const degreeRaw = (degreeMatch?.[1] ?? "").trim();
  const fieldOfStudy = (degreeMatch?.[2] ?? major).trim();
  const degree = /^b\.?s\.?$/i.test(degreeRaw)
    ? "Bachelor of Science"
    : /^b\.?a\.?$/i.test(degreeRaw)
      ? "Bachelor of Arts"
      : /^m\.?s\.?$/i.test(degreeRaw)
        ? "Master of Science"
        : degreeRaw;

  const expected = detail.match(/(?:expected|graduat\w*)[:\s]*([A-Za-z]{3,9}\.?\s+\d{4}|\d{4})/i)?.[1];
  const endDate = expected ? toMonthYear(expected, true) : undefined;

  const derived: string[] = [];
  let startDate: string | undefined;
  if (endDate) {
    // A start date is almost never printed on a resume, and these fields want one. Derive it from
    // the degree's normal length, counting back from the expected end to the academic year start
    // (August). It IS an inference, so it is recorded in `derived` and shown in review rather than
    // presented as something the resume said.
    const years = /master/i.test(degree) ? 2 : /ph/i.test(degree) ? 5 : 4;
    const endYear = Number(endDate.split("/")[1]);
    startDate = `08/${endYear - years}`;
    derived.push(`start date ${startDate} derived from a ${years}-year ${degree || "degree"} ending ${endDate}`);
  }

  return [{ school, degree, fieldOfStudy, gpa, startDate, endDate, current: Boolean(expected), derived }];
}

export function parseExperience(resumeText: string): ExperienceEntry[] {
  const body = section(resumeText, /^WORK EXPERIENCE$|^EXPERIENCE$/i);
  if (!body) return [];

  const lines = body.split("\n");
  const entries: ExperienceEntry[] = [];
  let current: ExperienceEntry | null = null;
  let bullets: string[] = [];

  const flush = () => {
    if (current) {
      current.summary = bullets.join(" ").replace(/\s+/g, " ").trim();
      entries.push(current);
    }
    current = null;
    bullets = [];
  };

  for (let i = 0; i < lines.length; i += 1) {
    const line = plain(lines[i]);
    if (!line) continue;

    // A header line is "Employer -- Location" / "### Employer — Location" and is never a bullet.
    if (SEPARATOR.test(line) && !line.startsWith("-")) {
      flush();
      const [company, location] = line.split(SEPARATOR);
      // The title/date line follows, possibly wrapped onto the next line.
      let titleLine = plain(lines[i + 1] ?? "");
      if (titleLine && !titleLine.includes("|") && plain(lines[i + 2] ?? "").startsWith("|")) {
        titleLine = `${titleLine} ${plain(lines[i + 2] ?? "")}`;
      }
      const [titlePart, datePart] = titleLine.split("|").map((p) => (p ?? "").trim());
      const range = datePart ? parseRange(datePart) : { current: false };
      current = {
        company: company.trim(),
        title: (titlePart ?? "").trim(),
        location: (location ?? "").trim() || undefined,
        summary: "",
        ...range,
      };
      continue;
    }

    // Bullet lines, including continuations of a wrapped bullet.
    if (line.startsWith("-")) {
      bullets.push(line.replace(/^-\s*/, ""));
    } else if (bullets.length && current) {
      bullets[bullets.length - 1] = `${bullets[bullets.length - 1]} ${line}`;
    }
  }
  flush();
  return entries.filter((e) => e.company && e.title);
}

export interface ResumeHistory {
  education: EducationEntry[];
  experience: ExperienceEntry[];
}

export function parseResumeHistory(resumeText: string): ResumeHistory {
  return { education: parseEducation(resumeText), experience: parseExperience(resumeText) };
}
