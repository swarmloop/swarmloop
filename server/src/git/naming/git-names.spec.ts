import { SwarmloopError } from '../../core/swarmloop-error';
import { branchName, commitMessage, mergeRequestTitle } from './git-names';

describe('branchName', () => {
  it('uses the Jira key and a kebab summary', () => {
    expect(branchName('PROJ-12', 'Ship the field')).toBe('feature/PROJ-12-ship-the-field');
  });

  it('uses a slug run id the same way', () => {
    expect(branchName('vendor-api', 'Add plot types')).toBe('feature/vendor-api-add-plot-types');
  });

  it('transliterates a Ukrainian summary', () => {
    expect(branchName('PROJ-7', 'додати поле до форми')).toBe('feature/PROJ-7-dodaty-pole-do-formy');
  });

  it('writes a GitLab subject from the Jira key, not the run id', () => {
    expect(commitMessage('PROJ-20--5', 'Ship the field.')).toBe('feat(PROJ-20): Ship the field');
  });

  it('rejects a summary that has no name', () => {
    expect(() => branchName('PROJ-12', '---')).toThrow(SwarmloopError);
    expect(() => branchName('PROJ-12', '---')).toThrow('branch name is missing');
  });

  it('keeps the kebab part to 48 characters and a name under 100', () => {
    const name = branchName('PROJ-12', 'word '.repeat(40));
    expect(name).toBe(`feature/PROJ-12-${'word-'.repeat(9)}wor`.replace(/-$/, ''));
    expect(branchName(`PROJ-${'1'.repeat(80)}`, 'Ship it', { template: 'feature/{key}-{slug}' }).length).toBeLessThan(
      100,
    );
  });

  it("keeps today's name of the built-in format whatever its length", () => {
    expect(branchName(`PROJ-${'1'.repeat(80)}`, 'Ship it')).toBe(`feature/PROJ-${'1'.repeat(80)}-ship-it`);
  });

  it('puts every value but the key and the ticket through the kebab rule', () => {
    const rendered = branchName('PROJ-12', 'Ship the field', {
      template: '{type}/{scope}/{subject}/{task}/{ticket}',
      change: { type: 'fix', scope: 'API Core', subject: 'Stop: the Цикл?' },
      task: 'Part One',
    });
    expect(rendered).toBe('fix/api-core/stop-the-tsykl/part-one/PROJ-12');
  });

  it('renders a template of the repository with a name that has no trailing separator', () => {
    expect(branchName('PROJ-12', 'Ship the field', { template: '{type}/{ticket}/{slug}', change: change() })).toBe(
      'fix/PROJ-12/ship-the-field',
    );
    expect(branchName('vendor-api', 'Ship', { template: 'x/{ticket}/' })).toBe('x');
  });
});

describe('commitMessage', () => {
  it('stands the run key in for a missing ticket in the built-in format', () => {
    expect(commitMessage('vendor-api', 'Add plot types')).toBe('feat(vendor-api): Add plot types');
  });

  it('renders Conventional Commits with and without a scope', () => {
    const template = '{type}[({scope})]: {subject}';
    expect(commitMessage('PROJ-1', 'Whole ticket', { template, change: change() })).toBe('fix(api): Stop the loop');
    expect(commitMessage('PROJ-1', 'Whole ticket', { template, change: { type: 'feat', subject: 'Add it.' } })).toBe(
      'feat: Add it',
    );
  });

  it('gives a template of the repository the ticket or nothing, never the key', () => {
    expect(commitMessage('PROJ-1', 'Do it', { template: '[{ticket} ]{subject}' })).toBe('PROJ-1 Do it');
    expect(commitMessage('vendor-api', 'Do it', { template: '[{ticket} ]{subject}' })).toBe('Do it');
  });
});

describe('mergeRequestTitle', () => {
  it('is the summary in the built-in format', () => {
    expect(mergeRequestTitle('PROJ-1', 'Ship the field')).toBe('Ship the field');
  });

  it('renders the task of a split run', () => {
    expect(mergeRequestTitle('PROJ-1', 'Ship', { template: '{summary}: {task}', task: 'Part one' })).toBe(
      'Ship: Part one',
    );
  });
});

function change(): { type: 'fix'; scope: string; subject: string } {
  return { type: 'fix', scope: 'api', subject: 'Stop the loop' };
}
