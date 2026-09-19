import { describe, expect, it } from "vitest";
import { parseSubprojectList } from "../src/domain/project-import";

describe("pasted sub-project lists", () => {
  it("reads titles, tags, and completed checkboxes", () => {
    expect(parseSubprojectList(`- [ ] Research suppliers #planning #Home
- [x] Choose a supplier #Home
Write rollout plan`)).toEqual([
      { title: "Research suppliers", tags: ["planning", "Home"], done: false },
      { title: "Choose a supplier", tags: ["Home"], done: true },
      { title: "Write rollout plan", tags: [], done: false },
    ]);
  });

  it("accepts numbered lists and preserves URL fragments", () => {
    expect(parseSubprojectList("1. Read https://example.com/docs#setup #research\n2) Implement it")).toEqual([
      { title: "Read https://example.com/docs#setup", tags: ["research"], done: false },
      { title: "Implement it", tags: [], done: false },
    ]);
  });

  it("skips blank lines and lines containing only tags", () => {
    expect(parseSubprojectList("\n- #planning #home\n- Actual project")).toEqual([
      { title: "Actual project", tags: [], done: false },
    ]);
  });
});
