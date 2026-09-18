import { describe, expect, it } from "vitest";
import { normalizeVaultPath, safeName } from "../src/utils/path";

describe("vault paths", () => {
  it("creates portable human filenames", () => {
    expect(safeName('Call: bank / "mortgage"')).toBe("Call- bank - -mortgage-");
  });

  it("does not allow parent traversal in configured destinations", () => {
    expect(normalizeVaultPath("../GTD/./Actions")).toBe("GTD/Actions");
  });
});
