import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Clock } from '../core/clock';
import { normalizePhases } from '../core/pipeline-result';
import { PHASES } from '../contract/steps';
import type { PhaseName } from '../contract/steps';
import { RunRepository } from './run.repository';
import { FlowEntity } from './entities';

@Injectable()
export class FlowRepository {
  constructor(
    private readonly clock: Clock,
    @InjectRepository(FlowEntity) private readonly flows: Repository<FlowEntity>,
    private readonly runRepository: RunRepository,
  ) {}

  /** Append a launch. The first row with a null fromStep is the original selection. */
  async noteFlow(key: string, phases: readonly string[], fromStep: string | null): Promise<void> {
    const selected = normalizePhases(phases);
    let run = await this.runRepository.findRun(key);
    if (!run) {
      run = await this.runRepository.begin(key, 'requirements');
      run.status = 'waiting';
      run.ownerPid = null;
      run.stepStartedAt = null;
      run = await this.runRepository.saveRun(run);
    }
    const existing = await this.listFlows(run.id);
    const recordedFrom = existing.some((row) => row.fromStep === null) ? (fromStep ?? run.currentStep) : fromStep;
    await this.flows.save(
      this.flows.create({
        runId: run.id,
        phases: JSON.stringify(selected),
        fromStep: recordedFrom,
        createdAt: this.clock.iso(),
      }),
    );
  }

  async activePhases(runId: number): Promise<PhaseName[]> {
    const latest = (await this.listFlows(runId)).at(-1);
    if (!latest) {
      return [...PHASES];
    }
    try {
      const parsed = JSON.parse(latest.phases) as unknown;
      return normalizePhases(
        Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === 'string') : undefined,
      );
    } catch {
      return [...PHASES];
    }
  }

  async listFlows(runId: number): Promise<FlowEntity[]> {
    return this.flows.find({ where: { runId }, order: { id: 'ASC' } });
  }
}
