import { readFileSync } from 'fs';
import { join } from 'path';

const skill = (name: string) =>
  readFileSync(join(__dirname, `../../../../skills/code-review/${name}/SKILL.md`), 'utf8');

const FAILED_JOB =
  "A change that makes a failed job pass is part of the task only within the task's own files (its listed files, or else the files its plan names; a red outside them is not the run's to fix), except one that loosens or removes an assertion, skips or deletes a test, or widens a tolerance. That is a return unless";

describe('code-review skills', () => {
  it('has the requirements reviewer return each test outside the plan unless it was approved', () => {
    const text = skill('requirements');
    expect(text).toContain('Files outside the plan');
    expect(text).toContain('Return each test file in it, by name, unless the plan names it');
    expect(text).toContain("a planner's or a person's answer approved that change");
    expect(text).toContain('an edit that keeps the expected value is no exception');
  });

  it('words the failed-job rule the same in both skills', () => {
    expect(skill('requirements')).toContain(FAILED_JOB);
    expect(skill('regressions')).toContain(FAILED_JOB);
  });
});
