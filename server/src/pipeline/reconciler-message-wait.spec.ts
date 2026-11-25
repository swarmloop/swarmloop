import { writeRunState } from '../history/run-state';
import type { RunEntity } from '../history/entities';
import { FakeClock } from '../core/fake-clock.spec-helpers';
import { ReconcilerResumes } from './reconciler-resumes';

const WAIT = {
  on: 'model-host',
  since: '2026-11-25T07:00:00.000Z',
  message: 'down',
  retryAt: '2026-11-25T07:08:00.000Z',
};

function run(key: string, state: 'stopped' | 'done'): RunEntity {
  const entity = { key, status: 'blocked' } as RunEntity;
  writeRunState(entity, { status: state === 'stopped' ? 'blocked' : 'done', currentStep: 'implement' });
  return entity;
}

describe('ReconcilerResumes.resumeMessageHostWait', () => {
  it('reads the plan chat of a run that can hold a wait only, and takes its message once its try has come', async () => {
    const clock = new FakeClock(Date.parse('2026-11-25T07:10:00.000Z'));
    const read: string[] = [];
    const taken: string[] = [];
    const planChat = {
      pending: async (key: string) => {
        read.push(key);
        return [{ key: 'm1', wait: WAIT }];
      },
    };
    const runs = { listRuns: async () => [run('open', 'stopped'), run('ended', 'done')] };
    const resumes = new ReconcilerResumes(
      runs as never,
      {} as never,
      {} as never,
      clock,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      () => () => false,
      async () => undefined,
      undefined,
      undefined,
      planChat as never,
      async (key, outage) => void taken.push(`${key}:${outage}`),
    );

    await resumes.resumeMessageHostWait();

    expect(read).toEqual(['open']);
    expect(taken).toEqual([`open:host-m1-${WAIT.retryAt}`]);
  });
});
