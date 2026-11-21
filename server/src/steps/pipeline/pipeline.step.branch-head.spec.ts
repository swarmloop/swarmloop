import 'reflect-metadata';
import { mkdirSync } from 'fs';
import { mkdtemp, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { RunRepository } from '../../history/run.repository';
import { storedState } from '../../history/run-state';
import { DocumentRepository } from '../../history/document.repository';
import { PipelineService } from '../../pipeline/pipeline.service';
import type { PipelineRef } from '../../integrations/code-host/code-host';
import { shot, job, call, boot, fakeWait, seed, restore } from './pipeline.step.spec-helpers';

const recorded = (sha: string): string => `project: group/demo\nref: feature/PROJ-300-ship\nsha: ${sha}\n`;

/** The host says `old` has a green run and the branch head is `next`. */
function headMoved(next: string, headSnapshot: ReturnType<typeof shot> | null) {
  const read = jest.fn((ref: PipelineRef) =>
    Promise.resolve({
      snapshot: ref.sha === next ? headSnapshot : shot('success', []),
      httpCalls: [call('GET')],
    }),
  );
  const readBranchHead = jest.fn(() => Promise.resolve({ sha: next, httpCalls: [call('GET')] }));
  return { read, readBranchHead };
}

describe('pipeline step on a branch whose head moved', () => {
  afterEach(() => jest.restoreAllMocks());

  it('judges the CI of the branch head and not the green of an older sha', async () => {
    const root = await mkdtemp(join(tmpdir(), 'swarmloop-pipe-head-red-'));
    const { read, readBranchHead } = headMoved('new', shot('failed', [job(7, 'lint', false)]));
    const trace = jest.fn(() => Promise.resolve({ trace: 'lint failed\n', httpCalls: [call('GET')] }));
    const app = await boot(root, read, trace, undefined, undefined, undefined, { readBranchHead });
    try {
      await seed(app, 'PROJ-320', recorded('old'));
      const result = await app.get(PipelineService).step('pipeline', 'PROJ-320');
      expect(result.exitCode).toBe(0);
      const run = await app.get(RunRepository).findRun('PROJ-320');
      expect(run?.currentStep).toBe('implement');
      expect(run?.status).toBe('waiting');
      const log = await app.get(DocumentRepository).latestBody('PROJ-320', 'pipeline_log');
      expect(log).toContain('result: fail');
      expect(log).toContain('job: lint');
      expect(log).toContain('lint failed');
    } finally {
      await app.close();
    }
  });

  it('waits for the CI of the branch head when it has no run, while the older sha is green', async () => {
    const root = await mkdtemp(join(tmpdir(), 'swarmloop-pipe-head-wait-'));
    const { read, readBranchHead } = headMoved('new', null);
    const previousTick = process.env.TICK_MS;
    const previousTimeout = process.env.PIPELINE_TIMEOUT_MS;
    const previousStart = process.env.PIPELINE_START_TIMEOUT_MS;
    const clock = fakeWait();
    const app = await boot(
      root,
      read,
      jest.fn(),
      'TICK_MS=1\nPIPELINE_START_TIMEOUT_MS=50\nPIPELINE_TIMEOUT_MS=1500\n',
      undefined,
      clock,
      { readBranchHead },
    );
    try {
      await seed(app, 'PROJ-321', recorded('old'));
      const run = await app.get(RunRepository).findRun('PROJ-321');
      await app.get(DocumentRepository).putDocument(run!, 'repos', 'demo\n');
      const workflow = join(root, 'worktrees', 'PROJ-321', 'demo', '.github', 'workflows');
      mkdirSync(workflow, { recursive: true });
      await writeFile(join(workflow, 'test.yml'), 'name: Test\non: push\n');
      await app.get(PipelineService).step('pipeline', 'PROJ-321');
      const after = await app.get(RunRepository).findRun('PROJ-321');
      expect(after?.status).toBe('waiting');
      expect(storedState(after!).reason?.code).toBe('CI_NOT_STARTED');
      const log = await app.get(DocumentRepository).latestBody('PROJ-321', 'pipeline_log');
      expect(log).toContain('sha: new');
      expect(log).not.toContain('result: pass');
    } finally {
      restore('TICK_MS', previousTick);
      restore('PIPELINE_TIMEOUT_MS', previousTimeout);
      restore('PIPELINE_START_TIMEOUT_MS', previousStart);
      await app.close();
    }
  });
});
