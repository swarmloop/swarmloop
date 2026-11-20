import type { BacklogTaskRecord } from '../../../history/backlog.repository';
import { DocumentRepository } from '../../../history/document.repository';
import { PlanChatStore } from '../../../history/plan-chat.store';
import { RunRepository } from '../../../history/run.repository';
import type { CodeHostRegistry } from '../../../integrations/code-host/code-host.registry';
import { RepositoryHost } from '../../../steps/shared/repository-host';
import type { RunNames } from '../../../steps/shared/run-names';
import type { RepositoryOrigins } from '../../../steps/shared/repository-origins';
import { FakeBacklogHost, pipelineOf } from '../../../testing/fake-backlog-host';
import { plannerDatabase } from './planner.spec-helpers';

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
    chats: db.app.get(PlanChatStore),
    /** A run that holds the documents `kinds` names, each with its body. */
    async addRun(key: string, kinds: Record<string, string> = {}): Promise<void> {
      await runs.saveRun(runs.newWaitingRun(key, null, 'owner'));
      const run = (await runs.findRun(key)) as NonNullable<Awaited<ReturnType<RunRepository['findRun']>>>;
      for (const [kind, body] of Object.entries(kinds)) await documents.putDocument(run, kind, body);
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
        files: [],
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
