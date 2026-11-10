import 'reflect-metadata';

import { getRepositoryToken } from '@nestjs/typeorm';

import { mkdtemp } from 'fs/promises';

import { tmpdir } from 'os';

import { join } from 'path';

import type { Repository } from 'typeorm';

import { DocumentEntity, RunEntity } from '../../history/entities';

import { RunRepository } from '../../history/run.repository';

import { PipelineService } from '../../pipeline/pipeline.service';

import { boot, listen, requirementsBody, writeEnv } from './requirements.step.spec-helpers';

describe('requirements step', () => {
  it('does not move backward when an earlier step fails', async () => {
    const root = await mkdtemp(join(tmpdir(), 'swarmloop-rewind-'));
    const app = await boot(root, 'http://127.0.0.1:9', 'direct', jest.fn(), jest.fn());
    const runs = app.get(RunRepository);
    const seeded = await runs.begin('PROJ-6', 'requirements');
    seeded.status = 'waiting';
    seeded.currentStep = 'implement';
    await runs.saveRun(seeded);
    const documents = app.get<Repository<DocumentEntity>>(getRepositoryToken(DocumentEntity));
    await documents.save(
      documents.create({
        runId: seeded.id,
        stepStatId: 0,
        kind: 'repos',
        attempt: 1,
        body: '{}\n',
        path: '',
        createdAt: new Date().toISOString(),
      }),
    );
    try {
      const result = await app.get(PipelineService).step('branch', 'PROJ-6');
      expect(result.exitCode).toBe(1);
      expect(result.message).toContain('requirements is missing');
      const run = await runs.findRun('PROJ-6');
      expect(run?.currentStep).toBe('implement');
      expect(run?.status).toBe('waiting');
    } finally {
      await app.close();
    }
  });

  it('continues a run whose owner process is gone', async () => {
    const root = await mkdtemp(join(tmpdir(), 'swarmloop-dead-'));
    await writeEnv(root, '', 'direct', { JIRA_BASE_URL: '', JIRA_EMAIL: '', JIRA_API_TOKEN: '' });
    const app = await boot(root, '', 'direct', jest.fn(), jest.fn(), false);
    const runs = app.get(RunRepository);
    try {
      const seeded = await runs.begin('widget', 'requirements');
      seeded.status = 'running';
      seeded.ownerPid = 2_147_483_646;
      seeded.ownerInstance = null;
      seeded.prompt = 'Ship the widget\n';
      seeded.currentStep = 'requirements';
      await runs.saveRun(seeded);
      const result = await app.get(PipelineService).run('widget');
      expect(result.exitCode).toBe(0);
      expect(result.message).toContain('requirements done');
      const run = await runs.findRun('widget');
      expect(run?.currentStep).toBe('prepare');
      expect(run?.ownerPid).toBeNull();
    } finally {
      await app.close();
    }
  });

  it('refuses a second process while the run is running', async () => {
    const root = await mkdtemp(join(tmpdir(), 'swarmloop-lock-'));
    const app = await boot(root, 'http://127.0.0.1:9', 'direct', jest.fn(), jest.fn());
    await app.get(RunRepository).begin('PROJ-5', 'requirements');
    try {
      const result = await app.get(PipelineService).run('PROJ-5');
      expect(result.exitCode).toBe(1);
      expect(result.message).toContain('already running');
      const run = await app.get<Repository<RunEntity>>(getRepositoryToken(RunEntity)).findOneBy({ key: 'PROJ-5' });
      expect(run?.status).toBe('running');
    } finally {
      await app.close();
    }
  });

  it('reads no ticket for a subtask of a ticket run, from its key or its prompt', async () => {
    const hits: Record<string, number> = {};
    const server = await listen(200, 0, { issueHits: hits });
    const root = await mkdtemp(join(tmpdir(), 'swarmloop-subtask-req-'));
    const app = await boot(root, server.base, 'direct', jest.fn(), jest.fn());
    try {
      const runs = app.get(RunRepository);
      const parent = await runs.openWaiting('PROJ-2', '/target');
      await runs.openSubtask('PROJ-2-t1', parent.id, 't1');

      const result = await app
        .get(PipelineService)
        .step('requirements', 'PROJ-2-t1', { prompt: 'Add the field\n\nContext: PROJ-2 and PROJ-9\n' });

      expect(result.exitCode).toBe(0);
      expect(hits).toEqual({});
      const record = JSON.parse(await requirementsBody(app, 'PROJ-2-t1')) as { prompt: string };
      expect(record.prompt).toContain('Add the field');
    } finally {
      await app.close();
      await server.close();
    }
  });
});
