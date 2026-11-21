import type { AppConfig } from '../config/env';
import { readDefaultSettings } from '../config/load-env';
import type { CpuSlice } from './sandbox-types';
import type { SandboxLaunch } from './sandbox-launch';
import type { DockerRunner } from './run-containers';
import { readDockerMachine } from './docker-machine';
import type { DockerMachine } from './docker-machine';
import { memoryCapOf } from './memory-cap';
import { checksAtOnce, CoreTurns } from './core-slices';

/** What Docker's machine allows each container: its kept reading, the memory cap and the cores. */
export class MachineLimits {
  private machineInfo: DockerMachine | undefined;
  private reading: Promise<DockerMachine | undefined> | undefined;
  private readonly coreTurns = new CoreTurns();

  constructor(
    private readonly docker: () => DockerRunner,
    private readonly config?: AppConfig,
  ) {}

  /** Drops the kept reading, so the next `machine()` asks Docker again. */
  forget(): void {
    this.machineInfo = undefined;
    this.reading = undefined;
  }

  /** Docker's CPUs and memory. Only an answer is kept, so an outage is tried again. */
  machine(): Promise<DockerMachine | undefined> {
    if (this.machineInfo) return Promise.resolve(this.machineInfo);
    if (!this.reading) {
      const reading = readDockerMachine((args, timeoutMs) => this.docker()(args, timeoutMs)).then((machine) => {
        if (this.reading === reading) {
          this.machineInfo = machine;
          this.reading = undefined;
        }
        return machine;
      });
      this.reading = reading;
    }
    return this.reading;
  }

  /** The kept answer of `machine()`; no docker call. */
  knownMachine(): DockerMachine | undefined {
    return this.machineInfo;
  }

  /** Docker's memory less the reserve, the same for every container. */
  async containerCap(): Promise<number | undefined> {
    return memoryCapOf(
      await this.machine(),
      (this.config?.env.RESERVE_MEMORY_GB ?? Number(readDefaultSettings().RESERVE_MEMORY_GB)) * 1024 ** 3,
    );
  }

  /** The cores a project container may use, from the cores Docker has and the checks that fit on them. */
  coreSlice(given: Pick<SandboxLaunch, 'project' | 'checkPlace'>): CpuSlice | undefined {
    const parallel = this.config?.env.CHECKS_PARALLEL ?? Number(readDefaultSettings().CHECKS_PARALLEL);
    const machine = this.knownMachine();
    return this.coreTurns.sliceFor(machine, checksAtOnce(machine?.cpus, parallel), given);
  }
}
