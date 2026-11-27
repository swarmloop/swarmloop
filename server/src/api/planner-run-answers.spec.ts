import { BacklogRepository } from '../history/backlog.repository';
import { DocumentRepository } from '../history/document.repository';
import type { RunEntity } from '../history/entities';
import { storedState } from '../history/run-state';
import { REASON } from '../contract/reason-words';
import { RunAnswersService } from './run-answers.service';
import { RunRepository } from '../history/run.repository';
import { eventFactsOf } from '../pipeline/backlog/planner/planner-facts.spec-helpers';
import type { RepositoryHost } from '../steps/shared/repository-host';
import { save } from '../testing/runs.spec-helpers';
import { withAnswerRoutes } from './answer-routes.spec-helpers';

type Parts = Parameters<Parameters<typeof withAnswerRoutes>[0]>[0];

/** The facts a turn gets for the run's run-needs-person event: the question, and no kind or id of it. */
async function needsPersonFacts(app: Parts['app'], runKey: string) {
  const backlogs = app.get(BacklogRepository);
  const backlog = await backlogs.saveBacklog({
    name: 'alpha',
    owner: 'owner',
    repositories: ['web'],
    mergeMode: 'green',
    paused: false,
    createdAt: '2026-01-01T00:00:00.000Z',
  });
  const id = backlog.id as number;
  await backlogs.recordEvent(id, `needs-person:${runKey}:1`, 'run-needs-person', { runKey });
  const [event] = await backlogs.events(id, 1);
  return eventFactsOf(app, {} as RepositoryHost).of('owner', event, 'turn-1');
}

/** The question implement's planner escalated to the person, as the run waits on it at implement. */
async function askAtImplement(app: Parts['app'], run: RunEntity): Promise<void> {
  const documents = app.get(DocumentRepository);
  const question = 'implement asks: which limit (asked t)';
  const parts = { decide: 'which limit', sides: [], full: '', askedAt: 't' };
  await documents.putDocument(run, 'questions', `- ${question}\n`);
  await documents.putDocument(run, 'question_parts', JSON.stringify([{ question, parts }]));
}

describe('the planner answering a run that waits on a question', () => {
  it('is taken for a research question, whose id the planner does not know', async () => {
    await withAnswerRoutes(async ({ app, port, started }) => {
      const run = await save(app.get(RunRepository), 'proj-1', 'research', 'waiting');
      await app.get(DocumentRepository).putDocument(run, 'questions', '- which limit\n');
      app.get(RunRepository).notify('proj-1');
      const facts = await needsPersonFacts(app, 'proj-1');
      expect(facts.question).toBe('- which limit');
      await port.send({ type: 'answer', run: 'proj-1', answers: [{ body: 'three' }] }, 'ada', 'turn-1-action-0');
      expect(await app.get(DocumentRepository).latestBody('proj-1', 'answers')).toContain(
        'question: which limit\nanswer: three',
      );
      expect(started).toHaveBeenCalledWith('proj-1');
    });
  });

  it('is taken for a review disagreement', async () => {
    await withAnswerRoutes(async ({ app, port, started }) => {
      const run = await save(app.get(RunRepository), 'proj-2', 'code-review', 'waiting');
      await app.get(DocumentRepository).putDocument(run, 'review_questions', '- keep the cache?\n');
      app.get(RunRepository).notify('proj-2');
      await port.send({ type: 'answer', run: 'proj-2', answers: [{ body: 'keep it' }] }, 'ada', 'turn-1-action-0');
      expect(await app.get(DocumentRepository).latestBody('proj-2', 'answers')).toContain(
        'question: keep the cache?\nanswer: keep it',
      );
      expect(started).toHaveBeenCalledWith('proj-2');
    });
  });

  describe('while the run red is the red main of its repository', () => {
    /** A backlog whose task holds the run, and a fix task for web's main that has not merged. */
    async function withFixTask(app: Parts['app'], runKey: string) {
      const backlogs = app.get(BacklogRepository);
      const backlog = await backlogs.saveBacklog({
        name: 'alpha',
        owner: 'owner',
        repositories: ['web'],
        mergeMode: 'green',
        paused: false,
        createdAt: '2026-01-01T00:00:00.000Z',
      });
      const task = {
        backlogId: backlog.id as number,
        milestoneId: null,
        description: '',
        repositories: ['web'],
        covers: [],
        depends: [],
        files: [],
        proof: [],
        manual: false,
        status: 'waiting' as const,
        note: '',
        runNow: false,
        mergeOk: false,
        merged: {},
        madeBy: 'person' as const,
        createdAt: '2026-01-01T00:00:00.000Z',
      };
      await backlogs.saveTask({ ...task, slug: 'a', title: 'a', fixesMain: null, runKey, position: 1 });
      await backlogs.saveTask({ ...task, slug: 'fix', title: 'fix', fixesMain: 'web', runKey: null, position: 2 });
    }

    it('saves the planner answer and holds the run for a green main without starting it', async () => {
      await withAnswerRoutes(async ({ app, port, started }) => {
        const run = await save(app.get(RunRepository), 'proj-3', 'implement', 'waiting');
        await askAtImplement(app, run);
        await withFixTask(app, 'proj-3');
        await port.send({ type: 'answer', run: 'proj-3', answers: [{ body: 'three' }] }, 'owner', 'turn-1-action-0');
        expect(await app.get(DocumentRepository).latestBody('proj-3', 'answers')).toContain('answer: three');
        expect(started).not.toHaveBeenCalled();
        expect(storedState((await app.get(RunRepository).findRun('proj-3')) as RunEntity)).toMatchObject({
          state: 'waiting',
          reason: { code: REASON.waitsForMain },
        });
      });
    });

    it('starts the run when the main reads green', async () => {
      await withAnswerRoutes(async ({ app, port, started, main }) => {
        const run = await save(app.get(RunRepository), 'proj-4', 'implement', 'waiting');
        await askAtImplement(app, run);
        await withFixTask(app, 'proj-4');
        main.state = 'green';
        await port.send({ type: 'answer', run: 'proj-4', answers: [{ body: 'three' }] }, 'owner', 'turn-1-action-0');
        expect(started).toHaveBeenCalledWith('proj-4');
      });
    });

    it('starts a run before implement as today, under the same red main', async () => {
      await withAnswerRoutes(async ({ app, port, started }) => {
        const run = await save(app.get(RunRepository), 'proj-6', 'research', 'waiting');
        await app.get(DocumentRepository).putDocument(run, 'questions', '- which limit\n');
        await withFixTask(app, 'proj-6');
        await port.send({ type: 'answer', run: 'proj-6', answers: [{ body: 'three' }] }, 'owner', 'turn-1-action-0');
        expect(started).toHaveBeenCalledWith('proj-6');
      });
    });

    it('starts the run for an answer of a person from the run page', async () => {
      await withAnswerRoutes(async ({ app, started }) => {
        const run = await save(app.get(RunRepository), 'proj-5', 'implement', 'waiting');
        await askAtImplement(app, run);
        await withFixTask(app, 'proj-5');
        await app.get(RunAnswersService).fromMessage('proj-5', 'three');
        expect(started).toHaveBeenCalledWith('proj-5');
      });
    });
  });
});
