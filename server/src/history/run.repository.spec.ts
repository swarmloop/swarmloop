import { existsSync, mkdirSync, writeFileSync } from 'fs';
import { join } from 'path';
import { DocumentRepository } from './document.repository';
import { root, runDir } from './run-paths';
import { repositoryDatabase, repositoryVisit } from './repository.spec-helpers';
import { RunRepository } from './run.repository';
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
      await runs.saveRun(run);
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
