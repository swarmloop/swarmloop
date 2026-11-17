import { PLAN_CHAT_KIND, type PlanRevision } from '../../contract/plan-chat';
import { planChanges, planChangesOf } from './plan-changes';

const revision = (version: number, extra: Partial<PlanRevision> = {}): PlanRevision => ({
  version,
  reason: `reason ${version}`,
  summary: 'Added 1 item',
  added: [],
  changed: [],
  dropped: [],
  at: '2026-01-01T00:00:00.000Z',
  ...extra,
});

describe('planChanges', () => {
  it('names the reason and what each revision added, changed and dropped', () => {
    const section = planChanges([
      revision(2, {
        reason: 'Also keep the old rows\nsecond line',
        added: ['keep rows'],
        changed: ['index'],
        dropped: ['old'],
      }),
    ]);
    expect(section).toEqual({
      heading: 'Plan changes',
      body: ['Plan v2: Also keep the old rows', '  added: keep rows', '  changed: index', '  dropped: old'].join('\n'),
    });
  });

  it('shows a few lines of each kind and counts the rest', () => {
    const section = planChanges([revision(2, { added: ['a', 'b', 'c', 'd', 'e'] })]);
    expect(section?.body).toContain('added: c');
    expect(section?.body).not.toContain('added: d');
    expect(section?.body).toContain('added: and 2 more');
  });

  it('gives no section for a run whose plan never changed', () => {
    expect(planChanges([])).toBeNull();
    expect(planChanges([revision(1)])).toBeNull();
    expect(planChangesOf([])).toBeNull();
  });

  it('reads the revisions from the newest plan chat of the stored documents', () => {
    const older = JSON.stringify({ entries: [], revisions: [] });
    const newer = JSON.stringify({ entries: [], revisions: [revision(2, { added: ['x'] })] });
    const section = planChangesOf([
      { kind: PLAN_CHAT_KIND, body: older },
      { kind: PLAN_CHAT_KIND, body: newer },
      { kind: 'other', body: '' },
    ]);
    expect(section?.body).toContain('Plan v2: reason 2');
  });
});
