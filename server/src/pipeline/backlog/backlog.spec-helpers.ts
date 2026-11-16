import type { MilestoneStatus } from '../../contract/backlog';
import type { PipelineCheck } from '../../integrations/code-host/code-host';
import type { CodeHostRegistry } from '../../integrations/code-host/code-host.registry';
import { AppConfig } from '../../config/env';
import { testEnv } from '../../config/env.spec-helpers';
import { BacklogRepository, type BacklogTaskRecord } from '../../history/backlog.repository';
import { repositoryDatabase } from '../../history/repository.spec-helpers';
import { RunRepository } from '../../history/run.repository';
import { writeRunState, type RunStateChange } from '../../history/run-state';
import { RepositoryHost } from '../../steps/shared/repository-host';
import type { RepositoryOrigins } from '../../steps/shared/repository-origins';
import { FakeBacklogHost, pipelineOf } from '../../testing/fake-backlog-host';
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
    forOrigin: (origin: string) => (fake.matchesOrigin(origin) ? fake.name : null),
    byName: () => fake,
  } as unknown as CodeHostRegistry;
  const host = new RepositoryHost(
    { of: async (repo: string) => origins.get(repo) } as unknown as RepositoryOrigins,
    registry,
  );
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

  const make = () => new BacklogScheduler(backlogs, runs, host, port, config, db.clock);
  let current = make();

  const harness = {
    db,
    backlogs,
    runs,
    fake,
    starts,
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
    seedBacklog(
      name: string,
      options: { owner?: string; repositories?: string[]; paused?: boolean } = {},
    ): ReturnType<BacklogRepository['saveBacklog']> {
      return backlogs.saveBacklog({
        name,
        owner: options.owner ?? 'ada',
        repositories: options.repositories ?? ['web'],
        mergeMode: 'green',
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
