import { existsSync, mkdirSync, writeFileSync } from 'fs';
import { join } from 'path';
import { DocumentRepository } from './document.repository';
import { root, runDir } from './run-paths';
import { repositoryDatabase } from './repository.spec-helpers';
import { RunRepository } from './run.repository';

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
      db.config.env.RUNTIME = 'codex';
      const started = await runs.begin(run.key, 'research');
      expect(started.status).toBe('running');
      expect(started.runtime).toBe('codex');
      expect(runs.held(started)).toBe(true);
      expect(await db.app.get(DocumentRepository).latestBody(run.key, 'shell_resume')).toBe('clear\n');
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
});
