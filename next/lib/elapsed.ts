export function visitStored(starts: readonly string[], heldStart: string | null): boolean {
  return heldStart !== null && starts.includes(heldStart);
}

export function openElapsed(startedAt: string | null, now: number): number {
  if (!startedAt) {
    return 0;
  }
  const started = Date.parse(startedAt);
  return Number.isFinite(started) ? Math.max(0, now - started) : 0;
}

export function openRunMs(run: { status: string; stepStartedAt: string | null }, now: number): number {
  if (run.status !== 'running') {
    return 0;
  }
  return openElapsed(run.stepStartedAt, now);
}
