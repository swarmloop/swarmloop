import { storeRun } from '../testing/store-run.spec-helpers';
import { HttpException } from '@nestjs/common';
import { DocumentRepository } from '../history/document.repository';
import { repositoryDatabase } from '../history/repository.spec-helpers';
import { RunRepository } from '../history/run.repository';
import { REASON } from '../contract/run-state';
import { ARTIFACTS } from '../steps/contract/artifacts';
import { holdServices, seedBacklogTask } from '../steps/shared/question-holds.spec-helpers';
import { RunFactsRepository } from '../history/run-facts.repository';
import { factColumns, storedState } from '../history/run-state';

const QUESTION = 'Which store?';

/** A backlog run waiting at research on one question, stored the way the refresh stores it. */
async function setup() {
  const db = await repositoryDatabase();
  const runs = db.app.get(RunRepository);
  const documents = db.app.get(DocumentRepository);
  const services = holdServices(db.app, db.clock);
  await seedBacklogTask(db.app, 'going-1');
  const run = await runs.openWaiting('going-1', '/target');
  run.currentStep = 'research';
  await storeRun(runs, run);
  await documents.putDocument(run, 'questions', `- ${QUESTION}\n`);
  await db.app.get(RunFactsRepository).recordFacts(run, factColumns(run, await services.holds.facts(run)));
  const read = async () => {
    const row = await runs.findRun('going-1');
    return row && storedState(row);
  };
  return { db, documents, run, read, ...services };
}

describe('QuestionPassOn', () => {
  it('passes the question to the person with the planner line, so the run waits for them', async () => {
    const { db, run, documents, passOn, read } = await setup();
    try {
      expect((await read())?.reason?.code).toBe(REASON.asksPlanner);
      expect(await passOn.pass('going-1', QUESTION, 'Only you can choose.')).toEqual([QUESTION]);
      expect((await read())?.reason?.code).toBe('NEEDS_ANSWERS');
      const stored = ARTIFACTS.passedOn.parse((await documents.latestBody(run.key, 'passed_on')) ?? '[]');
      expect(stored).toEqual([{ question: QUESTION, line: 'Only you can choose.', at: db.clock.iso() }]);
    } finally {
      await db.close();
    }
  });

  it('writes a question that is passed on twice once', async () => {
    const { db, run, documents, passOn } = await setup();
    try {
      await passOn.pass('going-1', QUESTION, 'First line.');
      expect(await passOn.pass('going-1', QUESTION, 'Second line.')).toEqual([]);
      const stored = ARTIFACTS.passedOn.parse((await documents.latestBody(run.key, 'passed_on')) ?? '[]');
      expect(stored.map((entry) => entry.line)).toEqual(['First line.']);
    } finally {
      await db.close();
    }
  });

  it('refuses, as a run command does, when the planner holds no such question', async () => {
    const { db, passOn } = await setup();
    try {
      await passOn.passOrRefuse('going-1', QUESTION, 'Yours.');
      await expect(passOn.passOrRefuse('going-1', QUESTION, 'Yours.')).rejects.toBeInstanceOf(HttpException);
      await expect(passOn.passOrRefuse('going-1', 'Another?', 'Yours.')).rejects.toBeInstanceOf(HttpException);
    } finally {
      await db.close();
    }
  });
});
