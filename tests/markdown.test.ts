import { describe, expect, it } from "vitest";
import {
  noteBody,
  parseDiaryEntries,
  prependMarkdownSectionLine,
  readMarkdownSection,
  setMarkdownSection,
} from "../src/utils/markdown";

const projectNote = `---
type: gtd-project
id: 01KTEST
title: Heat pump
---

# Heat pump

## Desired outcome

The replacement is ordered.

## Notes

Keep this note.
`;

describe("Markdown workflow helpers", () => {
  it("reads and replaces a Project section without changing its neighbours", () => {
    expect(readMarkdownSection(projectNote, "Desired outcome")).toBe("The replacement is ordered.");

    const updated = setMarkdownSection(projectNote, "Desired outcome", "The replacement is installed.");
    expect(readMarkdownSection(updated, "Desired outcome")).toBe("The replacement is installed.");
    expect(readMarkdownSection(updated, "Notes")).toBe("Keep this note.");
  });

  it("appends a missing section", () => {
    const updated = setMarkdownSection("# Project\n", "Desired outcome", "A clear result");
    expect(updated).toContain("## Desired outcome\n\nA clear result");
  });

  it("prepends and parses Project diary entries", () => {
    let updated = prependMarkdownSectionLine(projectNote, "Diary", "- **2026-09-18 11:30** — 🚀 great progress");
    updated = prependMarkdownSectionLine(updated, "Diary", "- **2026-09-18 11:31** — Chose an installer");

    expect(parseDiaryEntries(updated)).toEqual([
      { timestamp: "2026-09-18 11:31", text: "Chose an installer" },
      { timestamp: "2026-09-18 11:30", text: "🚀 great progress" },
    ]);
  });

  it("extracts an Inbox Item body without generated metadata or heading", () => {
    const note = `---\ntype: gtd-inbox-item\ntitle: Compare offers\n---\n\n# Compare offers\n\nCall Alex first.\n`;
    expect(noteBody(note, "Compare offers")).toBe("Call Alex first.");
  });
});
