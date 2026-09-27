import { describe, expect, it } from "vitest";
import { VIEW_LINK_NAMES, parseViewLink, viewLink, viewLinkName } from "../src/domain/view-links";

describe("Links to Dragonglass views", () => {
  it("reads the view a Dragonglass link names", () => {
    expect(parseViewLink("obsidian://dragonglass?view=inbox")).toEqual({ view: "inbox" });
    expect(parseViewLink("obsidian://dragonglass/?view=board&vault=Work")).toEqual({ view: "board" });
    expect(parseViewLink("obsidian://Dragonglass")).toEqual({ view: "" });
  });

  it("leaves other links alone", () => {
    expect(parseViewLink("obsidian://open?vault=Work&file=Note")).toBeNull();
    expect(parseViewLink("https://dragonglass?view=inbox")).toBeNull();
    expect(parseViewLink("not a url")).toBeNull();
  });

  it("knows every view by name, however it is written", () => {
    expect(viewLinkName(" Inbox ")).toBe("inbox");
    expect(viewLinkName("checklists")).toBe("checklists");
    expect(viewLinkName("calendar")).toBeNull();
    expect(viewLinkName(undefined)).toBeNull();
  });

  it("writes links it can read back", () => {
    for (const name of VIEW_LINK_NAMES) expect(viewLinkName(parseViewLink(viewLink(name))?.view)).toBe(name);
  });
});
