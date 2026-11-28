import type { MilestoneRecord } from '../../history/backlog-writers';
import type { BacklogTaskRecord } from '../../history/backlog.repository';
import { chainBacklog } from './backlog-file-chain';

function record(slug: string, position: number, overrides: Partial<BacklogTaskRecord> = {}): BacklogTaskRecord {
  return {
    backlogId: 1,
    milestoneId: null,
    slug,
    title: slug,
    description: `Do ${slug}`,
    repositories: ['web'],
    covers: [],
    depends: [],
    files: [`${slug}.ts`],
    proof: [],
    manual: false,
    fixesMain: null,
    status: 'waiting',
    runKey: null,
    note: '',
    runNow: false,
    mergeOk: false,
    merged: {},
    madeBy: 'person',
    position,
    createdAt: '2026-11-12T10:00:00Z',
    ...overrides,
  };
}

function milestone(
  id: number,
  status: MilestoneRecord['status'],
  queuedAfterId: number | null = null,
): MilestoneRecord {
  return {
    id,
    backlogId: 1,
    number: id,
    title: `M${id}`,
    goal: '',
    status,
    queuedAfterId,
    createdAt: '2026-11-12T10:00:00Z',
  };
}

const MILESTONES = [milestone(1, 'active'), milestone(2, 'queued', 1)];

const dependsOf = (chained: ReturnType<typeof chainBacklog>) =>
  Object.fromEntries(chained.tasks.map((task) => [task.slug, task.depends]));

describe('chainBacklog', () => {
  it('chains two tasks that have not started by plan order, whatever the order of the list', () => {
    const chained = chainBacklog(
      [record('later', 2, { files: ['x.ts'] }), record('earlier', 1, { files: ['x.ts', 'y.ts'] })],
      MILESTONES,
    );
    expect(dependsOf(chained)).toEqual({ later: ['earlier'], earlier: [] });
    expect(chained.touched).toEqual(['later']);
    expect(chained.decisions).toEqual(['later depends on earlier: both change x.ts']);
  });

  it('counts a started task as earlier than a task that has not started, even when its position is later', () => {
    const chained = chainBacklog(
      [
        record('waiting', 1, { files: ['x.ts'] }),
        record('running', 2, { files: ['x.ts'], runKey: 'running-1', status: 'running' }),
      ],
      MILESTONES,
    );
    expect(dependsOf(chained)).toEqual({ waiting: ['running'], running: [] });
    expect(chained.decisions).toEqual(['waiting depends on running: both change x.ts']);
  });

  it('never adds an edge to a started task', () => {
    const chained = chainBacklog(
      [
        record('a', 1, { files: ['x.ts'], runKey: 'a-1', status: 'running' }),
        record('b', 2, { files: ['x.ts'], runKey: 'b-1', status: 'running' }),
      ],
      MILESTONES,
    );
    expect(chained.touched).toEqual([]);
    expect(chained.decisions).toEqual([]);
    expect(dependsOf(chained)).toEqual({ a: [], b: [] });
  });

  it('gives and gains no edge for a settled task, and returns it as it is', () => {
    const merged = record('done', 1, { files: ['x.ts'], status: 'merged', runKey: 'done-1' });
    const skipped = record('gone', 2, { files: ['x.ts'], status: 'skipped' });
    const chained = chainBacklog([merged, skipped, record('open', 3, { files: ['x.ts'] })], MILESTONES);
    expect(chained.tasks.slice(0, 2)).toEqual([merged, skipped]);
    expect(dependsOf(chained).open).toEqual([]);
    expect(chained.decisions).toEqual([]);
  });

  it('chains tasks that share a document as it chains any other file', () => {
    const chained = chainBacklog(
      [
        record('a', 1, { files: ['ARCHITECTURE.md'] }),
        record('b', 2, { files: ['skills/backlog-plan/SKILL.md', 'ARCHITECTURE.md'] }),
      ],
      MILESTONES,
    );
    expect(chained.decisions).toEqual(['b depends on a: both change ARCHITECTURE.md']);
  });

  it('keeps the depends a task had, requirement refs among them, and appends the added ones', () => {
    const chained = chainBacklog(
      [record('a', 1, { files: ['x.ts'] }), record('b', 2, { files: ['x.ts'], depends: ['M1.R1'] })],
      MILESTONES,
    );
    expect(dependsOf(chained).b).toEqual(['M1.R1', 'a']);
  });

  it('adds no edge between tasks a dependency path already joins', () => {
    const chained = chainBacklog(
      [
        record('a', 1, { files: ['x.ts'] }),
        record('b', 2, { files: ['y.ts'], depends: ['a'] }),
        record('c', 3, { files: ['x.ts'], depends: ['b'] }),
      ],
      MILESTONES,
    );
    expect(chained.decisions).toEqual([]);
  });

  it('puts the active milestone first and the queued chain after it, whatever the numbers and positions', () => {
    const milestones = [milestone(1, 'proposed'), milestone(2, 'queued', 3), milestone(3, 'active')];
    const chained = chainBacklog(
      [
        record('proposed', 1, { files: ['x.ts'], milestoneId: 1 }),
        record('queued', 2, { files: ['x.ts'], milestoneId: 2 }),
        record('active', 3, { files: ['x.ts'], milestoneId: 3 }),
      ],
      milestones,
    );
    expect(dependsOf(chained)).toEqual({ active: [], queued: ['active'], proposed: ['queued'] });
  });

  it('ranks a run now task with the active milestone, so it never waits for a task that starts later', () => {
    const chained = chainBacklog(
      [
        record('queued', 1, { files: ['x.ts'], milestoneId: 2 }),
        record('now', 2, { files: ['x.ts'], milestoneId: null, runNow: true }),
        record('active', 3, { files: ['x.ts'], milestoneId: 1 }),
      ],
      MILESTONES,
    );
    expect(dependsOf(chained)).toEqual({ queued: ['active'], now: [], active: ['now'] });
  });

  it('puts a task with no milestone after every task of a milestone', () => {
    const chained = chainBacklog(
      [
        record('item', 1, { files: ['x.ts'], milestoneId: null }),
        record('first', 2, { files: ['x.ts'], milestoneId: 1 }),
      ],
      MILESTONES,
    );
    expect(dependsOf(chained)).toEqual({ item: ['first'], first: [] });
  });
});
