import { decodeSeen, diffSeen, encodeSeen, stateLinesOf } from './turn-changes';
import type { TaskState, TurnState } from './turn-state';

function task(slug: string, overrides: Partial<TaskState> = {}): TaskState {
  return {
    slug,
    title: slug,
    description: `Do ${slug}`,
    status: 'waiting',
    wait: '',
    runKey: null,
    repositories: ['web'],
    covers: [],
    depends: [],
    files: [],
    fixesMain: null,
    subtasks: [],
    ...overrides,
  };
}

function stateOf(tasks: TaskState[], decisions: { id: number; text: string }[] = []): TurnState {
  const all = decisions.map((item) => ({ ...item, who: 'owner', at: 'now' })).reverse();
  return {
    backlog: { id: 1, name: 'alpha', repositories: ['web'], mergeMode: 'green', paused: false },
    active: {
      number: 1,
      title: 'First',
      goal: 'ship',
      status: 'active',
      requirements: [{ ref: 'M1.R1', text: 'first', status: 'open' }],
      tasks,
    },
    planned: [],
    items: [],
    decisions: all,
    olderDecisions: 0,
    allDecisions: all,
    messages: [],
    olderMessages: 0,
    messagesOfTurn: [],
    lastSeen: null,
    events: [],
  };
}

describe('turn changes', () => {
  it('keys the state lines by backlog, milestone, requirement and task', () => {
    const lines = stateLinesOf(stateOf([task('a')]));

    expect(Object.keys(lines)).toEqual(['backlog', 'milestone:1', 'requirement:M1.R1', 'task:a']);
  });

  it('reports a new or changed line with its current text, a gone key and a changed brief, and nothing else', () => {
    const seen = decodeSeen(encodeSeen(stateOf([task('keep'), task('edit'), task('drop'), task('start')])));

    const changes = diffSeen(
      seen!,
      stateOf([
        task('keep'),
        task('edit', { description: 'Edited' }),
        task('new'),
        task('start', { runKey: 'start-1', status: 'running' }),
      ]),
    );

    expect(changes.changed.map((item) => item.key)).toEqual(['task:edit', 'task:new', 'task:start']);
    expect(changes.changed[2].text).toContain('run start-1');
    expect(changes.gone).toEqual(['task:drop']);
    expect(changes.briefs).toEqual(['edit']);
  });

  it('reports the decisions after the seen one, oldest first', () => {
    const seen = decodeSeen(
      encodeSeen(
        stateOf(
          [],
          [
            { id: 1, text: 'a' },
            { id: 2, text: 'b' },
          ],
        ),
      ),
    );

    const changes = diffSeen(
      seen!,
      stateOf(
        [],
        [
          { id: 1, text: 'a' },
          { id: 2, text: 'b' },
          { id: 3, text: 'c' },
          { id: 4, text: 'd' },
        ],
      ),
    );

    expect(changes.decisions.map((item) => item.text)).toEqual(['c', 'd']);
    expect(changes.changed).toEqual([]);
  });

  it('counts a missing or unreadable seen state as none', () => {
    expect(decodeSeen(null)).toBeNull();
    expect(decodeSeen('{nope')).toBeNull();
    expect(decodeSeen('{"lines":{"a":1},"briefs":{},"decision":0}')).toBeNull();
    expect(decodeSeen('"text"')).toBeNull();
  });

  it('round-trips the state it encodes', () => {
    const state = stateOf([task('a')], [{ id: 7, text: 'x' }]);

    expect(decodeSeen(encodeSeen(state))).toEqual({
      lines: stateLinesOf(state),
      briefs: { a: expect.stringMatching(/^[0-9a-f]{12}$/) },
      decision: 7,
    });
  });
});
