import Database from 'better-sqlite3';
import { existsSync, mkdirSync, writeFileSync } from 'fs';
import { join } from 'path';
import { DocumentRepository } from './document.repository';
import { root, runDir } from './run-paths';
import { repositoryDatabase, repositoryVisit } from './repository.spec-helpers';
import { RunRepository } from './run.repository';
import { storedState, writeRunState } from './run-state';
import { storeRun } from '../testing/store-run.spec-helpers';
import { VisitRepository } from './visit.repository';

describe('RunRepository', () => {
  it('creates, reads, updates and removes a run through the facade', async () => {
    const db = await repositoryDatabase();
    try {
      const runs = db.app.get(RunRepository);
      const run = await runs.openWaiting('run-1', '/target');
      expect(await runs.findRun(run.key)).toEqual(run);
      expect(await runs.listRuns()).toEqual([run]);
      expect(runs.held(run)).toBe(false);
      db.clock.advance(1000);
      run.prompt = 'updated';
      await storeRun(runs, run);
      expect((await runs.findRun(run.key))?.prompt).toBe('updated');
      expect((await runs.findRun(run.key))?.updatedAt).toBe(db.clock.iso());
      db.config.env.AGENTS_IMPLEMENT = 'codex:gpt-6.1-sol';
      const started = await runs.begin(run.key, 'research');
      expect(started.status).toBe('running');
      expect(started.runtime).toBe('codex');
      expect(runs.held(started)).toBe(true);
      await expect(runs.begin(run.key, 'research')).rejects.toThrow('run-1 is already running');
      expect(root(db.config)).toBe(db.root);
      expect(runDir(db.config, run.key)).toBe(join(db.root, 'runs', run.key));
      expect(await runs.durationByRun()).toEqual(new Map());
      await runs.remove(started);
      expect(await runs.findRun(run.key)).toBeNull();
    } finally {
      await db.close();
    }
  });

  it('records the base tip of each repository and keeps the ones recorded before', async () => {
    const db = await repositoryDatabase();
    try {
      const runs = db.app.get(RunRepository);
      const run = await runs.openWaiting('run-1', '/target');
      expect((await runs.findRun(run.key))?.baseTips).toBeNull();
      await runs.recordBaseTips(run.key, { web: 'aaa' });
      await runs.recordBaseTips(run.key, { api: 'bbb' });
      await runs.recordBaseTips('missing', { web: 'ccc' });
      expect((await runs.findRun(run.key))?.baseTips).toEqual({ web: 'aaa', api: 'bbb' });
    } finally {
      await db.close();
    }
  });

  it('writes only what the copy changed, so a change made since it was read stays', async () => {
    const db = await repositoryDatabase();
    try {
      const runs = db.app.get(RunRepository);
      await runs.openWaiting('run-1', '/target');
      const copy = (await runs.findRun('run-1'))!;
      await runs.markWorkspaceRemoved('run-1');
      await runs.bumpGeneration('run-1');
      copy.prompt = 'new';
      const saved = await storeRun(runs, copy);
      const row = (await runs.findRun('run-1'))!;
      expect(row).toEqual(expect.objectContaining({ prompt: 'new', workspace: 'removed', generation: 1 }));
      expect(saved).toEqual(row);
    } finally {
      await db.close();
    }
  });

  it('changes a run and returns the stored row', async () => {
    const db = await repositoryDatabase();
    try {
      const runs = db.app.get(RunRepository);
      await runs.openWaiting('run-1', '/target');
      db.clock.advance(1000);
      const changed = await runs.change('run-1', (run) => {
        run.prompt = 'new';
      });
      expect(changed).toEqual((await runs.findRun('run-1'))!);
      expect(changed).toEqual(expect.objectContaining({ prompt: 'new', updatedAt: db.clock.iso() }));
    } finally {
      await db.close();
    }
  });

  it('writes nothing for a change that changes nothing', async () => {
    const db = await repositoryDatabase();
    try {
      const runs = db.app.get(RunRepository);
      const opened = await runs.openWaiting('run-1', '/target');
      db.clock.advance(1000);
      const same = await runs.change('run-1', (run) => {
        run.prompt = null;
      });
      expect(same.updatedAt).toBe(opened.updatedAt);
      expect((await runs.findRun('run-1'))!.updatedAt).toBe(opened.updatedAt);
    } finally {
      await db.close();
    }
  });

  function otherWriter(db: { root: string }, sql: string): void {
    const other = new Database(join(db.root, 'data', 'swarmloop.sqlite'));
    try {
      other.prepare(sql).run();
    } finally {
      other.close();
    }
  }

  it('applies a change again on the new row when it lost to a write of the same column', async () => {
    const db = await repositoryDatabase();
    try {
      const runs = db.app.get(RunRepository);
      await runs.openWaiting('run-1', '/target');
      const seen: Array<string | null> = [];
      const changed = await runs.change('run-1', (run) => {
        seen.push(run.prompt);
        if (seen.length === 1) otherWriter(db, "UPDATE runs SET prompt = 'other'");
        run.prompt = `${run.prompt ?? ''}+mine`;
      });
      expect(seen).toEqual([null, 'other']);
      expect(changed.prompt).toBe('other+mine');
      expect((await runs.findRun('run-1'))!.prompt).toBe('other+mine');
    } finally {
      await db.close();
    }
  });

  it('throws an error naming the run and the columns after three lost tries', async () => {
    const db = await repositoryDatabase();
    try {
      const runs = db.app.get(RunRepository);
      await runs.openWaiting('run-1', '/target');
      let calls = 0;
      await expect(
        runs.change('run-1', (run) => {
          calls += 1;
          otherWriter(db, `UPDATE runs SET prompt = 'other ${calls}'`);
          run.prompt = 'mine';
        }),
      ).rejects.toThrow('run-1: prompt changed under every one of three tries; nothing was written');
      expect(calls).toBe(3);
      expect((await runs.findRun('run-1'))!.prompt).toBe('other 3');
    } finally {
      await db.close();
    }
  });

  it('writes nothing and names the run when its row was deleted', async () => {
    const db = await repositoryDatabase();
    try {
      const runs = db.app.get(RunRepository);
      await runs.openWaiting('run-1', '/target');
      await expect(
        runs.change('run-1', (run) => {
          otherWriter(db, 'DELETE FROM runs');
          run.prompt = 'mine';
        }),
      ).rejects.toThrow('run-1: the run is gone; nothing was written');
      expect(await runs.findRun('run-1')).toBeNull();
      await expect(runs.change('run-1', () => undefined)).rejects.toThrow('run-1: the run is gone');
    } finally {
      await db.close();
    }
  });

  it('keeps both tips of two recordBaseTips for one run at once', async () => {
    const db = await repositoryDatabase();
    try {
      const runs = db.app.get(RunRepository);
      await runs.openWaiting('run-1', '/target');
      await Promise.all([runs.recordBaseTips('run-1', { web: 'aaa' }), runs.recordBaseTips('run-1', { api: 'bbb' })]);
      expect((await runs.findRun('run-1'))?.baseTips).toEqual({ web: 'aaa', api: 'bbb' });
    } finally {
      await db.close();
    }
  });

  it('releases a held copy without setting back a title or generation written since', async () => {
    const db = await repositoryDatabase();
    try {
      const runs = db.app.get(RunRepository);
      await runs.openWaiting('run-1', '/target');
      const copy = await runs.begin('run-1', 'research');
      await runs.recordTitle((await runs.findRun('run-1'))!, 'A title');
      await runs.bumpGeneration('run-1');
      const released = await runs.release(copy, { status: 'waiting' });
      const row = (await runs.findRun('run-1'))!;
      expect(row).toEqual(
        expect.objectContaining({ status: 'waiting', activeAttempt: null, title: 'A title', generation: 1 }),
      );
      expect(copy).toEqual(row);
      expect(released).toEqual(row);
    } finally {
      await db.close();
    }
  });

  it('stores the state of the open questions in the write that releases the run to waiting', async () => {
    const db = await repositoryDatabase();
    try {
      const runs = db.app.get(RunRepository);
      await runs.openWaiting('run-1', '/target');
      const held = await runs.begin('run-1', 'research');
      await db.app.get(DocumentRepository).putDocument(held, 'questions', '- Which store?\n');
      const released = await runs.release(held, { status: 'waiting' });
      expect(storedState((await runs.findRun('run-1'))!).reason?.code).toBe('NEEDS_ANSWERS');
      expect(released.state).toBe('waiting');
    } finally {
      await db.close();
    }
  });

  it('stores the state of the open questions in the write of a change to waiting', async () => {
    const db = await repositoryDatabase();
    try {
      const runs = db.app.get(RunRepository);
      await runs.openWaiting('run-1', '/target');
      const held = await runs.begin('run-1', 'research');
      await db.app.get(DocumentRepository).putDocument(held, 'questions', '- Which store?\n');
      const changed = await runs.change('run-1', (run) => {
        writeRunState(run, { status: 'waiting' });
      });
      expect(storedState(changed).reason?.code).toBe('NEEDS_ANSWERS');
    } finally {
      await db.close();
    }
  });

  it('removes the output files named by attempt with the run', async () => {
    const db = await repositoryDatabase();
    try {
      const runs = db.app.get(RunRepository);
      const run = await runs.openWaiting('run-1', '/target');
      const data = join(db.root, 'data');
      mkdirSync(data, { recursive: true });
      const own = join(data, 'run-1-code-review-quality-5f0c1a2e-output.txt');
      const other = join(data, 'run-10-code-review-quality-5f0c1a2e-output.txt');
      writeFileSync(own, 'out\n');
      writeFileSync(other, 'out\n');
      await runs.remove(run);
      expect(existsSync(own)).toBe(false);
      expect(existsSync(other)).toBe(true);
    } finally {
      await db.close();
    }
  });

  it('removes the log folder of the run with it, so a later run with the same key starts with none', async () => {
    const db = await repositoryDatabase();
    try {
      const runs = db.app.get(RunRepository);
      const run = await runs.openWaiting('run-1', '/target');
      const own = join(db.root, 'data', 'run-logs', 'run-1');
      const other = join(db.root, 'data', 'run-logs', 'run-10');
      mkdirSync(own, { recursive: true });
      mkdirSync(other, { recursive: true });
      writeFileSync(join(own, 'implement-a-command-0-log.txt'), 'out\n');
      writeFileSync(join(other, 'implement-a-command-0-log.txt'), 'out\n');
      await runs.remove(run);
      expect(existsSync(own)).toBe(false);
      expect(existsSync(other)).toBe(true);
    } finally {
      await db.close();
    }
  });

  it('lists the subtasks of a run in the task order of its subtasks document and finds one by task id', async () => {
    const db = await repositoryDatabase();
    try {
      const runs = db.app.get(RunRepository);
      const parent = await runs.openWaiting('p-1', '/target');
      await db.app
        .get(DocumentRepository)
        .putDocument(
          parent,
          'subtasks',
          JSON.stringify(['b', 'a'].map((id) => ({ id, title: id, description: '', files: [], proof: '' }))),
        );
      await runs.openSubtask('p-1-a', parent.id, 'a');
      await runs.openSubtask('p-1-b', parent.id, 'b');
      await runs.openWaiting('other', '/target');

      expect((await runs.children(parent)).map((run) => run.key)).toEqual(['p-1-b', 'p-1-a']);
      expect((await runs.findSubtask(parent, 'a'))?.key).toBe('p-1-a');
      expect(await runs.findSubtask(parent, 'c')).toBeNull();
      expect(await runs.children((await runs.findRun('other'))!)).toEqual([]);
    } finally {
      await db.close();
    }
  });

  it('refuses to split a subtask and allows a run without a parent', async () => {
    const db = await repositoryDatabase();
    try {
      const runs = db.app.get(RunRepository);
      const parent = await runs.openWaiting('p-1', '/target');
      const child = await runs.openSubtask('p-1-a', parent.id, 'a');

      expect(() => runs.assertSplittable(child)).toThrow('a subtask cannot be split');
      expect(() => runs.assertSplittable(parent)).not.toThrow();
    } finally {
      await db.close();
    }
  });
  it('reads the duration of the asked runs only, equal to the full read', async () => {
    const db = await repositoryDatabase();
    try {
      const runs = db.app.get(RunRepository);
      const visits = db.app.get(VisitRepository);
      const first = await runs.begin('run-1', 'code-review');
      await visits.finishVisit(first, repositoryVisit());
      const second = await runs.begin('run-2', 'code-review');
      await visits.finishVisit(second, repositoryVisit());

      const all = await runs.durationByRun();
      const asked = await runs.durationByRun([first.id]);

      expect([...asked.keys()]).toEqual([first.id]);
      expect(asked.get(first.id)).toBe(all.get(first.id));
      expect(all.has(second.id)).toBe(true);
    } finally {
      await db.close();
    }
  });
});
