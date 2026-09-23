import { describe, expect, it } from "vitest";
import { parseActionList } from "../src/domain/action-import";

const pasted = `- [ ] Bitbirds - Projektstartplan PR ins Handbook #Laptop #Work 
- [ ] Sprint Meeting Checklist ins [Handbuch-Repo](https://github.com/bitbirds-berlin/handbook) kopieren #Obsidian #Work #Laptop
- [ ] Brainstorming: Handbook Was sollte drinstehen? #Anywhere #Work
- [ ] Try to create a link from one file in the repo to another #Laptop
- [ ] PR mit offenen Fragen ins Handbook #Laptop #Work`;

describe("pasted Action lists", () => {
  it("reads titles and contexts from a checklist, #Work being a tag like any other", () => {
    expect(parseActionList(pasted)).toEqual([
      { title: "Bitbirds - Projektstartplan PR ins Handbook", contexts: ["Laptop", "Work"], done: false },
      {
        title: "Sprint Meeting Checklist ins [Handbuch-Repo](https://github.com/bitbirds-berlin/handbook) kopieren",
        contexts: ["Obsidian", "Work", "Laptop"],
        done: false,
      },
      { title: "Brainstorming: Handbook Was sollte drinstehen?", contexts: ["Anywhere", "Work"], done: false },
      { title: "Try to create a link from one file in the repo to another", contexts: ["Laptop"], done: false },
      { title: "PR mit offenen Fragen ins Handbook", contexts: ["Laptop", "Work"], done: false },
    ]);
  });

  it("keeps a URL fragment out of the contexts", () => {
    expect(parseActionList("- [ ] Read https://example.com/docs#setup #Laptop")).toEqual([
      { title: "Read https://example.com/docs#setup", contexts: ["Laptop"], done: false },
    ]);
  });

  it("accepts plain lines and marks checked items done", () => {
    expect(parseActionList("Call the installer\n- [x] Already sent the mail #work\n\n   \n* Third item")).toEqual([
      { title: "Call the installer", contexts: [], done: false },
      { title: "Already sent the mail", contexts: ["work"], done: true },
      { title: "Third item", contexts: [], done: false },
    ]);
  });

  it("skips lines that hold nothing but tags", () => {
    expect(parseActionList("- [ ] #Work\n- [ ] Real one")).toEqual([
      { title: "Real one", contexts: [], done: false },
    ]);
  });
});
