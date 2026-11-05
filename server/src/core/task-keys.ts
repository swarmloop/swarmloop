const JIRA_KEY = /[A-Z][A-Z0-9]+-\d+/g;
const JIRA_KEY_EXACT = /^[A-Z][A-Z0-9]+-\d+$/;

export function taskKeys(prompt: string, runId: string): string[] {
  const found = new Set<string>();
  if (JIRA_KEY_EXACT.test(runId)) {
    found.add(runId);
  }
  for (const match of prompt.matchAll(JIRA_KEY)) {
    found.add(match[0]);
  }
  return [...found];
}
