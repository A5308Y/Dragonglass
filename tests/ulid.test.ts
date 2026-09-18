import { describe, expect, it } from "vitest";
import { createUlid } from "../src/utils/ulid";

describe("ULIDs", () => {
  it("are 26-character Crockford strings and monotonic within a millisecond", () => {
    const first = createUlid(1_000);
    const second = createUlid(1_000);
    expect(first).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/);
    expect(second > first).toBe(true);
  });
});
