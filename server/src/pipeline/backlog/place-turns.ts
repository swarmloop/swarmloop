/**
 * Hands `free` places one at a time to the queues in turn, starting with the queue after `after`.
 * Returns what each queue took, and the key of the queue served last (`after` when none was).
 */
export function handPlaces<T>(
  queues: ReadonlyMap<number, T[]>,
  order: number[],
  after: number | null,
  free: number,
): { chosen: Map<number, T[]>; last: number | null } {
  const start = after === null ? 0 : order.indexOf(after) + 1;
  const turns = [...order.slice(start), ...order.slice(0, start)];
  const left = new Map([...queues].map(([key, queue]) => [key, [...queue]]));
  const chosen = new Map<number, T[]>(turns.map((key) => [key, []]));
  let last = after;
  let places = free;
  let served = true;
  while (places > 0 && served) {
    served = false;
    for (const key of turns) {
      const next = places > 0 ? left.get(key)?.shift() : undefined;
      if (next === undefined) continue;
      chosen.get(key)?.push(next);
      places -= 1;
      last = key;
      served = true;
    }
  }
  return { chosen, last };
}
