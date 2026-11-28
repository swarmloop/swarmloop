import { backlogTurn } from './definitions/backlog-turn';
import { choiceList } from './result-choices';
import { describeResult } from './result-prompt';
import type { Described } from './result-prompt';

const lines = choiceList(backlogTurn, 'actions');
const choiceLines = lines.filter((line) => / needs: /.test(line));

const actionNames = (): string[] => {
  const items = describeResult(backlogTurn).keys?.actions?.items?.[0] as Described;
  return (items.keys?.action.allow ?? []).map(String);
};

describe('choiceList for the backlog turn', () => {
  it('has one line for each of the actions the definition allows, in order', () => {
    expect(actionNames()).toHaveLength(23);
    expect(choiceLines.map((line) => line.split(' ')[1])).toEqual(actionNames());
  });

  it('gives what an action needs and what it may also give, with types', () => {
    expect(lines).toContain(
      '- addItem needs: id (string), title (string), description (string); may also give: reason (string)',
    );
    expect(lines).toContain('- stop needs: run (string); may also give: reason (string)');
    expect(lines).toContain('- pause needs: nothing; may also give: reason (string)');
    expect(lines).toContain('- acceptMilestone needs: milestone (number); may also give: reason (string)');
  });

  it('gives an offer to run as a milestone or a task, none of them needed', () => {
    const line = lines.find((item) => item.startsWith('- offerRun needs:'));
    expect(line).toBe('- offerRun needs: nothing; may also give: milestone (number), task (string), reason (string)');
  });

  it('lists the optional fields of a task change', () => {
    const line = lines.find((item) =>
      item.startsWith('- changeTask needs: task (string), revision (number); may also give: title (string)'),
    );
    expect(line).toContain('proof (array of string)');
    expect(line).toContain('milestone (number)');
    expect(line).toContain('reason (string)');
  });

  it('gives the reason of a pass-on as a need, not as a may-give', () => {
    const line = lines.find((item) => item.startsWith('- passQuestion needs:'));
    expect(line).toBe('- passQuestion needs: run (string), reason (string); may also give: question (string)');
  });

  it('writes the field lines of the item and of its nested tasks, with their descriptions', () => {
    expect(lines).toContain(
      '- actions[].action (one of ' +
        actionNames()
          .map((name) => JSON.stringify(name))
          .join(', ') +
        ', required): The action to take; the fields it needs are listed under it',
    );
    expect(lines.find((line) => line.startsWith('- actions[].tasks[].id (string, required): '))).toContain(
      "The task's slug",
    );
    expect(lines.find((line) => line.startsWith('- actions[].tasks[].proof (array of string, optional): '))).toContain(
      "something the task's own run can check",
    );
  });

  it('tells that a new task needs its title and brief', () => {
    expect(lines.find((line) => line.startsWith('- actions[].tasks[].title '))).toContain(
      'refuses a new task without it',
    );
    expect(lines.find((line) => line.startsWith('- actions[].tasks[].description '))).toContain(
      'refuses a new task without it',
    );
  });

  it('names the fields as the definition does, with no kind, slug or dependsOn field', () => {
    const fieldNames = lines.flatMap((line) => line.match(/^- (actions\[\][\w.[\]]*) /)?.slice(1) ?? []);
    expect(fieldNames).toContain('actions[].depends');
    expect(fieldNames).not.toContain('actions[].kind');
    expect(fieldNames).not.toContain('actions[].tasks[].slug');
    expect(fieldNames).not.toContain('actions[].tasks[].dependsOn');
    expect(choiceLines.join('\n')).not.toMatch(/\b(kind|slug|dependsOn) \(/);
  });

  it('is empty for a path that is no array of choices', () => {
    expect(choiceList(backlogTurn, 'say')).toEqual([]);
    expect(choiceList(backlogTurn, 'missing')).toEqual([]);
  });
});
