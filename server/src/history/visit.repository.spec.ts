import { writeRunState } from './run-state';
import { DocumentRepository } from './document.repository';
import { repositoryCall, repositoryDatabase, repositoryVisit } from './repository.spec-helpers';
import { RunRepository } from './run.repository';
import { VisitStartRepository } from './visit-start.repository';
import { AgentCallRepository } from './agent-call.repository';
import { LIMIT_VISIT, VisitRepository } from './visit.repository';
import { DataSource } from 'typeorm';

describe('VisitRepository', () => {
  it('keeps a per-visit record on each visit when their contents are identical', async () => {
    const db = await repositoryDatabase();
    try {
      const visits = db.app.get(VisitRepository);
      const run = await db.app.get(RunRepository).begin('run-errors', 'code-review');
      const visit = {
        ...repositoryVisit(),
        documents: [{ kind: 'answer_errors', fileName: '', body: '["decision: invalid"]\n', perVisit: true }],
      };
      const first = await visits.finishVisit(run, visit);
      const second = await visits.finishVisit(run, visit);
      const documents = await db.app.get(DocumentRepository).listDocuments(run.id);
      expect(documents.map((document) => document.stepStatId)).toEqual([first.id, second.id]);
    } finally {
      await db.close();
    }
  });

  it('reads the latest visit of each run with its id, kill reason, attempt and end time', async () => {
    const db = await repositoryDatabase();
    try {
      const visits = db.app.get(VisitRepository);
      const runs = db.app.get(RunRepository);
      const first = await runs.begin('run-latest-1', 'code-review');
      const second = await runs.begin('run-latest-2', 'code-review');
      const attempt = first.activeAttempt;
      await visits.finishVisit(first, { ...repositoryVisit(), killReason: 'timeout' });
      const last = (await visits.finalize(attempt, first, { ...repositoryVisit(), killReason: 'process died' }))!;
      const other = await visits.finishVisit(second, repositoryVisit());

      const latest = await visits.latestVisits([first.id, second.id]);

      expect(latest.get(first.id)).toMatchObject({
        id: last.id,
        killReason: 'process died',
        attemptId: attempt,
        finishedAt: last.finishedAt,
      });
      expect(latest.get(second.id)).toMatchObject({ id: other.id });
      expect(await visits.latestVisits([])).toEqual(new Map());
    } finally {
      await db.close();
    }
  });

  it('ends the relaunch of a cut visit with the run and the note in one write, and not when the run moved', async () => {
    const db = await repositoryDatabase();
    try {
      const visits = db.app.get(VisitRepository);
      const runs = db.app.get(RunRepository);
      const begun = await runs.begin('run-ended', 'code-review');
      const note = { at: '2026-11-14T20:29:00.000Z', relaunched: true };
      const cut = await visits.finalize(begun.activeAttempt, begun, {
        ...repositoryVisit(),
        killReason: 'process died',
        documents: [{ kind: 'interruption', fileName: '', body: JSON.stringify(note) }],
      });
      const ended = { ...note, relaunched: false, cause: 'start' as const };
      const noteOf = async () =>
        (await db.app.get(DocumentRepository).listDocuments(begun.id)).find(
          (document) => document.kind === 'interruption' && document.stepStatId === cut!.id,
        )?.body;

      const stale = { ...begun, revision: begun.revision - 1 };
      writeRunState(stale, { status: 'failed', ownerPid: null });
      expect(await visits.endRelaunch(stale, cut!, ended, note.at)).toBe(false);
      expect(JSON.parse((await noteOf())!)).toEqual(note);

      const fresh = (await runs.findRun('run-ended'))!;
      writeRunState(fresh, { status: 'failed', ownerPid: null });
      expect(await visits.endRelaunch(fresh, cut!, ended, note.at)).toBe(true);
      expect((await runs.findRun('run-ended'))!.status).toBe('failed');
      expect(JSON.parse((await noteOf())!)).toEqual(ended);
    } finally {
      await db.close();
    }
  });

  it('ends a relaunch of a held copy without setting back a generation written since', async () => {
    const db = await repositoryDatabase();
    try {
      const visits = db.app.get(VisitRepository);
      const runs = db.app.get(RunRepository);
      const begun = await runs.begin('run-held', 'code-review');
      const note = { at: '2026-11-14T20:29:00.000Z', relaunched: true };
      const cut = await visits.finalize(begun.activeAttempt, begun, {
        ...repositoryVisit(),
        killReason: 'process died',
        documents: [{ kind: 'interruption', fileName: '', body: JSON.stringify(note) }],
      });
      const held = (await runs.findRun('run-held'))!;
      await runs.bumpGeneration('run-held');
      held.prompt = 'changed';
      expect(await visits.endRelaunch(held, cut!, { ...note, relaunched: false, cause: 'start' }, note.at)).toBe(true);
      expect(await runs.findRun('run-held')).toEqual(expect.objectContaining({ prompt: 'changed', generation: 1 }));
      expect(held.generation).toBe(1);
    } finally {
      await db.close();
    }
  });

  it('creates a visit with related rows, reads it and updates its stat', async () => {
    const db = await repositoryDatabase();
    try {
      const visits = db.app.get(VisitRepository);
      const runs = db.app.get(RunRepository);
      const run = await runs.begin('run-1', 'code-review');
      const stat = await visits.finishVisit(run, { ...repositoryVisit(), callIds: [await repositoryCall(db.app)] });
      expect(await visits.listStats(run.id)).toEqual([stat]);
      expect(await visits.listSamples([stat.id])).toEqual([
        expect.objectContaining({ stepStatId: stat.id, cpuPercent: 10, rssBytes: 100 }),
      ]);
      expect(await visits.listExchanges([stat.id])).toEqual([
        expect.objectContaining({ stepStatId: stat.id, chatId: 'chat-1' }),
      ]);
      expect(await visits.codeReviewReportMs(run.id)).toEqual(new Map([[stat.id, 1000]]));
      expect(await runs.durationByRun()).toEqual(new Map([[run.id, 1000]]));
      expect(await db.app.get(DocumentRepository).latestBody(run.key, 'review_report')).toBe('first report');
      stat.tokensOut = 8;
      await visits.saveStat(stat);
      expect((await visits.listStats(run.id))[0].tokensOut).toBe(8);
      const second = await visits.finishVisit(run, repositoryVisit());
      expect(second.attempt).toBe(2);
      expect(await db.app.get(DocumentRepository).listDocuments(run.id)).toHaveLength(1);
      expect(await visits.listSamples([])).toEqual([]);
      expect(await visits.listExchanges([])).toEqual([]);
    } finally {
      await db.close();
    }
  });

  it('counts a visit the step made itself, and not one started from outside the step', async () => {
    const db = await repositoryDatabase();
    try {
      const visits = db.app.get(VisitRepository);
      const starts = db.app.get(VisitStartRepository);
      const run = await db.app.get(RunRepository).begin('run-outside', 'plan');
      const turn = await visits.finishVisit(run, {
        ...repositoryVisit(),
        step: 'plan',
        callIds: [await repositoryCall(db.app)],
      });
      await starts.note({
        runId: run.id,
        step: 'plan',
        attemptId: 'turn-1',
        startedBy: 'person',
        level: null,
        inputDigest: null,
        startReason: null,
        rerunUnfinished: false,
        outside: true,
        statId: turn.id,
        createdAt: '2026-01-01T00:00:00.000Z',
      });
      expect(await visits.hasAgentVisit(run.id, 'plan')).toBe(true);
      expect(await visits.hasStepVisit(run.id, 'plan')).toBe(false);
      await visits.finishVisit(run, { ...repositoryVisit(), step: 'plan', callIds: [await repositoryCall(db.app)] });
      expect(await visits.hasStepVisit(run.id, 'plan')).toBe(true);
    } finally {
      await db.close();
    }
  });

  it('links exactly the rows of its callIds and writes no exchange row of its own', async () => {
    const db = await repositoryDatabase();
    try {
      const visits = db.app.get(VisitRepository);
      const run = await db.app.get(RunRepository).begin('run-links', 'plan');
      const linked = [await repositoryCall(db.app), await repositoryCall(db.app)];
      const other = await repositoryCall(db.app);
      const stat = await visits.finishVisit(run, { ...repositoryVisit(), callIds: linked });
      expect((await visits.listExchanges([stat.id])).map((row) => row.id)).toEqual(linked);
      const all = await db.app
        .get(DataSource)
        .query('SELECT id, step_stat_id AS statId FROM agent_exchanges ORDER BY id');
      expect(all).toEqual([
        { id: linked[0], statId: stat.id },
        { id: linked[1], statId: stat.id },
        { id: other, statId: 0 },
      ]);
    } finally {
      await db.close();
    }
  });

  it('keeps the rows of a limited visit with it and gives the visit after it its own', async () => {
    const db = await repositoryDatabase();
    try {
      const visits = db.app.get(VisitRepository);
      const run = await db.app.get(RunRepository).begin('run-limited', 'plan');
      const limitedRows = [await repositoryCall(db.app)];
      const nextRows = [await repositoryCall(db.app), await repositoryCall(db.app)];
      const limited = await visits.finishVisit(run, { ...repositoryVisit(), ...LIMIT_VISIT, callIds: limitedRows });
      const next = await visits.finishVisit(run, { ...repositoryVisit(), callIds: nextRows });
      expect((await visits.listExchanges([limited.id])).map((row) => row.id)).toEqual(limitedRows);
      expect((await visits.listExchanges([next.id])).map((row) => row.id)).toEqual(nextRows);
    } finally {
      await db.close();
    }
  });

  it('keeps the rows a limited visit holds when the next visit lists them again', async () => {
    const db = await repositoryDatabase();
    try {
      const visits = db.app.get(VisitRepository);
      const run = await db.app.get(RunRepository).begin('run-chain', 'plan');
      const limitedRow = await repositoryCall(db.app);
      const nextRow = await repositoryCall(db.app);
      const limited = await visits.finishVisit(run, { ...repositoryVisit(), ...LIMIT_VISIT, callIds: [limitedRow] });
      const next = await visits.finishVisit(run, { ...repositoryVisit(), callIds: [limitedRow, nextRow] });
      expect((await visits.listExchanges([limited.id])).map((row) => row.id)).toEqual([limitedRow]);
      expect((await visits.listExchanges([next.id])).map((row) => row.id)).toEqual([nextRow]);
    } finally {
      await db.close();
    }
  });

  it('sums the report time of the calls of a code-review visit and not of its helpers', async () => {
    const db = await repositoryDatabase();
    try {
      const visits = db.app.get(VisitRepository);
      const calls = db.app.get(AgentCallRepository);
      const run = await db.app.get(RunRepository).begin('run-helper-time', 'code-review');
      const call = await repositoryCall(db.app);
      const helper = await calls.open({
        kind: 'helper',
        parentId: call,
        startedAt: '2026-01-01T00:00:00.000Z',
        resumed: false,
        runtime: 'claude',
        model: 'test-model',
        requestText: '',
      });
      await calls.finish(helper, {
        endKind: 'done',
        finishedAt: '2026-01-01T00:00:01.000Z',
        durationMs: 1000,
        responseText: '',
      });
      const stat = await visits.finishVisit(run, { ...repositoryVisit(), callIds: [call, helper] });
      expect(await visits.codeReviewReportMs(run.id)).toEqual(new Map([[stat.id, 1000]]));
    } finally {
      await db.close();
    }
  });

  it('links nothing for a visit that ran no agent', async () => {
    const db = await repositoryDatabase();
    try {
      const visits = db.app.get(VisitRepository);
      const run = await db.app.get(RunRepository).begin('run-no-agent', 'plan');
      const stat = await visits.finishVisit(run, repositoryVisit());
      expect(await visits.listExchanges([stat.id])).toEqual([]);
      expect(await visits.hasAgentVisit(run.id, 'code-review')).toBe(false);
    } finally {
      await db.close();
    }
  });

  it('records the runtime of the agent next to its model, and null for a visit that names none', async () => {
    const db = await repositoryDatabase();
    try {
      const visits = db.app.get(VisitRepository);
      const run = await db.app.get(RunRepository).begin('run-1', 'code-review');
      await visits.finishVisit(run, { ...repositoryVisit(), runtime: 'codex', model: 'gpt-6.1-sol' });
      await visits.finishVisit(run, repositoryVisit());
      const stats = await visits.listStats(run.id);
      expect(stats.map((stat) => stat.runtime)).toEqual(['codex', null]);
      expect(stats[0].model).toBe('gpt-6.1-sol');
    } finally {
      await db.close();
    }
  });

  it('records the effort of a visit and why, and null for a visit that names none', async () => {
    const db = await repositoryDatabase();
    try {
      const visits = db.app.get(VisitRepository);
      const run = await db.app.get(RunRepository).begin('run-effort', 'code-review');
      await visits.finishVisit(run, { ...repositoryVisit(), effort: 'high', effortNote: 'epic' });
      await visits.finishVisit(run, repositoryVisit());
      const stats = await visits.listStats(run.id);
      expect(stats.map((stat) => stat.effort)).toEqual(['high', null]);
      expect(stats.map((stat) => stat.effortNote)).toEqual(['epic', null]);
    } finally {
      await db.close();
    }
  });

  it('keeps the content a checks visit ran on, and reads the newest checks visit', async () => {
    const db = await repositoryDatabase();
    try {
      const visits = db.app.get(VisitRepository);
      const run = await db.app.get(RunRepository).begin('run-checked', 'checks');
      expect(await visits.latestChecked(run.id)).toBeNull();
      await visits.finishVisit(run, { ...repositoryVisit(), step: 'checks', checkedCommits: { 'g/p': 'tree-1' } });
      expect(await visits.latestChecked(run.id)).toEqual({ 'g/p': 'tree-1' });
      await visits.finishVisit(run, { ...repositoryVisit(), step: 'checks' });
      expect(await visits.latestChecked(run.id)).toBeNull();
    } finally {
      await db.close();
    }
  });
});
