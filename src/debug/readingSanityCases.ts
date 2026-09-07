import {
  describeDoubts,
  doubtsAboutField,
  doubtsAboutPage,
  readerFaults,
  type ReadingDoubt,
} from "../core/readingSanity.js";
import type { FieldSpec } from "../agent/types.js";

/**
 * Cases for "does this reading of the page hold together?".  npm run test:reading
 *
 * His instruction is the specification: a dropdown labelled "How did you hear about us?" with no
 * options is not a page state, it is a broken reader, and the question at that moment is whether
 * something is wrong with the filler — not what to answer.
 *
 * MOST OF THESE CASES ARE THE QUIET ONES. A doubt that fires wrongly is worse than no doubt at all:
 * it would refuse to answer a field that was read perfectly well, and this system already stops too
 * easily. So every legitimate shape that LOOKS odd — a searchable taxonomy with no sample rows, a
 * yes/no pair, a bare "Month" that belongs to a date group — has a case here proving it stays quiet.
 */
let pass = 0;
let fail = 0;
const check = (name: string, cond: boolean, got?: unknown) => {
  if (cond) {
    pass += 1;
    console.log(`  ✓ ${name}`);
  } else {
    fail += 1;
    console.log(`  ✗ ${name}${got === undefined ? "" : ` — got ${JSON.stringify(got)}`}`);
  }
};

const field = (over: Partial<FieldSpec>): FieldSpec => ({
  key: "[id=x]",
  label: "",
  type: "text",
  required: false,
  ...over,
});

const faults = (d: ReadingDoubt[]) => d.filter((x) => x.severity === "reader-fault");
const odd = (d: ReadingDoubt[]) => d.filter((x) => x.severity === "suspicious");

console.log("the case he raised");
{
  // Verbatim from the Mastercard run: this is what reached the agent, and the agent answered it.
  const hearAbout = field({
    label: "How Did You Hear About Us?*",
    type: "single_select",
    required: true,
    widget: "workday-select",
    options: [],
  });
  const d = doubtsAboutField(hearAbout);
  check(`a dropdown with no options is a READER FAULT, not a question to answer`,
    faults(d).length === 1 && faults(d)[0]!.doubt.includes("no options"), d);
  check(`and it names the field so nothing answers from it`,
    readerFaults(d).join() === "How Did You Hear About Us?*");
  check(`the sentence says what a credible reading would look like`,
    describeDoubts(d)[0]!.includes("offers something to choose"), describeDoubts(d));
}

console.log("\nand the shapes that must NOT fire");
check(`a type-to-search taxonomy with no sample rows is expected, not wrong`,
  doubtsAboutField(field({
    label: "Field of Study*", type: "single_select", required: true, searchable: true, options: [],
  })).length === 0);
check(`a searchable list showing three sampled rows is fine`,
  doubtsAboutField(field({
    label: "Country*", type: "single_select", searchable: true, options: ["Afghanistan", "Albania", "Algeria"],
  })).length === 0);
check(`an ordinary yes/no pair is fine`,
  doubtsAboutField(field({ label: "Are you legally authorized to work?", type: "radio", options: ["Yes", "No"] })).length === 0);
check(`a text field with no options is not a choice control`,
  doubtsAboutField(field({ label: "First Name*", type: "text", required: true })).length === 0);
check(`a bare "Month" INSIDE a date group is fine — it has context`,
  doubtsAboutField(field({ label: "Month", type: "text", groupLabel: "start Date — From*" })).length === 0);
check(`a full country list does not look truncated`,
  doubtsAboutField(field({
    label: "Country*", type: "single_select",
    options: Array.from({ length: 250 }, (_, i) => `Country ${i}`),
  })).length === 0);

console.log("\nreadings that contradict themselves");
{
  // The CC-305 shape: each checkbox's own text became the question, so the label IS the option.
  const d = doubtsAboutField(field({
    label: "No, I do not have a disability and have not had one in the past",
    type: "radio",
    options: ["Yes, I have a disability, or have had one in the past", "No, I do not have a disability and have not had one in the past"],
  }));
  check(`a label that is also one of its own options is a reader fault`,
    faults(d).some((x) => x.doubt.includes("label is also one of its own options")), d);
}
check(`a required field with no label at all is a reader fault`,
  faults(doubtsAboutField(field({ label: "  ", type: "text", required: true }))).length === 1);
check(`a choice with exactly one option is suspicious, not fatal`,
  odd(doubtsAboutField(field({ label: "Gender", type: "single_select", options: ["Male"] }))).length === 1 &&
  faults(doubtsAboutField(field({ label: "Gender", type: "single_select", options: ["Male"] }))).length === 0);
check(`a bare sub-field name with NO group is suspicious`,
  odd(doubtsAboutField(field({ label: "State", type: "text" }))).length >= 1);
check(`a normally-long list showing four rows is suspicious`,
  odd(doubtsAboutField(field({
    label: "Country Phone Code*", type: "single_select",
    options: ["Afghanistan (+93)", "Albania (+355)", "Algeria (+213)", "Andorra (+376)"],
  }))).length === 1);

console.log("\nfalse alarms found by running it against real pages");
// Both of these fired on live Workday forms within minutes of the rules going in. A rule that
// cries wolf on a correct reading costs more than the one it catches, because the reaction to a
// doubt is to distrust the field.
check(`Degree offering nine rows is the WHOLE list, not the top of one`,
  doubtsAboutField(field({
    label: "Degree", type: "single_select",
    options: ["Bachelors", "Masters", "Doctorate", "Associates", "High School", "MBA", "JD", "MD", "Other"],
  })).length === 0);
// My first expectation here was wrong and the code was right. A list whose only row is "No Items."
// has offered nothing, so "a dropdown with no options" is the truthful reading — not "a choice
// between one thing", which is what it said before placeholders were filtered.
check(`"No Items." is not an option — the control has offered NOTHING`,
  faults(doubtsAboutField(field({ label: "Type to Add Skills", type: "multi_select", options: ["No Items."] })))
    .some((d) => d.doubt.includes("no options")));
check(`and it stops saying "a choice between one thing"`,
  odd(doubtsAboutField(field({ label: "Type to Add Skills", type: "multi_select", options: ["No Items."] })))
    .every((d) => !d.doubt.includes("only one option")));
// The same control marked searchable is a typeahead that has not been typed into yet, and quiet.
check(`a searchable typeahead showing "No Items." is expected`,
  doubtsAboutField(field({
    label: "Type to Add Skills", type: "multi_select", searchable: true, options: ["No Items."],
  })).length === 0);
check(`"Select One" is not an option either`,
  doubtsAboutField(field({ label: "Gender", type: "single_select", options: ["Select One"] }))
    .some((d) => d.doubt.includes("no options")));
check(`but a real two-way choice with a placeholder in front is fine`,
  doubtsAboutField(field({ label: "Gender", type: "single_select", options: ["Select One", "Male", "Female"] })).length === 0);
// The taxonomy chooser: two rows that are both navigation, correctly flagged as odd.
check(`Field of Study showing two rows is still suspicious`,
  doubtsAboutField(field({
    label: "Education — Field of Study", type: "single_select",
    options: ["Partial List (First 500 Entries)", "All"],
  })).some((d) => d.doubt.includes("normally long")));

console.log("\ndoubts only the whole page can see");
{
  // CLAUDE.md's unresolved Workday bug: City and Postal Code filled, State never touched, and
  // Motorola rejected an application because the postcode did not match the state.
  const d = doubtsAboutPage([
    field({ label: "Address Line 1*", required: true }),
    field({ label: "City*", required: true }),
    field({ label: "Postal Code*", required: true }),
  ]);
  check(`city + postal code with no state is flagged`,
    odd(d).some((x) => x.doubt.includes("no state")), d);
}
check(`the same address WITH a state is quiet`,
  doubtsAboutPage([
    field({ label: "City*" }), field({ label: "Postal Code*" }), field({ label: "State*" }),
  ]).length === 0);
check(`a page that read zero fields is suspicious`,
  odd(doubtsAboutPage([])).some((x) => x.doubt.includes("no fields at all")));
check(`a page with ordinary fields is quiet`,
  doubtsAboutPage([field({ label: "First Name*" }), field({ label: "Email*" })]).length === 0);

console.log(`\n${fail ? "✗" : "✓"} ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
