import { describe, expect, it } from "vitest";
import { isPathInDirectory, normalizeVaultPath, rawInboxId, safeName } from "../src/utils/path";

describe("vault paths", () => {
  it("creates portable human filenames", () => {
    expect(safeName('Call: bank / "mortgage"')).toBe("Call- bank - -mortgage-");
  });

  it("does not allow parent traversal in configured destinations", () => {
    expect(normalizeVaultPath("../GTD/./Actions")).toBe("GTD/Actions");
  });

  it("recognizes files below the Inbox regardless of folder casing", () => {
    expect(isPathInDirectory("GTD/INBOX/receipt.pdf", "GTD/Inbox")).toBe(true);
    expect(isPathInDirectory("GTD/Actions/receipt.pdf", "GTD/Inbox")).toBe(false);
  });

  it("gives raw Inbox files deterministic disposable IDs", () => {
    expect(rawInboxId("GTD/Inbox/receipt.pdf")).toBe(rawInboxId("GTD/Inbox/receipt.pdf"));
    expect(rawInboxId("GTD/Inbox/other.pdf")).not.toBe(rawInboxId("GTD/Inbox/receipt.pdf"));
  });
});
