import type { Subtask } from '../../contract/subtask';
import { briefingState, recordOf, renderDelta, renderFull } from './briefing-state';

function task(id: string, extra: Partial<Subtask> = {}): Subtask {
  return {
    id,
    title: `Title ${id}`,
    description: '',
    depends: [],
    files: [`${id}.ts`],
    proof: `${id}.spec.ts`,
    status: 'waiting',
    ...extra,
  };
}

const CONTRACT =
  '- tool (owner b): the tool takes a path\n- cache (owner c): keyed by host\n\ndecisions:\n- subtask c at 2026-11-20T09:00:00.000Z: hosts are lower case\n';

function state(overrides: { tasks?: Subtask[]; contract?: string } = {}) {
  const tasks = overrides.tasks ?? [
    task('a', { depends: ['b'], covers: ['R1'] }),
    task('b', { status: 'merged', covers: ['R2'] }),
    task('c', { covers: ['R3', 'R4'] }),
  ];
  return briefingState({
    tasks,
    task: tasks[0],
    runs: {},
    summaries: { b: 'Made the tool.' },
    changed: { b: ['b.ts', 'shared/tool.ts'] },
    contract: overrides.contract ?? CONTRACT,
    requirements: [
      { id: 'R1', text: 'first' },
      { id: 'R2', text: 'second' },
    ],
  });
}

describe('the state a subtask is told', () => {
  it('holds the map with owned items, merged dependencies, the decisions and the requirement ids', () => {
    const text = renderFull(state());

    expect(text).toContain('- b (merged): Title b - files: b.ts - owns: tool (delivered)');
    expect(text).toContain('- c (waiting): Title c - files: c.ts - owns: cache (pending)');
    expect(text).toContain('Merged dependency b, files: b.ts, shared/tool.ts\nMade the tool.');
    expect(text).toContain('Contract items it delivered:\n- tool: the tool takes a path');
    expect(text).toContain('decisions:\n- subtask c at 2026-11-20T09:00:00.000Z: hosts are lower case');
    expect(text).toContain('Requirements of this task:\n- R1: first');
    expect(text).toContain('Requirements that belong to other tasks:\n- b: R2\n- c: R3, R4');
  });

  it('is empty for a task with no siblings, no contract and no requirements', () => {
    const only = task('a');

    expect(renderFull(state({ tasks: [only], contract: '' }))).toBe('');
  });

  it('gives a delta of nothing for a chat that saw the whole state', () => {
    const current = state();

    expect(renderDelta(current, recordOf(current))).toBe('');
  });

  it('gives a delta of only a new decision', () => {
    const seen = recordOf(state());
    const later = state({ contract: `${CONTRACT}- subtask c at 2026-11-20T11:00:00.000Z: ports are numbers\n` });

    expect(renderDelta(later, seen)).toBe(
      '\n\nNew decisions since your last prompt:\n- subtask c at 2026-11-20T11:00:00.000Z: ports are numbers',
    );
  });

  it('gives a delta of a dependency merged since, with its items, and not the item twice', () => {
    const before = [task('a', { depends: ['b', 'c'] }), task('b', { status: 'merged' }), task('c')];
    const seen = recordOf(state({ tasks: before }));
    const after = [
      task('a', { depends: ['b', 'c'] }),
      task('b', { status: 'merged' }),
      task('c', { status: 'merged' }),
    ];

    const text = renderDelta(state({ tasks: after }), seen);

    expect(text).toContain('Merged dependency c, files: c.ts');
    expect(text).toContain('Contract items it delivered:\n- cache: keyed by host');
    expect(text).not.toContain('Merged dependency b');
    expect(text).not.toContain('status changed');
  });

  it('names an item whose status changed when its owner is not a dependency', () => {
    const seen = recordOf(state());
    const after = [task('a', { depends: ['b'] }), task('b', { status: 'merged' }), task('c', { status: 'merged' })];

    expect(renderDelta(state({ tasks: after }), seen)).toBe(
      '\n\nContract items whose status changed:\n- cache (owner c): delivered',
    );
  });
});
