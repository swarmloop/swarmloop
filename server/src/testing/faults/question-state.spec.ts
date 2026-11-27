import { DocumentRepository } from '../../history/document.repository';
import { RunRepository } from '../../history/run.repository';
import { storedState } from '../../history/run-state';
import { createTestApp, type TestApp } from '../test-app';
import { assertSettled, settle } from './settle.spec-helpers';

const KEY = 'run-asks';

describe('a question stored while another writer changes the run', () => {
  let app: TestApp;
  beforeEach(async () => {
    app = await createTestApp();
  });
  afterEach(async () => app.close());

  it('reads as waiting for a person right after the question is written, and after both writes', async () => {
    const runs = app.app.get(RunRepository);
    await runs.openWaiting(KEY, '/target');
    const run = await runs.change(KEY, (row) => {
      row.currentStep = 'research';
    });
    const code = async () => storedState((await runs.findRun(KEY))!).reason?.code ?? null;

    let afterQuestion: string | null = null;
    const asked = app.app
      .get(DocumentRepository)
      .putDocument(run, 'questions', '- Which store?\n')
      .then(async () => {
        afterQuestion = await code();
      });
    const changed = runs.change(KEY, (row) => {
      row.prompt = 'changed meanwhile';
    });
    await Promise.all([asked, changed]);

    expect(afterQuestion).toBe('NEEDS_ANSWERS');
    expect(await code()).toBe('NEEDS_ANSWERS');
    expect((await runs.findRun(KEY))!.prompt).toBe('changed meanwhile');
    await settle(app);
    await assertSettled(app);
  });
});
