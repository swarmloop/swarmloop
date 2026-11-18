import { Injectable, Logger, type OnModuleDestroy } from '@nestjs/common';
import { Clock } from '../../core/clock';
import { enteredBefore } from '../../core/entered-marks';
import type { ServerStallKind } from '../../contract/server-stall';
import { ServerStallRepository, type ServerStallDraft } from '../../history/server-stall.repository';
import type { DockerMachine } from '../../sandbox/docker-machine';
import type { RunningWork } from '../../sandbox/running-work';
import { SandboxService } from '../../sandbox/sandbox.service';
import { WorkerTicks, type TickSource } from './tick-worker';

const TICK_MS = 1000;
const STALL_MS = 10_000;
/** The worker ticks every second; a main loop gap is a server stall when it kept at least half of that pace. */
const WORKER_TICK_MS = 2000;

type Load = ReturnType<RunningWork['load']>;

/** What was known at the last tick: the stall that follows is judged against it. */
interface Baseline {
  at: number;
  workerTicks: number;
  load: Load;
  machine: DockerMachine | undefined;
}

/** The one place a stall of the server is detected and written: a main loop gap over 10 s, once per gap. */
@Injectable()
export class ServerStallWatch implements OnModuleDestroy {
  private readonly logger = new Logger(ServerStallWatch.name);
  private timer: NodeJS.Timeout | undefined;
  private ticks: TickSource | undefined;
  private baseline: Baseline | undefined;
  private writes: Promise<void> = Promise.resolve();

  constructor(
    private readonly clock: Clock,
    private readonly sandbox: SandboxService,
    private readonly stalls: ServerStallRepository,
  ) {}

  async start(ticks: TickSource = new WorkerTicks()): Promise<void> {
    await this.sandbox.machine();
    this.ticks = ticks;
    this.baseline = this.snapshot(ticks);
    this.timer = setInterval(() => this.tick(ticks), TICK_MS);
    this.timer.unref();
  }

  async onModuleDestroy(): Promise<void> {
    clearInterval(this.timer);
    this.timer = undefined;
    await this.ticks?.close();
    await this.writes;
  }

  private tick(ticks: TickSource): void {
    const before = this.baseline;
    const now = this.snapshot(ticks);
    this.baseline = now;
    if (before && now.at - before.at > STALL_MS) {
      this.queue(before, now);
    }
  }

  private snapshot(ticks: TickSource): Baseline {
    return {
      at: this.clock.now(),
      workerTicks: ticks.ticks(),
      load: this.sandbox.work.load(),
      machine: this.sandbox.knownMachine(),
    };
  }

  private queue(before: Baseline, now: Baseline): void {
    const gap = now.at - before.at;
    const kind: ServerStallKind =
      now.workerTicks - before.workerTicks >= Math.floor(gap / WORKER_TICK_MS) ? 'server-blocked' : 'host-paused';
    const draft: ServerStallDraft = {
      startedAt: new Date(before.at).toISOString(),
      durationMs: gap,
      kind,
      runningAgents: before.load.agents,
      runningChecks: before.load.checks,
      runningSetups: before.load.setups,
      cpuPercent: before.load.cpuPercent,
      memoryBytes: before.load.memoryBytes,
      vmCpus: before.machine?.cpus ?? null,
      vmMemoryBytes: before.machine?.memoryBytes ?? null,
      entered: kind === 'server-blocked' ? enteredBefore(before.at + TICK_MS) : null,
    };
    this.writes = this.writes
      .then(() => this.stalls.record(draft))
      .catch((error: unknown) => {
        this.logger.warn(`A stall was not recorded: ${error instanceof Error ? error.message : String(error)}`);
      });
  }
}
