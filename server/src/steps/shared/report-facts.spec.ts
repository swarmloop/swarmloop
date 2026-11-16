import { CODE_REVIEWERS } from '../../contract/steps';
import type { CheckCommandEntity, DocumentEntity, RunEntity } from '../../history/entities';
import type { StepStatEntity } from '../../history/step-stat.entity';
import { readReportFacts, type ReportFactsDeps } from './report-facts';

const RUN = { id: 1, key: 'K-1', createdAt: '2026-11-16T10:00:00.000Z', doneAt: null } as unknown as RunEntity;
const NOW = Date.parse('2026-11-16T10:38:00.000Z');

let nextId = 0;
const doc = (kind: string, body: unknown, stepStatId = 0): DocumentEntity =>
  ({ id: ++nextId, kind, stepStatId, body: typeof body === 'string' ? body : JSON.stringify(body) }) as DocumentEntity;
const visit = (id: number, step: string, status: string): StepStatEntity => ({ id, step, status }) as StepStatEntity;
const command = (attemptId: string, status: string, skipped = 0): CheckCommandEntity =>
  ({ attemptId, status, skipped }) as CheckCommandEntity;
const review = (name: string, decision: 'ok' | 'return', extra: object = {}): DocumentEntity =>
  doc(`review_${name}_result`, { decision, review: `${name} review`, summary: ['s'], ...extra });
const marks = (...statuses: string[]): DocumentEntity[] => [
  doc(
    'requirement_list',
    statuses.map((_, index) => ({ id: `R${index + 1}`, text: `req ${index + 1}` })),
  ),
  review('requirements', 'ok', {
    requirements: statuses.map((status, index) => ({ id: `R${index + 1}`, status, note: 'n' })),
  }),
];

function depsOf(
  input: {
    documents?: DocumentEntity[];
    stats?: StepStatEntity[];
    rows?: CheckCommandEntity[];
    phases?: string[];
    children?: RunEntity[];
  } = {},
): ReportFactsDeps {
  return {
    documents: { listDocuments: () => Promise.resolve(input.documents ?? []) },
    visits: { listStats: () => Promise.resolve(input.stats ?? []) },
    flows: { activePhases: () => Promise.resolve(input.phases ?? ['checks', 'code-review', 'ci']) },
    checkCommands: { list: () => Promise.resolve(input.rows ?? []) },
    runs: { children: () => Promise.resolve(input.children ?? []) },
    clock: { now: () => NOW },
  } as unknown as ReportFactsDeps;
}

describe('readReportFacts', () => {
  it('reads nothing as dashes, and the run as waiting for CI', async () => {
    const facts = await readReportFacts(depsOf(), RUN);
    expect(facts).toMatchObject({
      verdict: 'waiting',
      requirements: null,
      checks: null,
      ci: 'waiting',
      review: null,
      returns: { count: 0, fixed: false },
      durationMs: 38 * 60_000,
      path: [],
    });
    expect(facts.reviewers.map((reviewer) => reviewer.decision)).toEqual(CODE_REVIEWERS.map(() => null));
  });

  it('counts the requirements the last requirements review marked met', async () => {
    const facts = await readReportFacts(depsOf({ documents: marks('met', 'partial', 'met', 'missing') }), RUN);
    expect(facts.requirements).toEqual({ met: 2, total: 4 });
  });

  it('counts the checks of the last attempt, without the skipped ones', async () => {
    const rows = [
      command('a', 'failed'),
      command('b', 'passed'),
      command('b', 'failed'),
      command('b', 'passed'),
      command('b', 'passed', 1),
    ];
    expect((await readReportFacts(depsOf({ rows }), RUN)).checks).toEqual({ passed: 2, total: 3 });
  });

  it('counts the decisions of the last round', async () => {
    const documents = [
      ...CODE_REVIEWERS.map((name) => review(name, 'return')),
      ...CODE_REVIEWERS.map((name) => review(name, name === 'security' ? 'return' : 'ok')),
    ];
    const facts = await readReportFacts(depsOf({ documents }), RUN);
    expect(facts.review).toEqual({ ok: 4, total: 5 });
    expect(facts.verdict).toBe('sent-back');
  });

  it('prefers the reviews of the round being written over the stored ones', async () => {
    const documents = CODE_REVIEWERS.map((name) => review(name, 'return'));
    const round = CODE_REVIEWERS.map((name) => ({
      name,
      result: { decision: 'ok' as const, review: 'r', summary: ['s'] },
    }));
    const facts = await readReportFacts(depsOf({ documents }), RUN, round);
    expect(facts.review).toEqual({ ok: 5, total: 5 });
    expect(facts.verdict).toBe('waiting');
  });

  it('reads CI from the pipeline log written after the last review', async () => {
    const reviewed = [visit(1, 'code-review', 'done')];
    const passed = await readReportFacts(
      depsOf({
        stats: [...reviewed, visit(2, 'pipeline', 'done')],
        documents: [doc('pipeline_log', 'result: pass\n', 2)],
      }),
      RUN,
    );
    expect([passed.ci, passed.verdict]).toEqual(['passed', 'ready']);
    const failed = await readReportFacts(
      depsOf({
        stats: [...reviewed, visit(2, 'pipeline', 'waiting')],
        documents: [doc('pipeline_log', 'result: fail\n', 2)],
      }),
      RUN,
    );
    expect([failed.ci, failed.verdict]).toEqual(['failed', 'ci-failed']);
    const stale = await readReportFacts(
      depsOf({
        stats: [visit(2, 'pipeline', 'done'), visit(3, 'code-review', 'done')],
        documents: [doc('pipeline_log', 'result: pass\n', 2)],
      }),
      RUN,
    );
    expect(stale.ci).toBe('waiting');
  });

  it('has no CI and is ready when the flow has no CI phase', async () => {
    const facts = await readReportFacts(depsOf({ phases: ['code-review'] }), RUN);
    expect([facts.ci, facts.verdict]).toEqual([null, 'ready']);
  });

  it('reads the path with each return, its reason and that the run went on after it', async () => {
    const stats = [
      visit(1, 'implement', 'done'),
      visit(2, 'implement-improve', 'done'),
      visit(3, 'checks', 'waiting'),
      visit(4, 'implement', 'done'),
      visit(5, 'checks', 'done'),
      visit(6, 'code-review', 'waiting'),
      visit(7, 'implement', 'done'),
      visit(8, 'code-review', 'waiting'),
    ];
    const issues = (source: string, body: string, failed: unknown[] = []): string =>
      JSON.stringify([{ id: 'x', source, title: 't', body, failed }]);
    const documents = [
      doc('issues', issues('checks', 'log', [{ repo: 'a', command: 'npm run lint', tail: '' }]), 3),
      doc('issues', issues('security', 'A symlink could pull a host file.\nmore'), 6),
    ];
    const facts = await readReportFacts(depsOf({ stats, documents }), RUN);
    expect(facts.path).toEqual([
      { step: 'implement', mark: '', returned: false, reason: null, fix: null },
      { step: 'checks', mark: '❌', returned: true, reason: '`npm run lint`', fix: 'fixed' },
      { step: 'checks', mark: '✅', returned: false, reason: null, fix: null },
      { step: 'review', mark: '↩', returned: true, reason: 'security: A symlink could pull a host file.', fix: null },
      { step: 'review', mark: '⏳', returned: false, reason: null, fix: null },
    ]);
    expect(facts.returns).toEqual({ count: 2, fixed: false });
  });

  it('reports a run that went on after every return as all fixed', async () => {
    const stats = [visit(1, 'checks', 'waiting'), visit(2, 'implement', 'done'), visit(3, 'checks', 'done')];
    expect((await readReportFacts(depsOf({ stats }), RUN)).returns).toEqual({ count: 1, fixed: true });
  });

  it('reads the time to the day the run was done', async () => {
    const done = { ...RUN, doneAt: '2026-11-16T11:30:00.000Z' } as RunEntity;
    expect((await readReportFacts(depsOf(), done)).durationMs).toBe(90 * 60_000);
  });

  it('reads Tasks from the children and the time from the epic total', async () => {
    const child = (id: number, taskId: string, status: string, merge: object | null): RunEntity =>
      ({
        id,
        key: `K-${id}`,
        taskId,
        status,
        updatedAt: '2026-11-16T11:00:00.000Z',
        spentUsd: 0,
        mergeOutcome: merge && JSON.stringify(merge),
      }) as unknown as RunEntity;
    const documents = [
      doc('subtasks', [
        { id: 'a', title: 'Add the field', status: 'merged' },
        { id: 'b', title: 'Wire the route', status: 'running' },
      ]),
    ];
    const children = [child(2, 'a', 'done', { merged: { demo: {} } }), child(3, 'b', 'waiting', null)];
    const facts = await readReportFacts(depsOf({ documents, children }), {
      ...RUN,
      status: 'waiting',
      spentUsd: 0,
      updatedAt: '2026-11-16T10:10:00.000Z',
    });
    expect(facts.tasks).toEqual({
      merged: 1,
      total: 2,
      lines: ['Add the field: merged, 0', 'Wire the route: idle, 0'],
    });
    expect(facts.durationMs).toBe(Date.parse('2026-11-16T11:00:00.000Z') - Date.parse(RUN.createdAt));
  });

  it('leaves Tasks out for a run without subtask runs', async () => {
    expect((await readReportFacts(depsOf(), RUN)).tasks).toBeUndefined();
  });

  it("reads the exchange: the finding implement rejected, its reason, the answer and the person's decision", async () => {
    const question =
      'quality still returns: A test is missing. Implement answered: it is covered. Which holds? (asked 1)';
    const documents = [
      review('quality', 'return', { review: 'A test is missing.' }),
      doc('implementation_result', {
        implementation: ['x'],
        summary: ['s'],
        rejected: [{ reviewer: 'quality', finding: 'A test is missing.', reason: 'It is covered.' }],
      }),
      review('quality', 'return', { review: 'A test is missing.', reason: 'The cover does not run.' }),
      doc('review_questions', `- ${question}\n`),
      doc('answers', `question: ${question}\nanswer: Add the test.\n`),
    ];
    const facts = await readReportFacts(depsOf({ documents }), RUN);
    expect(facts.reviewers.find((reviewer) => reviewer.name === 'quality')?.exchange).toEqual({
      finding: 'A test is missing.',
      reason: 'It is covered.',
      answer: 'The cover does not run.',
      decision: 'Add the test.',
    });
    expect(facts.reviewers.find((reviewer) => reviewer.name === 'security')?.exchange).toBeNull();
  });

  it('drops the exchange once the reviewer accepted the answer', async () => {
    const documents = [
      review('quality', 'return'),
      doc('implementation_result', {
        implementation: ['x'],
        summary: ['s'],
        rejected: [{ reviewer: 'quality', finding: 'f', reason: 'r' }],
      }),
      review('quality', 'ok'),
    ];
    const facts = await readReportFacts(depsOf({ documents }), RUN);
    expect(facts.reviewers.find((reviewer) => reviewer.name === 'quality')?.exchange).toBeNull();
  });

  it('reads a stored value it cannot parse as a missing fact', async () => {
    const documents = [doc('requirement_list', 'not json'), doc('review_requirements_result', '{}')];
    const facts = await readReportFacts(depsOf({ documents }), RUN);
    expect([facts.requirements, facts.review]).toEqual([null, null]);
  });
});
