import { describe, expect, it } from "vitest";
import { ranksForOrder } from "../src/domain/ranking";

const ranked = (entries: Array<[string, number?]>) =>
  entries.map(([id, rank]) => (rank === undefined ? { id } : { id, rank }));

describe("ranks for an order", () => {
  it("changes nothing when the ranks already fit", () => {
    expect(ranksForOrder(ranked([["A", 1_000], ["B", 2_000], ["C", 3_000]]))).toEqual(new Map());
  });

  it("gives one moved item a rank between its neighbours", () => {
    expect(ranksForOrder(ranked([["A", 1_000], ["C", 3_000], ["B", 2_000]]))).toEqual(new Map([["C", 1_500]]));
    expect(ranksForOrder(ranked([["C", 3_000], ["A", 1_000], ["B", 2_000]]))).toEqual(new Map([["C", 0]]));
    expect(ranksForOrder(ranked([["B", 2_000], ["C", 3_000], ["A", 1_000]]))).toEqual(new Map([["A", 4_000]]));
  });

  it("ranks unranked items around the ranked ones", () => {
    expect(ranksForOrder(ranked([["A"], ["B"]]))).toEqual(new Map([["A", 1_000], ["B", 2_000]]));
    expect(ranksForOrder(ranked([["A", 1_000], ["N"], ["B", 2_000], ["M"]])))
      .toEqual(new Map([["N", 1_500], ["M", 3_000]]));
  });

  it("renumbers everything once no integer is left between two neighbours", () => {
    expect(ranksForOrder(ranked([["A", 1_000], ["C", 1_002], ["B", 1_001]])))
      .toEqual(new Map([["C", 2_000], ["B", 3_000]]));
  });
});
