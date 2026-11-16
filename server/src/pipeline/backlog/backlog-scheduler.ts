import type { OnModuleDestroy } from '@nestjs/common';
import { Injectable, Logger } from '@nestjs/common';
import { AppConfig } from '../../config/env';
import { Clock } from '../../core/clock';
import { BacklogRepository, type BacklogTaskRecord } from '../../history/backlog.repository';
import { RunRepository } from '../../history/run.repository';
import { deriveState } from '../../history/run-state';
import { RepositoryHost } from '../../steps/shared/repository-host';
import { BacklogStartPort } from './backlog-start-port';
import { readMains } from './main-readings';
import { handPlaces } from './place-turns';
import {
  backlogTasks,
  candidates,
  dependencyWait,
  mainWait,
  placeWait,
  repositoriesOf,
  type BacklogTask,
  type MainReading,
  type RunFacts,
} from './task-readiness';

/** One backlog in a pass: its tasks as read now, and the records as they are stored. */
interface BacklogPass {
  id: number;
  owner: string;
  paused: boolean;
  records: Map<string, BacklogTaskRecord>;
  tasks: BacklogTask[];
  /** The tasks that may start now, in plan order, after the main of their repositories was read. */
  queue: BacklogTask[];
  /** Tasks whose stored key the server does not know: the start never arrived. */
  restarts: BacklogTask[];
}

/**
 * Starts the tasks of the backlogs on the server's tick: the epic's rules for what is ready, a green main of every
 * repository a task touches, and at most `BACKLOG_PARALLEL` tasks started and not merged on the whole server.
 * One pass at a time; a call that comes while a pass works joins it.
 */
@Injectable()
export class BacklogScheduler implements OnModuleDestroy {
  private readonly logger = new Logger(BacklogScheduler.name);
  private timer: NodeJS.Timeout | null = null;
  private pass: Promise<void> | null = null;
  /** The backlog that got the last place, so the next place goes to the backlog after it. */
  private lastServed: number | null = null;

  constructor(
    private readonly backlogs: BacklogRepository,
    private readonly runs: RunRepository,
    private readonly host: RepositoryHost,
    private readonly port: BacklogStartPort,
    private readonly config: AppConfig,
    private readonly clock: Clock,
  ) {}

  schedule(): void {
    this.stop();
    this.timer = setInterval(() => {
      this.tick().catch((error: unknown) => {
        this.logger.warn(`backlog pass failed: ${error instanceof Error ? error.message : String(error)}`);
      });
    }, this.config.env.RECONCILE_MS);
    this.timer.unref();
  }

  /** Stops the timer and waits for the pass that runs, so nothing reads the database after it closes. */
  async onModuleDestroy(): Promise<void> {
    this.stop();
    await this.pass?.catch(() => undefined);
  }

  private stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  tick(): Promise<void> {
    if (this.pass) return this.pass;
    const pass: Promise<void> = this.run().finally(() => {
      if (this.pass === pass) this.pass = null;
    });
    this.pass = pass;
    return pass;
  }

  private async run(): Promise<void> {
    const backlogs = await this.backlogs.listBacklogs();
    if (backlogs.length === 0) return;
    const passes: BacklogPass[] = [];
    for (const backlog of backlogs) passes.push(await this.read(backlog));
    const open = passes.filter((pass) => !pass.paused);
    const mains = new Map<string, MainReading>();
    for (const pass of open) {
      pass.queue = candidates(pass.tasks);
      await readMains(this.host, repositoriesOf(pass.queue), pass.owner, mains);
      pass.queue = pass.queue.filter((task) => mainWait(task, pass.tasks, mains) === null);
    }
    const started = await this.backlogs.startedUnmergedCount();
    const free = Math.max(0, this.config.env.BACKLOG_PARALLEL - started);
    const queues = new Map(open.map((pass) => [pass.id, pass.queue]));
    const { chosen, last } = handPlaces(
      queues,
      passes.map((pass) => pass.id),
      this.lastServed,
      free,
    );
    this.lastServed = last;
    const taken = [...chosen.values()].reduce((sum, tasks) => sum + tasks.length, 0);
    for (const pass of open) {
      const mine = chosen.get(pass.id) ?? [];
      await this.say(pass, mains, mine, started + taken);
      for (const task of pass.restarts) await this.start(pass, task, task.runKey as string);
      for (const task of mine) await this.start(pass, task, `${task.id}-${this.clock.now().toString(36)}`);
    }
  }

  /** The backlog's tasks, with the shown status of each one's run stored when it changed. */
  private async read(backlog: { id?: number; owner: string; paused: boolean }): Promise<BacklogPass> {
    const id = backlog.id as number;
    const [stored, milestones] = [await this.backlogs.tasks(id), await this.backlogs.milestones(id)];
    const active = new Set(milestones.filter((milestone) => milestone.status === 'active').map((m) => m.id as number));
    const facts = new Map<string, RunFacts>();
    for (const record of stored) {
      const run = record.runKey === null ? null : await this.runs.findRun(record.runKey);
      if (record.runKey !== null && run)
        facts.set(record.runKey, { state: deriveState(run).state, currentStep: run.currentStep });
    }
    const tasks = backlogTasks(stored, active, facts);
    const records = new Map(stored.map((record) => [record.slug, record]));
    const pass: BacklogPass = {
      id,
      owner: backlog.owner,
      paused: backlog.paused,
      records,
      tasks,
      queue: [],
      restarts: [],
    };
    for (const task of tasks) {
      await this.update(pass, task.id, { status: task.status });
    }
    pass.restarts = tasks.filter(
      (task) => task.runKey !== null && !facts.has(task.runKey) && task.status === 'waiting',
    );
    return pass;
  }

  /** Stores what changed on a task. */
  private async update(pass: BacklogPass, slug: string, patch: Partial<BacklogTaskRecord>): Promise<void> {
    const record = pass.records.get(slug) as BacklogTaskRecord;
    if (!Object.entries(patch).some(([field, value]) => record[field as keyof BacklogTaskRecord] !== value)) return;
    pass.records.set(slug, await this.backlogs.saveTask({ ...record, ...patch }));
  }

  /** What each waiting task of the backlog waits for. A ready task that took no place waits for one. */
  private async say(
    pass: BacklogPass,
    mains: Map<string, MainReading>,
    chosen: BacklogTask[],
    started: number,
  ): Promise<void> {
    const taken = new Set(chosen.map((task) => task.id));
    for (const task of pass.tasks) {
      const waiting = task.mayStart && task.runKey === null && task.status === 'waiting';
      const note = !waiting
        ? ''
        : (dependencyWait(task, pass.tasks) ??
          mainWait(task, pass.tasks, mains) ??
          (taken.has(task.id) ? '' : placeWait(started)));
      await this.update(pass, task.id, { note });
    }
  }

  /** Saves the key of the run, then starts it. A start that throws keeps the key, so the next tick asks the server whether it arrived. */
  private async start(pass: BacklogPass, task: BacklogTask, key: string): Promise<void> {
    await this.update(pass, task.id, { runKey: key });
    try {
      await this.port.start({ key, prompt: task.description, projects: task.repositories, owner: pass.owner });
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      await this.update(pass, task.id, { note: `could not start: ${reason}; next try on the next tick` });
    }
  }
}
