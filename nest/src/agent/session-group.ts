export type SessionGroup = 'plan' | 'implement';

/** Research, plan, and plan-improve share one chat. Implement steps share another. Each code reviewer keeps its own. */
export function sessionGroup(step: string): SessionGroup | null {
  if (step === 'research' || step === 'plan' || step === 'plan-improve') {
    return 'plan';
  }
  if (step === 'implement' || step === 'implement-improve' || step.startsWith('implement-')) {
    return 'implement';
  }
  return null;
}

export function sessionHome(step: string): string {
  return sessionGroup(step) ?? step;
}

export function sessionFileName(key: string, step: string): string {
  return `${key}-${sessionHome(step)}-session.json`;
}
