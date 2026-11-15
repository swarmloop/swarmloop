import { mkdtemp, readFile, rm } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { saveJobTrace } from './job-trace-log';
import { renderFail } from './pipeline-failure-report';
import type { Failure } from './pipeline-report';

describe('saving a job trace', () => {
  let root = '';

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'swarmloop-job-trace-'));
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('saves the whole trace and marks the readable end that points to it', async () => {
    const lines = Array.from({ length: 500 }, (_, index) => `failure line ${index}`);
    const trace = ['section_start:1:step_script', ...lines, 'section_end:2:step_script', 'after'].join('\n');
    const failure: Failure = {
      project: 'app',
      pipelineId: 5,
      name: 'test',
      stage: 'test',
      url: '',
      trace,
    };

    const path = saveJobTrace(root, 'run-1', '2', 3, failure);

    expect(path).toBe('/work/logs/pipeline-2-job-3-log.txt');
    const saved = await readFile(join(root, 'data', 'run-logs', 'run-1', 'pipeline-2-job-3-log.txt'), 'utf8');
    expect(saved.split('\n')).toEqual(lines);

    const body = renderFail([{ ...failure, log: path }], []);
    expect(body).toContain(`… 300 earlier lines not shown; the whole output: ${path}\n${lines.slice(-200).join('\n')}`);
  });
});
