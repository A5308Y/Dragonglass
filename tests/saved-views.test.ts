import { describe, expect, it } from "vitest";
import { parseSavedViewStore, startingSavedViews } from "../src/domain/saved-views";
import type { SavedView } from "../src/domain/types";

const view = (id: string): SavedView => ({
  id, name: id, filters: [], groupBy: "status", sort: { field: "due", direction: "asc" }, visibleColumns: null,
});
const defaults = () => [view("default-next")];

describe("the saved views file", () => {
  it("starts from the defaults, or from the views this device kept in its settings", () => {
    expect(startingSavedViews(null, null, defaults).views.map((entry) => entry.id)).toEqual(["default-next"]);
    expect(startingSavedViews(null, [view("mine")], defaults).views.map((entry) => entry.id)).toEqual(["mine"]);
  });

  it("adds only the kept views the file lacks, and keeps the file's version of the rest", () => {
    const file = { version: 1, views: [{ ...view("shared"), name: "Renamed on the phone" }] };
    const started = startingSavedViews(file, [view("shared"), view("only-here")], defaults);
    expect(started.views.map((entry) => entry.name)).toEqual(["Renamed on the phone", "only-here"]);
    // A file with views deleted down to none stays empty: no defaults come back.
    expect(startingSavedViews({ version: 1, views: [] }, null, defaults).views).toEqual([]);
  });

  it("reads a file without trusting it", () => {
    const parsed = parseSavedViewStore({
      views: [view("a"), view("a"), { id: "broken" }, null, { ...view("old"), filters: [{ kind: "work", value: true }] }],
    });
    expect(parsed.views.map((entry) => entry.id)).toEqual(["a", "old"]);
    expect(parsed.views[1]!.filters).toEqual([]);
    expect(parseSavedViewStore("garbage").views).toEqual([]);
  });
});
