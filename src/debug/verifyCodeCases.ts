import { verificationCodeFrom } from "../knowledge/oracleVerify.js";

/**
 * Cases for the one-time-code extractor.  npm run test:verifycode
 *
 * Fetching the mail is the easy half. The half that can do damage is choosing WHICH number in it
 * is the code: a verification email is full of numbers that are not — a requisition id, a year, a
 * phone number, a ZIP, an unsubscribe id. A wrong code burns an attempt, and some tenants lock the
 * address after a few. Returning null is always recoverable (the caller keeps waiting); guessing
 * is not. So every "must not match" case below is as load-bearing as the ones that must.
 */
const CASES: Array<{ name: string; subject: string; body: string; want: string | null }> = [
  {
    name: "code stated after the anchor",
    subject: "Your verification code",
    body: "Hello Nathan,\n\nYour verification code is 483920.\n\nIt expires in 15 minutes.",
    want: "483920",
  },
  {
    name: "anchor with a colon",
    subject: "American Express Careers",
    body: "Access code: 728104\nUse this to continue your application.",
    want: "728104",
  },
  {
    name: "code before the anchor",
    subject: "",
    body: "552310 is your one-time passcode for your candidate profile.",
    want: "552310",
  },
  {
    name: "code alone on the next line",
    subject: "Verify your email",
    body: "Please enter the security code below:\n\n  907712\n\nThanks.",
    want: "907712",
  },
  {
    name: "code in the subject only",
    subject: "917245 is your verification code",
    body: "Someone requested access to your candidate account.",
    want: "917245",
  },
  {
    name: "four-digit PIN",
    subject: "Your PIN",
    body: "Your PIN is 4821 — enter it to continue.",
    want: "4821",
  },
  // ---- must NOT match ------------------------------------------------------------------
  {
    name: "a requisition id is not a code",
    subject: "Your application to American Express",
    body: "Thank you for applying to requisition 26011679. We will be in touch.",
    want: null,
  },
  {
    name: "a year next to the word code is still not a code",
    subject: "Code of conduct 2026",
    body: "Please review our code of conduct 2026 before continuing.",
    want: null,
  },
  {
    name: "a phone number is not a code",
    subject: "Welcome",
    body: "Questions? Call us at 800 528 4800 or visit our careers site.",
    want: null,
  },
  {
    name: "a repeated-digit placeholder is not a code",
    subject: "Your verification code",
    body: "Your verification code is 000000 (sample text).",
    want: null,
  },
  {
    name: "digits with no anchor at all",
    subject: "Application received",
    body: "Reference 88213345 has been logged for job 26011679 at 1290 Avenue of the Americas.",
    want: null,
  },
];

let pass = 0;
let fail = 0;
for (const c of CASES) {
  const got = verificationCodeFrom(c.subject, c.body);
  if (got === c.want) {
    pass += 1;
    console.log(`  ✓ ${c.name} → ${got ?? "null"}`);
  } else {
    fail += 1;
    console.log(`  ✗ ${c.name}\n      got ${got ?? "null"}, want ${c.want ?? "null"}`);
  }
}
console.log(`\n${fail ? "✗" : "✓"} ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
