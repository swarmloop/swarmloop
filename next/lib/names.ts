export function mergeNames(current: readonly string[], incoming: readonly string[]): string[] {
  const seen = new Set(current);
  const next = [...current];
  for (const name of incoming) {
    if (!seen.has(name)) {
      seen.add(name);
      next.push(name);
    }
  }
  return next;
}
