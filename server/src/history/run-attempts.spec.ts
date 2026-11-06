import { Logger } from '@nestjs/common';
import { getDataSourceToken } from '@nestjs/typeorm';
import type { DataSource } from 'typeorm';
import { SERVER_INSTANCE } from '../core/server-instance';
import { HttpCallEntity, ResourceSampleEntity, StepStatEntity, AgentExchangeEntity, DocumentEntity } from './entities';
import { repositoryDatabase, repositoryVisit } from './repository.spec-helpers';
import { RunRepository } from './run.repository';
import { VisitRepository } from './visit.repository';

async function setup() {
  const database = await repositoryDatabase();
  const runs = database.app.get(RunRepository);
  const visits = database.app.get(VisitRepository);
  const dataSource = database.app.get<DataSource>(getDataSourceToken());
  return { database, runs, visits, dataSource };
}

async function rowCounts(dataSource: DataSource): Promise<number[]> {
  const entities = [StepStatEntity, DocumentEntity, ResourceSampleEntity, AgentExchangeEntity, HttpCallEntity];
  return Promise.all(entities.map((entity) => dataSource.getRepository(entity).count()));
}

describe('run attempts', () => {
  it('lets one of two concurrent claims of a new key win', async () => {
    const { database, runs } = await setup();
    try {
      const results = await Promise.allSettled([runs.claim('A-1', 'research'), runs.claim('A-1', 'research')]);
      expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
      const lost = results.find((result) => result.status === 'rejected');
      expect(String((lost as PromiseRejectedResult).reason)).toContain('A-1 is already running');
    } finally {
      await database.close();
    }
  });

  it('lets one of two concurrent claims of an existing run win', async () => {
    const { database, runs } = await setup();
    try {
      const run = await runs.openWaiting('A-2', '/tmp/a');
      const results = await Promise.allSettled([runs.claim('A-2', 'research'), runs.claim('A-2', 'research')]);
      expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
      const lost = results.find((result) => result.status === 'rejected');
      expect(String((lost as PromiseRejectedResult).reason)).toContain('A-2 is already running');
      const claimed = await runs.findRun('A-2');
      expect(claimed).toMatchObject({ status: 'running', revision: run.revision + 1, ownerInstance: SERVER_INSTANCE });
      expect(claimed?.activeAttempt).toEqual(expect.any(String));
    } finally {
      await database.close();
    }
  });

  it('stores one visit and counts the spend once when an attempt is finalized twice', async () => {
    const { database, runs, visits, dataSource } = await setup();
    try {
      const run = await runs.begin('A-3', 'code-review');
      const attemptId = run.activeAttempt as string;
      run.agentCalls = 2;
      run.spentUsd = 1.5;
      run.status = 'done';
      const first = await visits.finalize(attemptId, run, repositoryVisit());
      const second = await visits.finalize(attemptId, run, repositoryVisit());
      expect(second?.id).toBe(first?.id);
      expect(await dataSource.getRepository(StepStatEntity).count()).toBe(1);
      expect(await runs.findRun('A-3')).toMatchObject({
        status: 'done',
        agentCalls: 2,
        spentUsd: 1.5,
        ownerPid: null,
        stepStartedAt: null,
        activeAttempt: null,
        revision: 1,
      });
      expect(run.activeAttempt).toBeNull();
    } finally {
      await database.close();
    }
  });

  it('keeps no visit row when a write of the finalize fails', async () => {
    const { database, runs, visits, dataSource } = await setup();
    try {
      const run = await runs.begin('A-4', 'code-review');
      const before = await runs.findRun('A-4');
      run.status = 'done';
      const visit = repositoryVisit();
      visit.httpCalls = [
        { provider: 'other', method: 'GET', url: null as never, statusCode: 200, durationMs: 1, error: null },
      ];
      await expect(visits.finalize(run.activeAttempt as string, run, visit)).rejects.toThrow();
      expect(await rowCounts(dataSource)).toEqual([0, 0, 0, 0, 0]);
      expect(await runs.findRun('A-4')).toEqual(before);
    } finally {
      await database.close();
    }
  });

  it('leaves the run alone for a stale finalize and returns its current state', async () => {
    const { database, runs, visits, dataSource } = await setup();
    try {
      const stale = await runs.begin('A-5', 'code-review');
      const staleAttempt = stale.activeAttempt as string;
      await dataSource.getRepository('RunEntity').update({ key: 'A-5' }, { status: 'waiting', activeAttempt: null });
      const current = await runs.begin('A-5', 'qa');
      const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation();
      stale.status = 'done';
      const result = await visits.finalize(staleAttempt, stale, repositoryVisit());
      expect(result).toBeNull();
      expect(warn).toHaveBeenCalledWith(`stale attempt ${staleAttempt} of A-5`);
      expect(await rowCounts(dataSource)).toEqual([0, 0, 0, 0, 0]);
      expect(await runs.findRun('A-5')).toEqual(current);
      expect(stale).toMatchObject({ status: 'running', currentStep: 'qa', activeAttempt: current.activeAttempt });
      warn.mockRestore();
    } finally {
      await database.close();
    }
  });

  it('holds a run of this instance while an attempt is active, and releases it on finalize', async () => {
    const { database, runs, visits } = await setup();
    try {
      const run = await runs.begin('A-6', 'research');
      run.ownerPid = null;
      expect(runs.held(run)).toBe(true);
      run.ownerInstance = 'another-instance';
      expect(runs.held(run)).toBe(false);
      run.ownerInstance = SERVER_INSTANCE;
      run.status = 'running';
      await visits.finalize(run.activeAttempt as string, run, repositoryVisit());
      expect(runs.held(run)).toBe(false);
    } finally {
      await database.close();
    }
  });
});
