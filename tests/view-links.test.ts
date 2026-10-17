import { describe, expect, it } from "vitest";
import { CAPTURE_TITLE_LENGTH, VIEW_LINK_NAMES, captureRequest, parseViewLink, viewLink, viewLinkName } from "../src/domain/view-links";

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

describe("Capture links", () => {
  it("reads a capture from a link clicked in a view", () => {
    expect(parseViewLink("obsidian://dragonglass?capture=Call%20the%20dentist")).toEqual({ view: "", capture: "Call the dentist" });
    expect(parseViewLink("obsidian://dragonglass?capture")).toEqual({ view: "", capture: "" });
  });

  it("opens the dialog for a bare capture and files any text straight away", () => {
    expect(captureRequest(undefined)).toBeNull();
    expect(captureRequest("")).toEqual({ kind: "dialog" });
    expect(captureRequest("true")).toEqual({ kind: "dialog" });
    expect(captureRequest("  Call the dentist ")).toEqual({ kind: "file", title: "Call the dentist", details: "" });
  });

  it("titles the Item by its first line and keeps the rest as notes", () => {
    expect(captureRequest("Buy paint\r\nwhite, matt\n2 litres")).toEqual({ kind: "file", title: "Buy paint", details: "white, matt\n2 litres" });
  });

  it("cuts a long dictated title at a word and keeps the whole text", () => {
    const text = "Remember to ask Sam about the venue booking for the offsite next spring and whether the catering can handle vegan options too";
    const capture = captureRequest(text);
    expect(capture).toMatchObject({ kind: "file", details: text });
    const title = capture?.kind === "file" ? capture.title : "";
    expect(title.length).toBeLessThanOrEqual(CAPTURE_TITLE_LENGTH);
    expect(title.endsWith("…")).toBe(true);
    // Cut between words: the text goes on with a space where the title stops.
    expect(text.startsWith(`${title.slice(0, -1)} `)).toBe(true);
  });
});
