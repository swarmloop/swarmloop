import { BacklogRepository } from '../history/backlog.repository';
import { DocumentRepository } from '../history/document.repository';
import { RunRepository } from '../history/run.repository';
import { EventFacts } from '../pipeline/backlog/planner/event-facts';
import type { RepositoryHost } from '../steps/shared/repository-host';
import { RunStateRefresh } from '../steps/shared/run-state-refresh';
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
  return new EventFacts(backlogs, app.get(DocumentRepository), {} as RepositoryHost).of('owner', event);
}

describe('the planner answering a run that waits on a question', () => {
  it('is taken for a research question, whose id the planner does not know', async () => {
    await withAnswerRoutes(async ({ app, port, started }) => {
      const run = await save(app.get(RunRepository), 'proj-1', 'research', 'waiting');
      await app.get(DocumentRepository).putDocument(run, 'questions', '- which limit\n');
      app.get(RunRepository).notify('proj-1');
      await app.get(RunStateRefresh).settled();
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
      await app.get(RunStateRefresh).settled();
      await port.send({ type: 'answer', run: 'proj-2', answers: [{ body: 'keep it' }] }, 'ada', 'turn-1-action-0');
      expect(await app.get(DocumentRepository).latestBody('proj-2', 'answers')).toContain(
        'question: keep the cache?\nanswer: keep it',
      );
      expect(started).toHaveBeenCalledWith('proj-2');
    });
  });
});
