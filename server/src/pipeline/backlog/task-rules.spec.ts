import { BadRequestException, ConflictException } from '@nestjs/common';
import {
  checkNewSlugs,
  checkNotSettled,
  checkNotStartedForChange,
  checkNotStartedForDelete,
  checkSlug,
  checkTasks,
  isStarted,
  type CheckedTask,
  type TaskScope,
} from './task-rules';

const SCOPE: TaskScope = {
  repositories: ['web', 'server'],
  refs: ['M1.R1'],
  others: [{ slug: 'base', depends: [] }],
};

function task(overrides: Partial<CheckedTask> = {}): CheckedTask {
  return { slug: 'one', repositories: ['web'], covers: [], depends: [], fixesMain: null, ...overrides };
}

describe('task rules', () => {
  it('takes a lowercase slug and refuses any other', () => {
    expect(checkSlug('add-login-2')).toBe('add-login-2');
    for (const slug of ['Add', '2fast', 'a b', '', 'x'.repeat(40), 7]) {
      expect(() => checkSlug(slug)).toThrow(BadRequestException);
    }
  });

  it('refuses a slug that is taken or repeated in the batch', () => {
    expect(checkNewSlugs(['a', 'b'], ['c'])).toEqual(['a', 'b']);
    expect(() => checkNewSlugs(['a'], ['a'])).toThrow(ConflictException);
    expect(() => checkNewSlugs(['a', 'a'], [])).toThrow(ConflictException);
  });

  it('holds task repositories to the scope', () => {
    expect(() => checkTasks([task({ repositories: ['web', 'server'] })], SCOPE)).not.toThrow();
    expect(() => checkTasks([task({ repositories: ['docs'] })], SCOPE)).toThrow('docs is not in the scope');
  });

  it('wants covers to name existing requirements', () => {
    expect(() => checkTasks([task({ covers: ['M1.R1'] })], SCOPE)).not.toThrow();
    expect(() => checkTasks([task({ covers: ['M1.R2'] })], SCOPE)).toThrow(BadRequestException);
  });

  it('wants depends to name existing tasks, batch tasks or requirements', () => {
    expect(() => checkTasks([task({ depends: ['base', 'M1.R1'] })], SCOPE)).not.toThrow();
    expect(() => checkTasks([task(), task({ slug: 'two', depends: ['one'] })], SCOPE)).not.toThrow();
    expect(() => checkTasks([task({ depends: ['ghost'] })], SCOPE)).toThrow('ghost is neither');
  });

  it('refuses a dependency cycle, also through an existing task', () => {
    expect(() => checkTasks([task({ depends: ['one'] })], SCOPE)).toThrow('circle');
    expect(() => checkTasks([task({ slug: 'a', depends: ['b'] }), task({ slug: 'b', depends: ['a'] })], SCOPE)).toThrow(
      'circle',
    );
    const scope = { ...SCOPE, others: [{ slug: 'base', depends: ['one'] }] };
    expect(() => checkTasks([task({ depends: ['base'] })], scope)).toThrow('circle');
  });

  it('wants fixes_main among the task repositories', () => {
    expect(() => checkTasks([task({ fixesMain: 'web' })], SCOPE)).not.toThrow();
    expect(() => checkTasks([task({ fixesMain: 'server' })], SCOPE)).toThrow('not one of its repositories');
  });

  it('says a task has started when it has a run key, and where its changes go', () => {
    expect(isStarted({ runKey: 'one-1' })).toBe(true);
    expect(isStarted({ runKey: null })).toBe(false);
    expect(() => checkNotStartedForChange({ slug: 'one', runKey: 'k' })).toThrow(
      'one has started: its run takes changes through its own planner',
    );
    expect(() => checkNotStartedForDelete({ slug: 'one', runKey: 'k' })).toThrow('one has started: skip it instead');
    expect(() => checkNotStartedForChange({ slug: 'one', runKey: null })).not.toThrow();
    expect(() => checkNotSettled({ slug: 'one', status: 'merged' })).toThrow(ConflictException);
    expect(() => checkNotSettled({ slug: 'one', status: 'running' })).not.toThrow();
  });
});

describe('task rules through requirements', () => {
  const scope: TaskScope = { repositories: ['web'], refs: ['M1.R1', 'M1.R2'], others: [] };
  const a = task({ slug: 'a', covers: ['M1.R1'], depends: ['M1.R2'] });
  const b = task({ slug: 'b', covers: ['M1.R2'], depends: ['M1.R1'] });

  it('refuses a dependency cycle through requirements, with the cycle named', () => {
    const circle = 'the tasks depend on each other in a circle: a -> M1.R2 (b) -> M1.R1 (a)';
    expect(() => checkTasks([a, b], scope)).toThrow(circle);
    expect(() => checkTasks([b], { ...scope, others: [a] })).toThrow(circle);
  });

  it('ignores settled tasks when it looks for a cycle', () => {
    const merged = { status: 'merged' as const };
    const others = [
      { slug: 'setup-db', covers: ['M1.R1'], depends: [], ...merged },
      { slug: 'api', covers: ['M1.R2'], depends: ['M1.R1'], ...merged },
    ];
    expect(() =>
      checkTasks([task({ slug: 'db-index', covers: ['M1.R1'], depends: ['M1.R2'] })], { ...scope, others }),
    ).not.toThrow();
  });

  it('accepts a task that depends on a requirement it covers itself', () => {
    expect(() => checkTasks([task({ covers: ['M1.R1'], depends: ['M1.R1'] })], scope)).not.toThrow();
  });
});
