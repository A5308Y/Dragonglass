import { useEffect, useState } from "preact/hooks";
import type { GtdSnapshot } from "../domain/types";
import type { GtdIndex } from "../repository/gtd-index";

export function useGtdSnapshot(index: GtdIndex): GtdSnapshot {
  const [snapshot, setSnapshot] = useState(index.getSnapshot());
  useEffect(() => index.subscribe(() => setSnapshot(index.getSnapshot())), [index]);
  return snapshot;
}
