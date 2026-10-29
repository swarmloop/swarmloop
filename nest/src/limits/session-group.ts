export type SessionGroup = 'plan';

/** Steps that continue one Cursor chat share one home directory. Each code reviewer keeps its own. */
export function sessionGroup(step: string): SessionGroup | null {
  if (
    step === 'research' ||
    step === 'plan' ||
    step === 'plan-review' ||
    step === 'implement' ||
    step === 'implement-review' ||
    step.startsWith('implement-')
  ) {
    return 'plan';
  }
  return null;
}

export function sessionHome(step: string): string {
  return sessionGroup(step) ?? step;
}

export function sessionFileName(key: string, step: string): string {
  return `${key}-${sessionHome(step)}-session.json`;
}
