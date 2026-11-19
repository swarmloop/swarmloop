import type { CodeHost, MergeHow, MergeMethod } from '../../integrations/code-host/code-host';

/** The methods a task may merge with, in the order they are tried. */
const PREFERRED: MergeMethod[] = ['squash', 'rebase', 'merge'];

/**
 * How a task's merge request merges: the first method the repository allows, with the title of the commit it makes
 * when there is one. Undefined when none is allowed, so the merge goes without `how` and the host answers with its
 * own refusal. A failed read of the settings propagates as the wait it is.
 */
export async function mergeHow(host: CodeHost, project: string, title: string | null): Promise<MergeHow | undefined> {
  const { methods } = await host.readMergeMethods(project);
  const method = PREFERRED.find((candidate) => methods.includes(candidate));
  if (method === undefined) return undefined;
  return title === null ? { method } : { method, title };
}
