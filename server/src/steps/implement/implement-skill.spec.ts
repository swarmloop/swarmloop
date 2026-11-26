import { readFileSync } from 'fs';
import { join } from 'path';

const raw = readFileSync(join(__dirname, '../../../../skills/implement/SKILL.md'), 'utf8');

describe('the implement skill', () => {
  it('leaves a red outside the task own files alone and sends it up as a need that names no task', () => {
    expect(raw).toContain('is not changed. Name it in `cause` and send it up as a `needs:` entry that names no task');
    expect(raw).toContain('in a run that is not a subtask too');
    expect(raw).not.toContain('sends no `needs`');
  });

  it('limits changing a test to the own files and fixes a broken outside test in the code or the plan', () => {
    expect(raw).toContain("Change the code or that test; this holds for the task's own files.");
    expect(raw).toContain('or the plan is amended to name it');
    expect(raw).toContain('it is never edited without that');
  });
});
