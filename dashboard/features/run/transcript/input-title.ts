/** The words of the input kinds that reach `input.received`: the steps' input specs read them from the artifacts. */
const TITLES: Record<string, string> = {
  requirements: 'Requirements',
  repos: 'Repositories',
  commit: 'Commit',
  implementation: 'Implementation',
  plan: 'Plan',
  issues: 'Issues',
  pipeline_log: 'Pipeline log',
  pipeline_ref: 'Watched branch',
  delivery: 'Delivery',
  ci_skip: 'CI skip',
  ci_rerun: 'CI re-run',
};

/** What an input is, in words for a person: the mapped title, or the kind with spaces and a capital. */
export function inputTitle(inputKind: string): string {
  const mapped = TITLES[inputKind];
  if (mapped) {
    return mapped;
  }
  const words = inputKind.replace(/_/g, ' ');
  return words.charAt(0).toUpperCase() + words.slice(1);
}
