import { describe, expect, it } from "vitest";
import { parseActionList } from "../src/domain/action-import";

const pasted = `- [ ] Garden - Draft the planting plan for spring #Laptop #Work 
- [ ] Copy the watering checklist into the [Garden notes](https://example.com/garden/notes) #Obsidian #Work #Laptop
- [ ] Brainstorming: Which beds need new soil? #Anywhere #Work
- [ ] Try to create a link from one note to another #Laptop
- [ ] Send the open questions to the allotment group #Laptop #Work`;

describe("pasted Action lists", () => {
  it("reads titles and contexts from a checklist, #Work being a tag like any other", () => {
    expect(parseActionList(pasted)).toEqual([
      { title: "Garden - Draft the planting plan for spring", contexts: ["Laptop", "Work"], done: false },
      {
        title: "Copy the watering checklist into the [Garden notes](https://example.com/garden/notes)",
        contexts: ["Obsidian", "Work", "Laptop"],
        done: false,
      },
      { title: "Brainstorming: Which beds need new soil?", contexts: ["Anywhere", "Work"], done: false },
      { title: "Try to create a link from one note to another", contexts: ["Laptop"], done: false },
      { title: "Send the open questions to the allotment group", contexts: ["Laptop", "Work"], done: false },
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
