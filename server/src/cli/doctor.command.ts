import { Command, CommandRunner } from 'nest-commander';
import { machineToken } from '../auth/machine-token';
import { AppConfig } from '../config/env';
import { resolveRepoRoot } from '../config/repo-root';
import { ReadinessService } from '../readiness/readiness.service';

@Command({ name: 'doctor', description: 'Check that a run can start' })
export class DoctorCommand extends CommandRunner {
  constructor(
    private readonly readiness: ReadinessService,
    private readonly config: AppConfig,
  ) {
    super();
  }

  async run(): Promise<void> {
    const { items } = await this.readiness.report();
    for (const item of items) {
      process.stdout.write(`[${item.status}] ${item.id}: ${item.line} -> ${item.action}\n`);
    }
    const { SWARMLOOP_ROOT, SWARMLOOP_TOKEN } = this.config.env;
    process.stdout.write(
      `machine token: ${machineToken(resolveRepoRoot(SWARMLOOP_ROOT, __dirname), SWARMLOOP_TOKEN)}\n`,
    );
    if (items.some((item) => item.status === 'fail')) {
      process.exitCode = 1;
    }
  }
}
