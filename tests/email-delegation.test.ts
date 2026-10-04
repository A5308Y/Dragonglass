import type { TFile } from "obsidian";
import { describe, expect, it } from "vitest";
import {
  delegatedActionFor, delegationBody, delegationKey, delegationKeyIn, delegationSubject, isEmailAddress, mailtoUrl,
  recentRecipients,
} from "../src/domain/email-delegation";
import type { Action } from "../src/domain/types";

const action = (id: string, changes: Partial<Action> = {}): Action => ({
  type: "gtd-action", id, title: "Book the plumber", file: { path: `${id}.md` } as TFile, status: "waiting", created: "2026-09-01",
  ...changes,
});

describe("Delegating an Action by email", () => {
  it("marks the subject with the end of the Action's id, and finds it again in a reply", () => {
    expect(delegationKey("01J9ZZZZZZZZZZZZZZABCDEFGH")).toBe("DG-ABCDEFGH");
    expect(delegationKeyIn("Re: AW: Book the plumber [dg-abcdefgh]")).toBe("DG-ABCDEFGH");
    expect(delegationKeyIn("Book the plumber")).toBeNull();
  });

  it("links a reply only to a delegated Action with that marker", () => {
    const delegated = action("01J9ZZZZZZZZZZZZZZABCDEFGH", { delegatedTo: "anna@example.com" });
    const other = action("01J9ZZZZZZZZZZZZZZABCDEFGH".replace("H", "J"), {});
    expect(delegatedActionFor("Re: Book [DG-ABCDEFGH]", [other, delegated])).toBe(delegated);
    expect(delegatedActionFor("Re: Book [DG-ABCDEFGJ]", [other, delegated])).toBeNull();
  });

  it("keeps the marker in an edited subject", () => {
    expect(delegationSubject("Plumber, please", "DG-ABCDEFGH")).toBe("Plumber, please [DG-ABCDEFGH]");
    expect(delegationSubject("[DG-ABCDEFGH] Plumber", "DG-ABCDEFGH")).toBe("[DG-ABCDEFGH] Plumber");
  });

  it("writes a message naming the Project and its desired outcome", () => {
    const body = delegationBody({ title: "Book the plumber", projectTitle: "Bathroom", desiredOutcome: "A working shower" });
    expect(body).toContain("Book the plumber\n\nIt is part of “Bathroom”.\nWhat we want in the end: A working shower");
    expect(delegationBody({ title: "Book the plumber" })).not.toContain("part of");
  });

  it("builds a mailto link with mail line breaks", () => {
    expect(mailtoUrl(" anna@example.com ", "Hi & bye [DG-1]", "a\nb"))
      .toBe("mailto:anna@example.com?subject=Hi%20%26%20bye%20%5BDG-1%5D&body=a%0D%0Ab");
  });

  it("accepts plain addresses only", () => {
    expect(isEmailAddress("anna@example.com")).toBe(true);
    expect(isEmailAddress("Anna <anna@example.com>")).toBe(false);
    expect(isEmailAddress("anna@example")).toBe(false);
  });

  it("offers earlier recipients, most recent first", () => {
    expect(recentRecipients([
      action("a", { delegatedTo: "ben@example.com", waitingSince: "2026-09-01" }),
      action("b", { delegatedTo: "anna@example.com", waitingSince: "2026-09-20" }),
      action("c", { delegatedTo: "ben@example.com", waitingSince: "2026-09-10" }),
      action("d"),
    ])).toEqual(["anna@example.com", "ben@example.com"]);
  });
});
