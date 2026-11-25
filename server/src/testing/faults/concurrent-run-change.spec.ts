import { spawnSync } from 'child_process';
import { join } from 'path';
import { repositoryDatabase } from '../../history/repository.spec-helpers';
import { RunRepository } from '../../history/run.repository';

const SERVER_FOLDER = join(__dirname, '..', '..', '..');

describe('two writers that change the same column of one run', () => {
  it('both apply, one after the other, and nothing is lost', async () => {
    const db = await repositoryDatabase();
    try {
      const runs = db.app.get(RunRepository);
      await runs.openWaiting('run-1', '/target');
      let applied = 0;
      const append = (text: string) => async () => {
        await runs.change('run-1', (run) => {
          applied += 1;
          run.prompt = `${run.prompt ?? ''}${text}`;
        });
      };
      await Promise.all([append('a')(), append('b')()]);
      expect((await runs.findRun('run-1'))!.prompt).toBe('ab');
      expect(applied).toBe(2);
    } finally {
      await db.close();
    }
  });

  it('applies again on the row as it is now when the second writer is another process', async () => {
    const db = await repositoryDatabase();
    try {
      const runs = db.app.get(RunRepository);
      await runs.openWaiting('run-1', '/target');
      const script = `
        const Database = require('better-sqlite3');
        const db = new Database(process.argv[1]);
        db.prepare("UPDATE runs SET prompt = 'other'").run();
        db.close();
      `;
      let applied = 0;
      await runs.change('run-1', (run) => {
        applied += 1;
        if (applied === 1) {
          const child = spawnSync(process.execPath, ['-e', script, join(db.root, 'data', 'swarmloop.sqlite')], {
            cwd: SERVER_FOLDER,
          });
          expect(child.status).toBe(0);
        }
        run.prompt = `${run.prompt ?? ''}+mine`;
      });
      expect(applied).toBe(2);
      expect((await runs.findRun('run-1'))!.prompt).toBe('other+mine');
    } finally {
      await db.close();
    }
  });
});
