import 'reflect-metadata';

import { mkdtemp } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';

import { DocumentRepository } from '../../history/document.repository';
import { RunRepository } from '../../history/run.repository';
import type { PipelineRef } from '../../integrations/code-host/code-host';
import { PipelineService } from '../../pipeline/pipeline.service';
import { boot, call, one, seed, shot } from './pipeline.step.spec-helpers';

const KEY = 'PROJ-340';
const PASSED = shot('success', [{ id: 1, name: 'test', stage: 'test', status: 'success', allowFailure: false }]);

async function bootRun(prefix: string, delivery: string, body = one) {
  const root = await mkdtemp(join(tmpdir(), prefix));
  const read = jest.fn((_ref: PipelineRef) => Promise.resolve({ snapshot: PASSED, httpCalls: [call('GET')] }));
  const app = await boot(root, read, jest.fn());
  await seed(app, KEY, body);
  const run = await app.get(RunRepository).findRun(KEY);
  await app.get(DocumentRepository).putDocument(run!, 'delivery', delivery);
  return { app, read, run: run! };
}

describe('pipeline step and the delivery list', () => {
  it('fails naming a repository still publishing and watches nothing', async () => {
    const { app, read } = await bootRun('swarmloop-pipe-publishing-', 'demo publishing\nweb read\n');
    try {
      const result = await app.get(PipelineService).step('pipeline', KEY);
      expect(result.exitCode).toBe(1);
      expect(result.message).toContain('demo has work but no merge request yet');
      expect(result.message).not.toContain('web');
      expect(read).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });

  it('watches only the published repository and ends done when the others are read', async () => {
    const { app, read } = await bootRun('swarmloop-pipe-read-', 'demo published group/demo\nweb read\n');
    try {
      const result = await app.get(PipelineService).step('pipeline', KEY);
      expect(result.exitCode).toBe(0);
      expect(result.message).toContain('pipeline done');
      expect(read.mock.calls.map(([ref]) => ref.project)).toEqual(['group/demo']);
      expect((await app.get(RunRepository).findRun(KEY))?.status).toBe('done');
    } finally {
      await app.close();
    }
  });

  it('a CI-skipped run still ends skipped', async () => {
    const { app, read, run } = await bootRun('swarmloop-pipe-ci-skip-', 'demo publishing\n', '');
    try {
      await app.get(DocumentRepository).putDocument(run, 'ci_skip', 'CI skipped: there is no origin to push.\n');
      const result = await app.get(PipelineService).step('pipeline', KEY);
      expect(result.exitCode).toBe(0);
      expect(result.message).toContain('CI skipped: there is no origin to push.');
      expect(read).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });
});
