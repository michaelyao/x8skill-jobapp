/**
 * IS THIS PAGE STILL IN ENGLISH?
 *
 * `workdayEnglishUrl` rewrites a /fr-CA/ URL before we load it, because a French form misses the
 * answer store on every label and filling it is worse than failing. Nothing checked whether the
 * page STAYED English once loaded — and on 2026-09-03 it did not: the option-capture scan opened
 * Michelin's header language picker (a button with aria-haspopup="listbox", indistinguishable from
 * a prompt) and committed a selection, so the application turned Thai. The run then filled fifteen
 * fields against labels like "คุณได้รับทราบข่าวเกี่ยวกับเราได้อย่างไร", matched nothing, and put
 * "LinkedIn" into "How did you hear about us".
 *
 * The test is script, not vocabulary: a Workday form in English is overwhelmingly Latin letters,
 * and a form in Thai, Japanese, Chinese, Korean, Arabic, Hebrew, Greek or Cyrillic is
 * overwhelmingly not. That distinguishes the case that matters — a page we cannot read at all —
 * without pretending to detect French, which shares the alphabet and is caught by the URL rewrite.
 */
export interface LanguageVerdict {
  readable: boolean;
  /** The share of letters that are Latin, for the message. */
  latinShare: number;
  sample: string;
}

const NON_LATIN =
  /[฀-๿぀-ヿ㐀-䶿一-鿿가-힯؀-ۿ֐-׿Ͱ-ϿЀ-ӿ]/u;

export function judgePageLanguage(text: string): LanguageVerdict {
  const letters = (text.match(/\p{L}/gu) ?? []).length;
  const sample = text.replace(/\s+/g, " ").trim().slice(0, 120);
  // Too little text to judge: a page still rendering is not a page in the wrong language.
  if (letters < 40) return { readable: true, latinShare: 1, sample };
  const latin = (text.match(/[a-zA-Z]/g) ?? []).length;
  const share = latin / letters;
  /**
   * 0.5 rather than something stricter. A genuinely English form carries the odd non-Latin
   * character — a candidate's name, a company's, a currency symbol — and refusing those would
   * stop good applications. A form in another script lands far below this: the Michelin capture
   * measured 0.06.
   */
  return { readable: share >= 0.5 || !NON_LATIN.test(text), latinShare: share, sample };
}
