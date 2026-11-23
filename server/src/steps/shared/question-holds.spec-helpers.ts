import type { Type } from '@nestjs/common';
import type { Clock } from '../../core/clock';
import { BacklogRepository } from '../../history/backlog.repository';
import { CheckoutRepository } from '../../history/checkout.repository';
import { DocumentRepository } from '../../history/document.repository';
import { RunRepository } from '../../history/run.repository';
import { QuestionPassOn } from '../../pipeline/question-pass-on';
import { QuestionHolds } from './question-holds';

/** The hold rule and the pass-on service over the repositories of a spec's database. */
export function holdServices(app: { get<T>(token: Type<T>): T }, clock: Clock) {
  const runs = app.get(RunRepository);
  const documents = app.get(DocumentRepository);
  const holds = new QuestionHolds(documents, app.get(CheckoutRepository), runs, app.get(BacklogRepository));
  return { holds, passOn: new QuestionPassOn(documents, runs, holds, clock) };
}

/** A backlog with one task whose run is `runKey`; returns the backlog's id. */
export async function seedBacklogTask(app: { get<T>(token: Type<T>): T }, runKey: string): Promise<number> {
  const backlogs = app.get(BacklogRepository);
  const createdAt = '2026-01-01T00:00:00.000Z';
  const backlog = await backlogs.saveBacklog({
    name: 'alpha',
    owner: 'owner',
    repositories: ['web'],
    mergeMode: 'green',
    paused: false,
    createdAt,
  });
  const backlogId = backlog.id as number;
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
    runKey,
    note: '',
    runNow: false,
    mergeOk: false,
    merged: {},
    madeBy: 'person',
    position: 1,
    createdAt,
  });
  return backlogId;
}
