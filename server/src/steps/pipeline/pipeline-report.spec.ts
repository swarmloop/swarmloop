import {
  cancelErrorNote,
  ciResult,
  classify,
  parsePipelineRefs,
  renderFail,
  renderNone,
  renderPass,
  type Seen,
} from './pipeline-report';

function item(overrides: Partial<Seen> = {}): Seen {
  return {
    project: 'app',
    id: 5,
    sha: 'abc123',
    url: 'https://ci.example/5',
    status: 'success',
    jobs: [],
    ...overrides,
  };
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
    expect(cancelErrorNote([item({ status: 'running' })], ['app: pipeline id is missing'])).toBe(
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
});
