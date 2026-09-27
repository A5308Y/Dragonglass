import { describe, expect, it } from "vitest";
import {
  checklistItems,
  dailyChecklistDue,
  emptyChecklistStore,
  finishRun,
  markItem,
  openRun,
  parseChecklist,
  parseChecklistStore,
  renameChecklist,
  repeatedlySkipped,
  startRun,
  type ChecklistStore,
} from "../src/domain/checklist";
import { localDate } from "../src/utils/date";

const note = [
  "---",
  "tags: [routine]",
  "---",
  "# Morning",
  "",
  "See [[Desk setup]] first.",
  "",
  "- [ ] Water the plants",
  "- [x] Check [[Backups]]",
  "    - [ ] Offsite copy",
  "    Look at the log in [[Backup log]].",
  "- [ ] Water the plants",
  "- plain bullet",
  "* [ ]",
  "",
  "## Evening",
  "1. [ ] Close   the windows",
].join("\n");

const items = [
  { key: "Water the plants", text: "Water the plants" },
  { key: "Check [[Backups]]", text: "Check [[Backups]]" },
];

const at = (time: string) => new Date(`2026-09-27T${time}:00`);

function run(store: ChecklistStore, id: string, day: string, skipped: string[]): ChecklistStore {
  let next = startRun(store, { id, path: "Daily.md", title: "Daily", items }, new Date(`${day}T08:00:00`));
  for (const key of skipped) next = markItem(next, id, key, "skipped", new Date(`${day}T08:01:00`));
  return finishRun(next, id, items, new Date(`${day}T08:05:00`));
}

describe("Reading a checklist note", () => {
  it("keeps the lines between items as Markdown and tells duplicate items apart", () => {
    expect(parseChecklist(note)).toEqual([
      { kind: "markdown", markdown: "# Morning\n\nSee [[Desk setup]] first." },
      { kind: "item", key: "Water the plants", text: "Water the plants", depth: 0 },
      { kind: "item", key: "Check [[Backups]]", text: "Check [[Backups]]", depth: 0 },
      { kind: "item", key: "Offsite copy", text: "Offsite copy", depth: 1 },
      { kind: "markdown", markdown: "Look at the log in [[Backup log]]." },
      { kind: "item", key: "Water the plants#2", text: "Water the plants", depth: 0 },
      { kind: "markdown", markdown: "- plain bullet\n* [ ]\n\n## Evening" },
      { kind: "item", key: "Close the windows", text: "Close the windows", depth: 0 },
    ]);
  });

  it("lists the items in order", () => {
    expect(checklistItems(parseChecklist(note)).map((item) => item.key)).toEqual([
      "Water the plants", "Check [[Backups]]", "Offsite copy", "Water the plants#2", "Close the windows",
    ]);
  });
});

describe("Checklist runs", () => {
  it("goes on with the run under way instead of starting a second one", () => {
    const first = startRun(emptyChecklistStore(), { id: "one", path: "Daily.md", title: "Daily", items }, at("08:00"));
    const second = startRun(first, { id: "two", path: "Daily.md", title: "Daily", items }, at("09:00"));
    expect(second.runs.map((each) => each.id)).toEqual(["one"]);
    expect(openRun(second, "Daily.md")?.id).toBe("one");
  });

  it("keeps the latest mark per item and records the items on finishing", () => {
    let store = startRun(emptyChecklistStore(), { id: "one", path: "Daily.md", title: "Daily", items: [] }, at("08:00"));
    store = markItem(store, "one", "Water the plants", "done", at("08:01"));
    store = markItem(store, "one", "Water the plants", "open", at("08:02"));
    store = finishRun(store, "one", items, at("08:05"));
    expect(store.runs[0]!.marks["Water the plants"]?.state).toBe("open");
    expect(store.runs[0]!.items).toEqual(items);
    expect(openRun(store, "Daily.md")).toBeUndefined();
  });

  it("is due every day until a run of the daily checklist is finished that day", () => {
    const today = localDate(at("12:00"));
    expect(dailyChecklistDue(emptyChecklistStore(), "Daily.md", today)).toBe(true);
    expect(dailyChecklistDue(emptyChecklistStore(), "", today)).toBe(false);
    const started = startRun(emptyChecklistStore(), { id: "one", path: "Daily.md", title: "Daily", items }, at("08:00"));
    expect(dailyChecklistDue(started, "Daily.md", today)).toBe(true);
    expect(dailyChecklistDue(finishRun(started, "one", items, at("08:05")), "Daily.md", today)).toBe(false);
    expect(dailyChecklistDue(run(emptyChecklistStore(), "old", "2026-09-26", []), "Daily.md", today)).toBe(true);
  });

  it("names items skipped in each of the last three runs that had them", () => {
    let store = emptyChecklistStore();
    store = run(store, "a", "2026-09-20", ["Water the plants", "Check [[Backups]]"]);
    store = run(store, "b", "2026-09-21", ["Water the plants"]);
    store = run(store, "c", "2026-09-22", ["Water the plants", "Check [[Backups]]"]);
    store = run(store, "d", "2026-09-23", ["Water the plants", "Check [[Backups]]"]);
    expect(repeatedlySkipped(store, "Daily.md", items)).toEqual(["Water the plants"]);
    expect(repeatedlySkipped(run(emptyChecklistStore(), "a", "2026-09-20", ["Water the plants"]), "Daily.md", items)).toEqual([]);
  });

  it("follows a renamed checklist note", () => {
    const store = renameChecklist(run(emptyChecklistStore(), "a", "2026-09-20", []), "Daily.md", "Routines/Morning.md", "Morning");
    expect(store.runs[0]).toMatchObject({ path: "Routines/Morning.md", title: "Morning" });
  });

  it("reads a store file without trusting it", () => {
    const parsed = parseChecklistStore({
      runs: [
        { id: "ok", path: "Daily.md", title: "Daily", startedAt: "2026-09-27T08:00:00.000Z", finishedAt: null, items: [{ key: "A", text: "A" }], marks: { A: { state: "done", at: "x" }, B: { state: "maybe" } } },
        { id: "no-path", startedAt: "2026-09-27T08:00:00.000Z" },
        "junk",
      ],
    });
    expect(parsed.runs).toHaveLength(1);
    expect(parsed.runs[0]!.marks).toEqual({ A: { state: "done", at: "x" } });
  });
});
