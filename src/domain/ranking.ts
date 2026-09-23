/** Space left between neighbouring ranks, so later moves usually fit between two of them. */
export const RANK_STEP = 1_000;

export interface Ranked {
  id: string;
  rank?: number;
}

/**
 * The integer ranks that put `items` in the given order, as only the ranks that change.
 *
 * Every item whose rank already fits the order keeps it (the longest increasing run of
 * existing ranks), and the rest get ranks between their kept neighbours. Moving one item
 * therefore rewrites one file, not its whole column. Only when no integer is left between
 * two neighbours is the whole list renumbered.
 */
export function ranksForOrder(items: readonly Ranked[]): Map<string, number> {
  const kept = longestIncreasingRanks(items);
  const assigned = items.map((item, index) => (kept.has(index) ? item.rank! : undefined));

  let index = 0;
  while (index < items.length) {
    if (assigned[index] !== undefined) {
      index += 1;
      continue;
    }
    const start = index;
    while (index < items.length && assigned[index] === undefined) index += 1;
    const count = index - start;
    const low = start > 0 ? assigned[start - 1] : undefined;
    const high = index < items.length ? assigned[index] : undefined;
    for (let offset = 0; offset < count; offset += 1) {
      if (low !== undefined && high !== undefined) {
        if (high - low <= count) return changedRanks(items, items.map((_, position) => (position + 1) * RANK_STEP));
        assigned[start + offset] = low + Math.floor(((high - low) * (offset + 1)) / (count + 1));
      } else if (low !== undefined) {
        assigned[start + offset] = low + (offset + 1) * RANK_STEP;
      } else if (high !== undefined) {
        assigned[start + offset] = high - (count - offset) * RANK_STEP;
      } else {
        assigned[start + offset] = (offset + 1) * RANK_STEP;
      }
    }
  }
  return changedRanks(items, assigned as number[]);
}

function changedRanks(items: readonly Ranked[], ranks: readonly number[]): Map<string, number> {
  const changes = new Map<string, number>();
  items.forEach((item, index) => {
    if (item.rank !== ranks[index]) changes.set(item.id, ranks[index]!);
  });
  return changes;
}

/** Indices of the longest run of items whose existing ranks already increase in list order. */
function longestIncreasingRanks(items: readonly Ranked[]): Set<number> {
  // Patience sorting: tails[k] is the index ending the best run of length k + 1.
  const tails: number[] = [];
  const previous = new Map<number, number>();
  items.forEach((item, index) => {
    if (item.rank === undefined) return;
    let low = 0;
    let high = tails.length;
    while (low < high) {
      const middle = (low + high) >> 1;
      if (items[tails[middle]!]!.rank! < item.rank) low = middle + 1;
      else high = middle;
    }
    if (low > 0) previous.set(index, tails[low - 1]!);
    tails[low] = index;
  });
  const kept = new Set<number>();
  let current = tails.at(-1);
  while (current !== undefined) {
    kept.add(current);
    current = previous.get(current);
  }
  return kept;
}
