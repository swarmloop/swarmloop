import {
  cancelErrorNote,
  ciResult,
  checkFacts,
  checkTrace,
  classify,
  parsePipelineRefs,
  renderFail,
  renderNone,
  renderPass,
  verdictOf,
  type Seen,
} from './pipeline-report';

function item(overrides: Partial<Seen> = {}): Seen {
  const seen = {
    project: 'app',
    id: 5,
    sha: 'abc123',
    url: 'https://ci.example/5',
    status: 'success',
    jobs: [],
    checks: [],
    awaiting: [],
    ...overrides,
  };
  return { runs: [{ id: 5, status: seen.status, url: seen.url, jobs: seen.jobs }], ...seen };
}

describe('pipeline report', () => {
  it('renders a pass with each project, its pipeline, sha and warnings', () => {
    expect(renderPass([item()], ['app lint'])).toBe(
      'result: pass\nproject: app\npipeline: 5\nsha: abc123\nwarning: app lint\n',
    );
  });

  it('renders none with the projects that did not start', () => {
    expect(renderNone([item()])).toBe('result: none\nnothing started\nproject: app\n');
  });

  it('lists the failed and canceled pipelines when no job trace was read', () => {
    const text = renderFail([], [item({ status: 'failed' }), item({ project: 'lib' })], 'stopped');
    expect(text).toBe('stopped\nresult: fail\nproject: app\npipeline: 5\nstatus: failed\nurl: https://ci.example/5\n');
  });

  it('renders each failed job with its readable trace', () => {
    const failure = { project: 'app', pipelineId: 5, name: 'lint', stage: 'test', url: '', trace: 'boom' };
    expect(renderFail([failure], [item({ status: 'failed' })])).toBe(
      'result: fail\nproject: app\npipeline: 5\njob: lint\nstage: test\n\nboom\n',
    );
  });

  it('renders a cancel note with a placeholder job when none is named', () => {
    expect(
      cancelErrorNote(
        [{ project: 'app', id: 5, status: 'running', url: 'https://ci.example/5', jobs: [] }],
        ['app: pipeline id is missing'],
      ),
    ).toBe(
      'result: fail\nproject: app\npipeline: 5\nurl: https://ci.example/5\njob: running\ncancel: app: pipeline id is missing',
    );
  });

  it('reads project, ref and sha from each pipeline ref block', () => {
    expect(parsePipelineRefs('project: app\nref: main\nsha: abc123\nproject: lib\nref: dev\n')).toEqual([
      { project: 'app', ref: 'main', sha: 'abc123' },
      { project: 'lib', ref: 'dev', sha: '' },
    ]);
  });

  describe('classify', () => {
    const jobs = (...statuses: string[]) =>
      item({
        status: 'failed',
        jobs: statuses.map((status, index) => ({
          id: index,
          name: `j${index}`,
          stage: '',
          status,
          allowFailure: false,
        })),
      });

    it('takes an empty job list as a failure', () => {
      expect(classify([item({ status: 'failed' })])).toBe('failed');
    });

    it('lets a failed job win over jobs that never ran', () => {
      expect(classify([jobs('queued', 'failed')])).toBe('failed');
    });

    it('calls jobs that never ran not-run', () => {
      expect(classify([jobs('queued', 'pending')])).toBe('not-run');
      expect(classify([jobs('timed_out', 'startup_failure')])).toBe('not-run');
      expect(classify([jobs('canceled')])).toBe('not-run');
    });

    it('calls only timed-out jobs a timeout', () => {
      expect(classify([jobs('timed_out')])).toBe('timeout');
    });
  });

  it('labels a finished run with no failed job as not run', () => {
    const seen = [
      item({ status: 'failed', jobs: [{ id: 1, name: 'a', stage: '', status: 'queued', allowFailure: false }] }),
    ];
    expect(ciResult({ seen, verdict: 'red' })).toBe('did not run: app');
  });

  describe('checks without a workflow', () => {
    const check = {
      id: 31,
      name: 'Code scanning results',
      app: 'CodeQL',
      status: 'failed' as const,
      durationMs: 0,
      url: '',
      summary: '2 alerts',
      annotations: [
        { path: 'a.ts', line: 3, level: 'failure', title: 'Injection', message: 'first' },
        { path: 'b.ts', line: 9, level: 'warning', title: '', message: 'second' },
      ],
      workflow: false,
    };

    it('reads a failed app check as a defect even when a job never started', () => {
      const queued = { id: 1, name: 'a', stage: '', status: 'queued', allowFailure: false };
      expect(classify([item({ status: 'failed', jobs: [queued], checks: [check] })])).toBe('failed');
    });

    it('writes the summary and one line per annotation', () => {
      expect(checkTrace(check)).toBe('2 alerts\na.ts:3 failure Injection: first\nb.ts:9 warning second');
    });

    it('renders an app check whole, with its name and app', () => {
      const lines = Array.from({ length: 300 }, (_, index) => `x.ts:${index} failure t: m`).join('\n');
      const failure = {
        project: 'app',
        pipelineId: 31,
        name: 'CodeQL / Code scanning results',
        stage: '',
        url: '',
        trace: lines,
        check: true as const,
      };
      expect(renderFail([failure], [item({ status: 'failed' })])).toContain(`\n\n${lines}\n`);
    });

    it('waits while a check is expected and keeps its checks out of the facts when none were listed', () => {
      expect(verdictOf([item({ awaiting: ['Code scanning results'] })])).toBe('wait');
      expect(checkFacts([item()])).toEqual({});
      expect(checkFacts([item({ checks: [check] })]).checks?.[0]).toMatchObject({ name: 'Code scanning results' });
    });
  });
});
