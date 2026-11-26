/** The output of a failed check command that names one test file, as a runner would print it. */
export function checkOutputNaming(testFile: string): string {
  return `FAIL ${testFile}\n  ● the case failed\n\nTests: 1 failed, 1 total\n`;
}

/** A failed CI job's log block that names one test file, in the shape of a failed pipeline log. */
export function ciJobLogNaming(testFile: string, job = 'test', project = 'app'): string {
  return [
    `project: ${project}`,
    'pipeline: 1 failed',
    `job: ${job}`,
    `FAIL ${testFile}`,
    '  ● the case failed',
    '',
  ].join('\n');
}
