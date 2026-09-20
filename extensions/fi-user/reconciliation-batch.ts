export const RECONCILE_BATCH_SIZE = 8;

// Reading a Slack history and serializing it into a projection is materially
// more expensive than reconciling a room's membership.  Keep repair work
// responsive by admitting one historical snapshot at a time; live delivery is
// still immediate and is deliberately not subject to this maintenance budget.
export const RECONCILE_HISTORY_BATCH_SIZE = 1;

export function takeSweepBatch(
  keys: readonly string[],
  seen: Set<string>,
  limit: number,
): Set<string> {
  const current = new Set(keys);
  for (const key of seen) {
    if (!current.has(key)) {
      seen.delete(key);
    }
  }
  if (keys.length > 0 && keys.every((key) => seen.has(key))) {
    seen.clear();
  }
  const batch = new Set(keys.filter((key) => !seen.has(key)).slice(0, limit));
  for (const key of batch) {
    seen.add(key);
  }
  return batch;
}

export function takePendingOrRotatingBatch(
  keys: readonly string[],
  completed: ReadonlySet<string>,
  cursor: string,
  limit: number,
): { batch: Set<string>; cursor: string } {
  const pending = keys.filter((key) => !completed.has(key));
  const ordered = pending.length
    ? pending
    : [...keys.filter((key) => key > cursor), ...keys.filter((key) => key <= cursor)];
  const batch = new Set(ordered.slice(0, limit));
  return { batch, cursor: [...batch].at(-1) ?? cursor };
}
