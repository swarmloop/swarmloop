import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Repository } from 'typeorm';
import { Clock } from '../core/clock';
import { normalizePhases } from '../core/pipeline-result';
import { PHASES } from '../contract/steps';
import type { PhaseName } from '../contract/steps';
import { RunRepository } from './run.repository';
import { FlowEntity } from './entities';
import { writeRunState } from './run-state';

@Injectable()
export class FlowRepository {
  constructor(
    private readonly clock: Clock,
    @InjectRepository(FlowEntity) private readonly flows: Repository<FlowEntity>,
    private readonly runRepository: RunRepository,
  ) {}

  /** Append a launch. The first row with a null fromStep is the original selection. `cause` says why a later one was made. */
  async noteFlow(key: string, phases: readonly string[], fromStep: string | null, cause?: 'rebase'): Promise<void> {
    const selected = normalizePhases(phases);
    let run = await this.runRepository.findRun(key);
    if (!run) {
      run = await this.runRepository.begin(key, 'requirements');
      writeRunState(run, { status: 'waiting' });
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
        cause: cause ?? null,
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

  /** The relaunches after a rebase of each of the runs, oldest first, in one read. */
  async listRebases(runIds: number[]): Promise<Map<number, FlowEntity[]>> {
    const byRun = new Map<number, FlowEntity[]>();
    if (runIds.length === 0) return byRun;
    const rows = await this.flows.find({ where: { runId: In(runIds), cause: 'rebase' }, order: { id: 'ASC' } });
    for (const row of rows) byRun.set(row.runId, [...(byRun.get(row.runId) ?? []), row]);
    return byRun;
  }

  async listFlows(runId: number): Promise<FlowEntity[]> {
    return this.flows.find({ where: { runId }, order: { id: 'ASC' } });
  }
}
