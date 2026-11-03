import { join } from 'path';
import { DocumentRepository } from './document.repository';
import { HistoryService } from './history.service';
import { repositoryDatabase } from './repository.spec-helpers';
import { RunRepository } from './run.repository';

describe('RunRepository', () => {
  it('creates, reads, updates and removes a run through the facade', async () => {
    const db = await repositoryDatabase();
    try {
      const runs = db.app.get(RunRepository);
      const history = db.app.get(HistoryService);
      const run = await runs.openWaiting('run-1', '/target');
      expect(await history.findRun(run.key)).toEqual(run);
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
      expect(history.root()).toBe(db.root);
      expect(history.runDir(run.key)).toBe(join(db.root, 'runs', run.key));
      expect(await runs.durationByRun()).toEqual(new Map());
      await runs.remove(started);
      expect(await history.findRun(run.key)).toBeNull();
    } finally {
      await db.close();
    }
  });
});
