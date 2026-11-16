import type { Clock } from '../../core/clock';
import type { RunEntity } from '../../history/entities';
import { RunReport } from './run-report';

const RUN = { id: 1, key: 'K-1', createdAt: '2026-11-16T10:00:00.000Z', doneAt: null } as unknown as RunEntity;
const NOTES = { requirements: 'a', quality: 'b', regressions: 'c', security: 'd', performance: 'e' };
const PARTS = { line: 'The field ships.', done: ['x'], worthALook: [], notes: NOTES, risk: 'low', riskReason: 'small' };

function reportOf(stored: string | null): RunReport {
  const documents = {
    latestBody: () => Promise.resolve(stored),
    listDocuments: () => Promise.resolve([]),
  };
  const none = {
    listStats: () => Promise.resolve([]),
    activePhases: () => Promise.resolve(['ci']),
    list: () => Promise.resolve([]),
  };
  const clock = { now: () => Date.parse('2026-11-16T10:05:00.000Z') } as Clock;
  return new RunReport(documents as never, none as never, none as never, none as never, clock);
}

describe('RunReport', () => {
  it('renders the stored parts with the facts of the run', async () => {
    const text = await reportOf(JSON.stringify(PARTS)).render(RUN);
    expect(text).toContain('## ⏳ Waiting for CI · risk: low\n> The field ships.');
    expect(text).toContain('| — | — | ⏳ | — | 0 | 5 min |');
  });

  it('gives nothing for a run without parts, or with parts of the old shape', async () => {
    expect(await reportOf(null).render(RUN)).toBeNull();
    expect(await reportOf('{"whatChanged":"a","codeReview":"b"}').render(RUN)).toBeNull();
  });

  it('gives nothing for parts it cannot read', async () => {
    expect(await reportOf('not json').render(RUN)).toBeNull();
  });
});
