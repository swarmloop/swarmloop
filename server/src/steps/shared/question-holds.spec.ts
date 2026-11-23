import { DocumentRepository } from '../../history/document.repository';
import { RunRepository } from '../../history/run.repository';
import { repositoryDatabase } from '../../history/repository.spec-helpers';
import { ARTIFACTS } from '../contract/artifacts';
import { holdServices, seedBacklogTask } from './question-holds.spec-helpers';

const QUESTION = 'Which store?';

async function setup() {
  const db = await repositoryDatabase();
  const runs = db.app.get(RunRepository);
  const documents = db.app.get(DocumentRepository);
  const { holds } = holdServices(db.app, db.clock);
  /** A waiting run at research with one open question. */
  const asking = async (key: string, parent?: { id: number }) => {
    const run = parent ? await runs.openSubtask(key, parent.id, 'task-1') : await runs.openWaiting(key, '/target');
    run.currentStep = 'research';
    await runs.saveRun(run);
    await documents.putDocument(run, 'questions', `- ${QUESTION}\n`);
    return (await runs.findRun(key)) ?? run;
  };
  return { db, runs, documents, holds, asking };
}

describe('QuestionHolds', () => {
  it('keeps the question of a backlog task run with the planner', async () => {
    const { db, holds, asking } = await setup();
    try {
      await seedBacklogTask(db.app, 'going-1');
      const run = await asking('going-1');
      expect(await holds.facts(run)).toMatchObject({ needsAnswers: false, asksPlanner: true });
      expect((await holds.held(run)).map((item) => item.id)).toEqual([QUESTION]);
    } finally {
      await db.close();
    }
  });

  it('keeps the question of a run below a backlog task run with the planner', async () => {
    const { db, holds, asking } = await setup();
    try {
      await seedBacklogTask(db.app, 'epic-1');
      const epic = await asking('epic-1');
      const subtask = await asking('sub-1', epic);
      expect(await holds.ofBacklog(subtask)).toBe(true);
      expect(await holds.facts(subtask)).toMatchObject({ needsAnswers: false, asksPlanner: true });
    } finally {
      await db.close();
    }
  });

  it('gives the question to the person with the planner line once the planner passed it on', async () => {
    const { db, holds, documents, asking } = await setup();
    try {
      await seedBacklogTask(db.app, 'going-1');
      const run = await asking('going-1');
      await documents.putDocument(
        run,
        ARTIFACTS.passedOn.kind,
        ARTIFACTS.passedOn.format([{ question: QUESTION, line: 'Only you can choose.', at: 'now' }]),
      );
      expect(await holds.facts(run)).toMatchObject({ needsAnswers: true, asksPlanner: false });
      const items = await holds.mark(
        run,
        [{ kind: 'question', id: QUESTION, label: QUESTION, answer: '' }],
        [...(await documents.listDocuments(run.id))],
      );
      expect(items).toEqual([
        { kind: 'question', id: QUESTION, label: QUESTION, answer: '', passedOn: 'Only you can choose.' },
      ]);
    } finally {
      await db.close();
    }
  });

  it('gives the question of a run outside a backlog to the person at once', async () => {
    const { db, holds, asking } = await setup();
    try {
      const run = await asking('alone-1');
      expect(await holds.ofBacklog(run)).toBe(false);
      expect(await holds.facts(run)).toMatchObject({ needsAnswers: true, asksPlanner: false });
      expect(await holds.held(run)).toEqual([]);
    } finally {
      await db.close();
    }
  });
});
