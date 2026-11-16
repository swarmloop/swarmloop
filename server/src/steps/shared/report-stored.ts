/** A stored value the report reads, or null when the stored body no longer parses: a report never fails on old data. */
export function readStored<T>(read: () => T | null): T | null {
  try {
    return read();
  } catch {
    return null;
  }
}
