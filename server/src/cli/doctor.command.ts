import { Command, CommandRunner } from 'nest-commander';
import { ReadinessService } from '../readiness/readiness.service';

@Command({ name: 'doctor', description: 'Check that a run can start' })
export class DoctorCommand extends CommandRunner {
  constructor(private readonly readiness: ReadinessService) {
    super();
  }

  async run(): Promise<void> {
    const { items } = await this.readiness.report();
    for (const item of items) {
      process.stdout.write(`[${item.status}] ${item.id}: ${item.line} -> ${item.action}\n`);
    }
    if (items.some((item) => item.status === 'fail')) {
      process.exitCode = 1;
    }
  }
}
