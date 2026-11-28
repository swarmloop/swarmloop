import { storeRun } from '../../../testing/store-run.spec-helpers';
import { AppConfig } from '../../../config/env';
import { AttachmentStore } from '../../../history/attachment-store';
import { BacklogRepository, type BacklogTaskRecord } from '../../../history/backlog.repository';
import { CheckCommandRepository } from '../../../history/check-command.repository';
import { DocumentRepository } from '../../../history/document.repository';
import { PlanChatStore } from '../../../history/plan-chat.store';
import { RunRepository } from '../../../history/run.repository';
import type { StepEvent } from '../../../contract/step-events';
import { writeRunState } from '../../../history/run-state';
import { StepEventLog } from '../../../history/step-event.log';
import { VisitRepository } from '../../../history/visit.repository';
import type { CodeHostRegistry } from '../../../integrations/code-host/code-host.registry';
import { RepositoryHost } from '../../../steps/shared/repository-host';
import type { RunNames } from '../../../steps/shared/run-names';
import type { RepositoryOrigins } from '../../../steps/shared/repository-origins';
import { FakeBacklogHost, pipelineOf } from '../../../testing/fake-backlog-host';
import { EventFacts } from './event-facts';
import { plannerDatabase } from './planner.spec-helpers';
import { RunFacts } from './run-facts';
import { RunReasons } from './run-reason';

/** The facts of a turn's events, read from the real repositories of `app` and the code host `host`. */
export function eventFactsOf(app: { get<T>(token: new (...args: never[]) => T): T }, host: RepositoryHost): EventFacts {
  const runFacts = new RunFacts(
    app.get(RunRepository),
    app.get(DocumentRepository),
    app.get(CheckCommandRepository),
    app.get(VisitRepository),
    app.get(AppConfig),
  );
  return new EventFacts(
    app.get(BacklogRepository),
    app.get(DocumentRepository),
    host,
    runFacts,
    app.get(AttachmentStore),
  );
}

/** The planner database with runs that hold documents, a plan chat, and a fake code host that a repository's main can be set on. */
export async function plannerFacts() {
  const db = await plannerDatabase();
  const runs = db.app.get(RunRepository);
  const documents = db.app.get(DocumentRepository);
  const fake = new FakeBacklogHost();
  const origins = new Map<string, { origin: string; project: string }>();
  const registry = {
    forRun: async () => registry,
    forOrigin: (origin: string) => (fake.matchesOrigin(origin) ? fake.name : null),
    byName: () => fake,
  } as unknown as CodeHostRegistry;
  const host = new RepositoryHost(
    { of: async (repo: string) => origins.get(repo) } as unknown as RepositoryOrigins,
    registry,
    { taskTitle: async () => null } as unknown as RunNames,
  );
  return {
    ...db,
    runs,
    documents,
    fake,
    host,
    eventFacts: () => eventFactsOf(db.app, host),
    runReasons: () => new RunReasons(db.app.get(StepEventLog)),
    chats: db.app.get(PlanChatStore),
    /** A run that holds the documents `kinds` names, each with its body. */
    async addRun(key: string, kinds: Record<string, string> = {}): Promise<void> {
      await storeRun(runs, runs.newWaitingRun(key, null, 'owner'));
      const run = (await runs.findRun(key)) as NonNullable<Awaited<ReturnType<RunRepository['findRun']>>>;
      for (const [kind, body] of Object.entries(kinds)) await documents.putDocument(run, kind, body);
    },
    /** A run that ended at `step` in `status`, with the summary its attempt ended with and the stored reason, when given. */
    async endRun(
      key: string,
      status: 'failed' | 'blocked' | 'running',
      step: string,
      summary: string,
      reason?: { code: string; message: string },
    ): Promise<void> {
      const run = (await runs.findRun(key)) as NonNullable<Awaited<ReturnType<RunRepository['findRun']>>>;
      writeRunState(run, { status, currentStep: step, ...(reason ? { reason } : {}) });
      await storeRun(runs, run);
      await db.app.get(StepEventLog).append([
        {
          payloadVersion: 1,
          eventId: `end-${key}`,
          runId: run.id,
          attemptId: 'attempt-1',
          step,
          seq: 1,
          occurredAt: db.clock.iso(),
          parentSpanId: null,
          kind: 'attempt.finished',
          route: status === 'failed' ? 'failed' : 'blocked',
          summary,
        } as StepEvent,
      ]);
    },
    addTask(backlogId: number, slug: string, overrides: Partial<BacklogTaskRecord> = {}) {
      return db.backlogs.saveTask({
        backlogId,
        milestoneId: null,
        slug,
        title: slug,
        description: `Do ${slug}`,
        repositories: ['web'],
        covers: [],
        depends: [],
        files: [`${slug}.ts`],
        proof: [],
        manual: false,
        fixesMain: null,
        status: 'waiting',
        runKey: null,
        note: '',
        runNow: false,
        mergeOk: false,
        merged: {},
        madeBy: 'person',
        position: 0,
        createdAt: db.clock.iso(),
        ...overrides,
      });
    },
    /** A repository whose main is red: one failed job with this log. */
    redMain(repo: string, trace: string, url = 'https://backlog.example/acme/jobs/9'): void {
      const project = `acme/${repo}`;
      origins.set(repo, { origin: FakeBacklogHost.originOf(project), project });
      fake.addProject(project);
      const failed = {
        id: 9,
        name: 'unit tests',
        app: '',
        status: 'failed',
        durationMs: 1,
        url,
        summary: '',
        annotations: [],
        workflow: true,
      };
      fake.setPipeline(project, pipelineOf('failed', [failed as never]));
      fake.setTrace(trace);
    },
  };
}
