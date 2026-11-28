import { storeRun } from '../../testing/store-run.spec-helpers';
import { mkdirSync, mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { nextSessionKey } from '../../core/pipeline-result';
import type { MergeMode, MilestoneStatus, RequirementStatus } from '../../contract/backlog';
import type { PipelineCheck } from '../../integrations/code-host/code-host';
import type { CodeHostRegistry } from '../../integrations/code-host/code-host.registry';
import { AppConfig } from '../../config/env';
import { HostUnavailable, SwarmloopError } from '../../core/swarmloop-error';
import { testEnv } from '../../config/env.spec-helpers';
import { BacklogChatRepository } from '../../history/backlog-chat.repository';
import { BacklogRepository, type BacklogTaskRecord } from '../../history/backlog.repository';
import { DocumentRepository } from '../../history/document.repository';
import { PlanChatStore } from '../../history/plan-chat.store';
import { repositoryDatabase } from '../../history/repository.spec-helpers';
import { RunRepository } from '../../history/run.repository';
import { VisitRepository } from '../../history/visit.repository';
import { writeRunState, type RunStateChange } from '../../history/run-state';
import type { MergeOutcome } from '../../contract/run-state';
import { LiveHub } from '../../live/live.hub';
import type { RemoteRepositories } from '../../steps/prepare/remote-repositories.service';
import { MergeLanding } from '../../steps/shared/merge-landing';
import type { MergedFilesRecord } from '../../steps/shared/merged-files-record';
import { RepositoryHost } from '../../steps/shared/repository-host';
import type { RepositoryOrigins } from '../../steps/shared/repository-origins';
import type { RunNames } from '../../steps/shared/run-names';
import { FakeBacklogHost, pipelineOf } from '../../testing/fake-backlog-host';
import type { CommandService } from '../command.service';
import { BacklogActionSupport } from './backlog-action-support';
import { BacklogActions } from './backlog-actions';
import { holdServices } from '../../steps/shared/question-holds.spec-helpers';
import { BacklogEvents } from './backlog-events';
import { BacklogQueries } from './backlog-queries';
import { BacklogRequirementActions } from './backlog-requirement-actions';
import { BacklogScopeActions } from './backlog-scope-actions';
import { BacklogTaskActions } from './backlog-task-actions';
import { TaskRunSkip } from './task-run-skip';
import { BacklogMerge } from './backlog-merge';
import { EpicMainMoves } from './epic-main-moves';
import { MainRebaseSend } from './main-rebase-send';
import { MainWaitWake } from './main-wait-wake';
import { RedMainWait } from './red-main-wait';
import type { MainHeld } from './main-held';
import type { RunRebase } from '../../steps/run-rebase';
import { takesMain } from '../../steps/shared/epic-between-passes';
import type { RunEntity } from '../../history/entities';
import { OneActiveMilestone } from './one-active-milestone';
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

/** `no-ci` is a branch with no pipeline at all; `no-pipeline` is a new head with no pipeline yet on a branch that has CI. */
export type MainStyle = 'green' | 'red' | 'pending' | 'no-pipeline' | 'no-ci';

/** The remote repositories the actions harness can clone, by owner and name. */
const REMOTE_REPOSITORIES = ['acme/demo'];

/**
 * A remote whose clone makes the checkout of a known `owner/name` and answers its folder, and refuses any other.
 * The pick `acme/down` meets a code host outage.
 */
function remoteOf(checkouts: string | null, known: string[]): RemoteRepositories {
  return {
    clone: async (value: string) => {
      if (value === 'acme/down') throw new HostUnavailable('code.example', 'HTTP 503', '2026-11-28T12:00:00.000Z');
      if (checkouts === null || !known.includes(value)) {
        throw new SwarmloopError(`${value} is not a repository of the connected code hosts`);
      }
      const name = value.slice(value.lastIndexOf('/') + 1);
      mkdirSync(join(checkouts, name, '.git'), { recursive: true });
      return name;
    },
  } as unknown as RemoteRepositories;
}

/** The action service over a database, with a command door that only records the stops it is asked for. */
function actionParts(
  db: Awaited<ReturnType<typeof repositoryDatabase>>,
  config: AppConfig,
  remote: RemoteRepositories,
) {
  const backlogs = db.app.get(BacklogRepository);
  const queries = new BacklogQueries(backlogs, db.app.get(RunRepository));
  const hub = new LiveHub();
  const support = new BacklogActionSupport(backlogs, db.clock, hub);
  const stops: string[] = [];
  const commands = {
    submit: async (type: string, key: string) => {
      stops.push(`${type} ${key}`);
      return { value: undefined, receipt: {} };
    },
  } as unknown as CommandService;
  const taskRun = new TaskRunSkip(
    backlogs,
    db.app.get(RunRepository),
    db.app.get(DocumentRepository),
    db.app.get(PlanChatStore),
    commands,
  );
  const taskActions = new BacklogTaskActions(backlogs, queries, taskRun, db.clock, support);
  const requirementActions = new BacklogRequirementActions(queries, support);
  return {
    hub,
    queries,
    stops,
    taskRun,
    actions: new BacklogActions(
      backlogs,
      queries,
      db.clock,
      support,
      new BacklogScopeActions(backlogs, queries, db.clock, config, support, remote),
      taskActions,
      requirementActions,
    ),
  };
}

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
  const host = new RepositoryHost(repositoryOrigins, registry, { taskTitle: async () => null } as unknown as RunNames);
  const documents = db.app.get(DocumentRepository);
  const accepts: { type: string; key: string; idempotencyKey?: string }[] = [];
  /** The payload each accepted command carried, by its idempotency key. */
  const payloads = new Map<string, unknown>();
  const rebase = { refusal: null as string | null };
  /** The commands as stored: what each ended as is what the next ones are made with, until the spec changes it. */
  const stored: { id: string; runId: number; idempotencyKey: string; state: string; result: string | null }[] = [];
  const ending = { state: 'succeeded', result: null as string | null };
  const commands = {
    accept: async (type: string, key: string, payload: unknown, options: { idempotencyKey?: string }) => {
      if (rebase.refusal !== null) throw new Error(rebase.refusal);
      const seen = stored.find((command) => command.idempotencyKey === options.idempotencyKey);
      if (seen) return { replayed: true, command: seen };
      accepts.push({ type, key, idempotencyKey: options.idempotencyKey });
      payloads.set(options.idempotencyKey as string, payload);
      const run = await runs.findRun(key);
      const command = {
        id: `command-${stored.length + 1}`,
        runId: run?.id ?? 0,
        idempotencyKey: options.idempotencyKey as string,
        ...ending,
      };
      stored.push(command);
      return { replayed: false, command };
    },
    latestByKeyPrefix: async (runId: number, prefix: string) =>
      [...stored].reverse().find((command) => command.runId === runId && command.idempotencyKey.startsWith(prefix)) ??
      null,
  } as unknown as CommandService;
  const events = new BacklogEvents(
    backlogs,
    runs,
    db.app.get(VisitRepository),
    documents,
    host,
    db.app.get(PlanChatStore),
    holdServices(db.app, db.clock).holds,
    config,
  );
  // No git in a unit spec: the record stores the merged_files document with one file.
  const record = {
    record: async (run: RunEntity, merged: Record<string, string>) => {
      if (Object.keys(merged).length > 0) await documents.putDocument(run, 'merged_files', 'src/a.ts');
    },
  } as unknown as MergedFilesRecord;
  const landing = new MergeLanding(host, record);
  const merge = new BacklogMerge(backlogs, runs, documents, repositoryOrigins, host, commands, events, landing);
  const epics = { idle: true, held: new Set<string>() };
  const rebases = new MainRebaseSend(commands, events, db.clock);
  const epicMoves = new EpicMainMoves(
    backlogs,
    runs,
    {
      subtasksIdle: async () => epics.idle,
      takesMain: (epic: RunEntity) => takesMain(documents, runs, epic),
    } as unknown as RunRebase,
    {
      holds: async (_key: string, repo: string, sha: string) => epics.held.has(`${repo}@${sha}`),
    } as unknown as MainHeld,
    host,
    rebases,
  );
  const mainWake = new MainWaitWake(backlogs, runs, host, new RedMainWait(backlogs, runs, host), rebases);
  const starts: BacklogStart[] = [];
  const mode = { current: 'ok' as StartMode };
  const port = new BacklogStartPort();
  port.register(async (start) => {
    starts.push(start);
    if (mode.current === 'lost') throw new Error('start request failed');
    const key = nextSessionKey(
      start.key,
      (await runs.listRuns()).map((run) => run.key),
    );
    await storeRun(runs, runs.newWaitingRun(key, null, start.owner));
    if (mode.current === 'timeout') throw new Error('start request timed out');
    return key;
  });
  let position = 0;
  const { actions, stops, taskRun } = actionParts(db, config, remoteOf(null, []));

  const make = () =>
    new BacklogScheduler(
      backlogs,
      runs,
      host,
      merge,
      events,
      port,
      config,
      db.clock,
      db.app.get(BacklogChatRepository),
      epicMoves,
      taskRun,
      mainWake,
      new OneActiveMilestone(backlogs),
    );
  let current = make();

  const harness = {
    db,
    backlogs,
    runs,
    fake,
    /** The repository host over the fake code host, for the facts of events. */
    host,
    starts,
    /** The action service over the same database. */
    actions,
    /** The stop commands the actions asked for, as `stop <run key>`. */
    stops,
    /** The commands the merge asked for, in order. */
    accepts,
    payloads,
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
        'no-ci': null,
        'no-pipeline': pipelineOf('success', [check('success')]),
      };
      fake.setPipeline(project, snapshots[style]);
      // The branch has CI, but its new head has no pipeline yet.
      if (style === 'no-pipeline') fake.setHead(project, `${fake.headOf(project)}-next`);
    },
    /** What the epics' worktrees hold: whether their subtasks are idle, and the `<repo>@<head>` they already contain. */
    epics,
    /** What the commands sent from now on are stored as: `succeeded`, or `failed` with the result a failure leaves. */
    endCommandsAs(state: 'succeeded' | 'failed', result: string | null = null) {
      ending.state = state;
      ending.result = result;
    },
    /** Every command the merge sends from now on is refused with this message. */
    refuseRebase(message: string | null) {
      rebase.refusal = message;
    },
    /** A run for a task: done with a merge request in each of `requests`, or done by what MergeWatch saw, with the `delivery` list when given. */
    async seedDoneRun(
      key: string,
      requests: { repo: string; iid: number; branch?: string }[],
      outcome?: MergeOutcome,
      delivery?: string,
    ) {
      const run = runs.newWaitingRun(key, null, 'ada');
      run.codeHost = fake.name;
      await storeRun(runs, run);
      const saved = (await runs.findRun(key)) as NonNullable<Awaited<ReturnType<RunRepository['findRun']>>>;
      writeRunState(saved, { status: 'done', merge: outcome });
      await storeRun(runs, saved);
      const refs = requests.map(
        ({ repo, branch }) => `project: acme/${repo}\nref: ${branch ?? `swarmloop/${repo}`}\nsha: s1\n`,
      );
      const lines = requests.map(
        ({ repo, iid }) =>
          `project: acme/${repo}\niid: ${iid}\nurl: https://backlog.example/acme/${repo}/${iid}\ndraft: false\n`,
      );
      if (lines.length > 0) await documents.putDocument(saved, 'merge_request', lines.join('\n'));
      if (refs.length > 0) await documents.putDocument(saved, 'pipeline_ref', refs.join('\n'));
      if (delivery) await documents.putDocument(saved, 'delivery', delivery);
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
      await storeRun(runs, run);
    },
    /** Marks the run an epic that splits into subtasks. */
    async markSplit(key: string) {
      const run = await runs.findRun(key);
      if (!run) throw new Error(`no run ${key}`);
      run.split = true;
      await storeRun(runs, run);
      await documents.putDocument(run, 'subtasks', JSON.stringify([{ id: 'a', title: 'a', status: 'waiting' }]));
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
  const { queries, actions, stops, hub } = actionParts(db, config, remoteOf(checkouts, REMOTE_REPOSITORIES));
  return {
    backlogs,
    /** The live hub the actions tell after a person's write. */
    hub,
    queries,
    actions,
    /** The stop commands the actions asked for, as `stop <run key>`. */
    stops,
    runs: db.app.get(RunRepository),
    documents: db.app.get(DocumentRepository),
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
