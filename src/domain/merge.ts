/**
 * Three-way merging for the JSON stores that several devices write (see
 * `src/state/synced-json-file.ts`). `base` is what this device last read or wrote,
 * `mine` what it has now, `theirs` what the file holds now.
 */

export function same(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

/**
 * Merges entries by key. An entry removed on either side is gone; one added on either
 * side is kept; one changed on one side takes that change, and one changed on both
 * goes to `both`. Their order comes first, then entries only this device has.
 */
export function mergeKeyed<V>(
  base: ReadonlyMap<string, V>,
  mine: ReadonlyMap<string, V>,
  theirs: ReadonlyMap<string, V>,
  both: (base: V | undefined, mine: V, theirs: V) => V,
): Map<string, V> {
  const merged = new Map<string, V>();
  const keys = [...theirs.keys(), ...[...mine.keys()].filter((key) => !theirs.has(key))];
  for (const key of keys) {
    const b = base.get(key);
    const m = mine.get(key);
    const t = theirs.get(key);
    if (b !== undefined && (m === undefined || t === undefined)) continue;
    if (m === undefined) merged.set(key, t!);
    else if (t === undefined) merged.set(key, m);
    else if (b !== undefined && same(m, b)) merged.set(key, t);
    else if (b !== undefined && same(t, b)) merged.set(key, m);
    else merged.set(key, both(b, m, t));
  }
  return merged;
}

export function byKey<V>(values: readonly V[], key: (value: V) => string): Map<string, V> {
  return new Map(values.map((value) => [key(value), value]));
}

export function recordMap<V>(record: Readonly<Record<string, V>>): Map<string, V> {
  return new Map(Object.entries(record));
}

/** Of two states, the one fetched or synced last; ISO timestamps compare as strings. */
export function later<V extends { fetched: string }>(mine: V, theirs: V): V {
  return mine.fetched >= theirs.fetched ? mine : theirs;
}
