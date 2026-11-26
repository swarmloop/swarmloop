import { testPaths } from './test-paths';

/** A log path matches a changed file when the two are equal or one ends with `/` plus the other. */
function touches(path: string, file: string): boolean {
  return path === file || path.endsWith(`/${file}`) || file.endsWith(`/${path}`);
}

/**
 * The test files the logs name when there is at least one and the change touches none of them: a red outside the
 * change. Null otherwise. It reads only the test paths of the logs and the files of the change.
 */
export function outsideRed(logs: string[], changed: string[]): string[] | null {
  const paths = [...new Set(logs.flatMap((log) => testPaths(log)))];
  if (paths.length === 0 || paths.some((path) => changed.some((file) => touches(path, file)))) {
    return null;
  }
  return paths;
}

/** The question for the run's planner about a red outside the change. */
export function outsideQuestion(input: { what: string[]; tests: string[]; logs: string[]; changed: string[] }): string {
  const list = (items: string[]): string => (items.length > 0 ? items.map((item) => `- ${item}`).join('\n') : '- none');
  return [
    'This run failed only in tests its change does not touch.',
    `Failed:\n${list(input.what)}`,
    `Test files the logs name:\n${list(input.tests)}`,
    `The whole logs are at:\n${list(input.logs)}`,
    `Files the change touches:\n${list(input.changed)}`,
    'Did the change cause this red? If so, give implement an instruction by replay. If not (a red main, a flaky test), send the question up the chain.',
  ].join('\n\n');
}
