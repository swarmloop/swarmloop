import { BacklogChatRepository } from '../history/backlog-chat.repository';
import { BacklogRepository } from '../history/backlog.repository';
import { DocumentRepository } from '../history/document.repository';
import { RunRepository } from '../history/run.repository';
import { AppConfig } from '../config/env';
import { Clock } from '../core/clock';
import { CommandService } from '../pipeline/command.service';
import type { PlannerTurnActions } from '../pipeline/backlog/planner/planner-actions';
import { plannerTurnActions, turnResult } from '../pipeline/backlog/planner/planner-scenarios.spec-helpers';
import { RunStateRefresh } from '../steps/shared/run-state-refresh';
import { save } from '../testing/runs.spec-helpers';
import { withAnswerRoutes } from './answer-routes.spec-helpers';

type Parts = Parameters<Parameters<typeof withAnswerRoutes>[0]>[0];

/** The planner's apply path over the app's repositories, sending through the real run port. */
function turnActions({ app, port }: Parts): PlannerTurnActions {
  return plannerTurnActions({
    backlogs: app.get(BacklogRepository),
    chat: app.get(BacklogChatRepository),
    runs: app.get(RunRepository),
    clock: app.get(Clock),
    config: app.get(AppConfig),
    commands: app.get(CommandService),
    port,
  }).turns;
}

async function seedWaitingRun(app: Parts['app']) {
  const backlogs = app.get(BacklogRepository);
  const now = new Date().toISOString();
  const backlog = await backlogs.saveBacklog({
    name: 'alpha',
    owner: 'owner',
    repositories: ['web'],
    mergeMode: 'green',
    paused: false,
    createdAt: now,
  });
  const backlogId = backlog.id as number;
  await backlogs.saveMilestone({
    backlogId,
    number: 1,
    title: 'First',
    goal: 'Goal',
    status: 'active',
    createdAt: now,
  });
  await backlogs.addDecision({ backlogId, text: 'State is kept in memory', who: 'owner', createdAt: now });
  await backlogs.saveTask({
    backlogId,
    milestoneId: null,
    slug: 'going',
    title: 'going',
    description: 'Do going',
    repositories: ['web'],
    covers: [],
    depends: [],
    files: [],
    proof: [],
    manual: false,
    fixesMain: null,
    status: 'running',
    runKey: 'going-1',
    note: '',
    runNow: false,
    mergeOk: false,
    merged: {},
    madeBy: 'person',
    position: 1,
    createdAt: now,
  });
  const run = await save(app.get(RunRepository), 'going-1', 'research', 'waiting');
  await app.get(DocumentRepository).putDocument(run, 'questions', '- which store\n');
  app.get(RunRepository).notify('going-1');
  await app.get(RunStateRefresh).settled();
  return backlogId;
}

describe('a planner turn over a run that waits on a question', () => {
  it('answers what a saved decision answers: the decision, its info line, and the run goes on', async () => {
    await withAnswerRoutes(async (parts) => {
      const { app, started } = parts;
      const backlogId = await seedWaitingRun(app);
      await turnActions(parts).apply(
        'alpha',
        'turn-1',
        turnResult('', {
          action: 'answerRun',
          run: 'going-1',
          answers: [{ body: 'in memory' }],
          reason: 'a saved decision keeps state in memory',
        }),
      );
      const { messages } = await app.get(BacklogChatRepository).lastMessages(backlogId, 10);
      expect(messages.map((message) => [message.kind, message.text])).toEqual([
        ['info', 'a saved decision keeps state in memory'],
      ]);
      expect((await app.get(BacklogRepository).decisions(backlogId)).map((decision) => decision.text)).toEqual([
        'State is kept in memory',
        'a saved decision keeps state in memory',
      ]);
      expect(await app.get(DocumentRepository).latestBody('going-1', 'answers')).toContain(
        'question: which store\nanswer: in memory',
      );
      expect(started).toHaveBeenCalledWith('going-1');
    });
  });

  it('puts a question no decision covers to the person and sends nothing', async () => {
    await withAnswerRoutes(async (parts) => {
      const { app, started } = parts;
      const backlogId = await seedWaitingRun(app);
      await turnActions(parts).apply('alpha', 'turn-1', turnResult('Which store do you want?'));
      const { messages } = await app.get(BacklogChatRepository).lastMessages(backlogId, 10);
      expect(messages.map((message) => message.text)).toEqual(['Which store do you want?']);
      expect(await app.get(DocumentRepository).latestBody('going-1', 'answers')).toBeNull();
      expect(started).not.toHaveBeenCalled();
      expect((await app.get(RunRepository).findRun('going-1'))?.status).toBe('waiting');
    });
  });
});
