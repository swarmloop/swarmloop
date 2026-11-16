import { mkdirSync, mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import type { MergeMode, MilestoneStatus, RequirementStatus } from '../../contract/backlog';
import type { PipelineCheck } from '../../integrations/code-host/code-host';
import type { CodeHostRegistry } from '../../integrations/code-host/code-host.registry';
import { AppConfig } from '../../config/env';
import { testEnv } from '../../config/env.spec-helpers';
import { BacklogRepository, type BacklogTaskRecord } from '../../history/backlog.repository';
import { DocumentRepository } from '../../history/document.repository';
import { repositoryDatabase } from '../../history/repository.spec-helpers';
import { RunRepository } from '../../history/run.repository';
import { VisitRepository } from '../../history/visit.repository';
import { writeRunState, type RunStateChange } from '../../history/run-state';
import type { MergeOutcome } from '../../contract/run-state';
import { RepositoryHost } from '../../steps/shared/repository-host';
import type { RepositoryOrigins } from '../../steps/shared/repository-origins';
import { FakeBacklogHost, pipelineOf } from '../../testing/fake-backlog-host';
import type { CommandService } from '../command.service';
import { BacklogActions } from './backlog-actions';
import { BacklogEvents } from './backlog-events';
import { BacklogQueries } from './backlog-queries';
import { BacklogMerge } from './backlog-merge';
import { BacklogScheduler } from './backlog-scheduler';
import { BacklogStartPort, type BacklogStart } from './backlog-start-port';

const NOW = '2026-11-12T10:00:00Z';

function check(status: PipelineCheck['status']): PipelineCheck {
  return {
    id: 1,
    name: 'test',
    app: '',
    status,
    durationMs: 1000,
    url: '',
    summary: '',
    annotations: [],
    workflow: true,
  };
}

/** How the recording start port answers: the run is made, made and then the request times out, or never made. */
export type StartMode = 'ok' | 'timeout' | 'lost';

export type MainStyle = 'green' | 'red' | 'pending' | 'no-pipeline';

/** A real database with the backlog tables, the fake backlog host and a recording start port; tick() drives the scheduler under the db's fake clock. */
export async function backlogHarness(parallel = 3) {
  const db = await repositoryDatabase();
  const config = new AppConfig(testEnv({ SWARMLOOP_ROOT: db.root, BACKLOG_PARALLEL: parallel }));
  const backlogs = db.app.get(BacklogRepository);
  const runs = db.app.get(RunRepository);
  const fake = new FakeBacklogHost();
  const origins = new Map<string, { origin: string; project: string }>();
  const registry = {
    forRun: async () => registry,
    hostFor: async () => fake,
    forOrigin: (origin: string) => (fake.matchesOrigin(origin) ? fake.name : null),
    byName: () => fake,
  } as unknown as CodeHostRegistry;
  const repositoryOrigins = { of: async (repo: string) => origins.get(repo) } as unknown as RepositoryOrigins;
  const host = new RepositoryHost(repositoryOrigins, registry);
  const documents = db.app.get(DocumentRepository);
  const accepts: { type: string; key: string; idempotencyKey?: string }[] = [];
  const rebase = { refusal: null as string | null };
  const commands = {
    accept: async (type: string, key: string, _payload: unknown, options: { idempotencyKey?: string }) => {
      if (rebase.refusal !== null) throw new Error(rebase.refusal);
      const replayed = accepts.some((seen) => seen.idempotencyKey === options.idempotencyKey);
      if (!replayed) accepts.push({ type, key, idempotencyKey: options.idempotencyKey });
      return { replayed };
    },
  } as unknown as CommandService;
  const events = new BacklogEvents(backlogs, runs, db.app.get(VisitRepository), documents, host);
  const merge = new BacklogMerge(backlogs, runs, documents, repositoryOrigins, host, commands, events);
  const starts: BacklogStart[] = [];
  const mode = { current: 'ok' as StartMode };
  const port = new BacklogStartPort();
  port.register(async (start) => {
    starts.push(start);
    if (mode.current === 'lost') throw new Error('start request failed');
    await runs.saveRun(runs.newWaitingRun(start.key, null, start.owner));
    if (mode.current === 'timeout') throw new Error('start request timed out');
  });
  let position = 0;

  const make = () => new BacklogScheduler(backlogs, runs, host, merge, events, port, config, db.clock);
  let current = make();

  const harness = {
    db,
    backlogs,
    runs,
    fake,
    starts,
    /** The commands the merge asked for, in order. */
    accepts,
    /** The scheduler that tick() drives. */
    scheduler: () => current,
    /** A new scheduler over the same database, like a server that restarted. */
    restart() {
      current = make();
    },
    startMode(next: StartMode) {
      mode.current = next;
    },
    /** A repository on the fake host, with the state of its main. */
    setMain(repo: string, style: MainStyle = 'green') {
      const project = `acme/${repo}`;
      if (!origins.has(repo)) {
        origins.set(repo, { origin: FakeBacklogHost.originOf(project), project });
        fake.addProject(project);
      }
      const snapshots = {
        green: pipelineOf('success', [check('success')]),
        red: pipelineOf('failed', [check('failed')]),
        pending: pipelineOf('running', [check('running')]),
        'no-pipeline': null,
      };
      fake.setPipeline(project, snapshots[style]);
    },
    /** Every command the merge sends from now on is refused with this message. */
    refuseRebase(message: string | null) {
      rebase.refusal = message;
    },
    /** A run for a task: done with a merge request in each of `requests`, or done by what MergeWatch saw. */
    async seedDoneRun(key: string, requests: { repo: string; iid: number; branch?: string }[], outcome?: MergeOutcome) {
      const run = runs.newWaitingRun(key, null, 'ada');
      run.codeHost = fake.name;
      await runs.saveRun(run);
      const saved = (await runs.findRun(key)) as NonNullable<Awaited<ReturnType<RunRepository['findRun']>>>;
      writeRunState(saved, { status: 'done', merge: outcome });
      await runs.saveRun(saved);
      const refs = requests.map(
        ({ repo, branch }) => `project: acme/${repo}\nref: ${branch ?? `swarmloop/${repo}`}\nsha: s1\n`,
      );
      const lines = requests.map(
        ({ repo, iid }) =>
          `project: acme/${repo}\niid: ${iid}\nurl: https://backlog.example/acme/${repo}/${iid}\ndraft: false\n`,
      );
      if (lines.length > 0) await documents.putDocument(saved, 'merge_request', lines.join('\n'));
      if (refs.length > 0) await documents.putDocument(saved, 'pipeline_ref', refs.join('\n'));
      return saved;
    },
    seedBacklog(
      name: string,
      options: { owner?: string; repositories?: string[]; paused?: boolean; mergeMode?: MergeMode } = {},
    ): ReturnType<BacklogRepository['saveBacklog']> {
      return backlogs.saveBacklog({
        name,
        owner: options.owner ?? 'ada',
        repositories: options.repositories ?? ['web'],
        mergeMode: options.mergeMode ?? 'green',
        paused: options.paused ?? false,
        createdAt: NOW,
      });
    },
    seedMilestone(
      backlogId: number,
      number: number,
      status: MilestoneStatus = 'active',
    ): ReturnType<BacklogRepository['saveMilestone']> {
      return backlogs.saveMilestone({ backlogId, number, title: `M${number}`, goal: '', status, createdAt: NOW });
    },
    seedRequirement(
      milestoneId: number,
      ref: string,
      status: RequirementStatus = 'open',
    ): ReturnType<BacklogRepository['saveRequirement']> {
      return backlogs.saveRequirement({ milestoneId, ref, text: ref, status });
    },
    seedTask(backlogId: number, slug: string, overrides: Partial<BacklogTaskRecord> = {}) {
      position += 1;
      return backlogs.saveTask({
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
        position,
        createdAt: NOW,
        ...overrides,
      });
    },
    /** Moves the run of a started task to a state, the way a step would. */
    async moveRun(key: string, change: RunStateChange) {
      const run = await runs.findRun(key);
      if (!run) throw new Error(`no run ${key}`);
      writeRunState(run, change);
      await runs.saveRun(run);
    },
    /** The task as stored now. */
    async task(backlogId: number, slug: string) {
      return (await backlogs.tasks(backlogId)).find((record) => record.slug === slug) as BacklogTaskRecord;
    },
    /** The slugs of the tasks started so far, in order. */
    started: () => starts.map((start) => start.key.replace(/-[0-9a-z]+$/, '')),
    tick: () => current.tick(),
  };
  return harness;
}

/** The action service and the queries over a real database whose checkouts root holds the given projects. */
export async function actionsHarness(projects: string[] = ['web', 'server']) {
  const db = await repositoryDatabase();
  const checkouts = mkdtempSync(join(tmpdir(), 'swarmloop-checkouts-'));
  for (const project of projects) mkdirSync(join(checkouts, project, '.git'), { recursive: true });
  const config = new AppConfig(testEnv({ SWARMLOOP_ROOT: db.root, CHECKOUTS_ROOT: checkouts }));
  const backlogs = db.app.get(BacklogRepository);
  const queries = new BacklogQueries(backlogs);
  return {
    backlogs,
    queries,
    actions: new BacklogActions(backlogs, queries, db.clock, config),
    /** The recorded actions of a backlog, oldest first. */
    async actionEvents(name: string): Promise<{ facts: Record<string, string>; createdAt: string }[]> {
      const backlog = (await backlogs.findBacklog(name)) as NonNullable<
        Awaited<ReturnType<typeof backlogs.findBacklog>>
      >;
      return (await backlogs.events(backlog.id as number, 100)).filter((event) => event.kind === 'action').reverse();
    },
    async close() {
      rmSync(checkouts, { recursive: true, force: true });
      await db.close();
    },
  };
}
