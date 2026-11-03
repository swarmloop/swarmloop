import { Injectable } from '@nestjs/common';
import { AppConfig } from '../config/env';
import type { PhaseName } from '../contract/steps';
import type {
  AgentExchangeEntity,
  CheckoutEntity,
  DocumentEntity,
  FlowEntity,
  HttpCallEntity,
  LoopEventEntity,
  PasteEntity,
  ResourceSampleEntity,
  RunEntity,
  StepStatEntity,
} from './entities';
import type { VisitDraft } from './visit';
import { root, runDir } from './run-paths';
import { RunRepository } from './run.repository';
import { DocumentRepository } from './document.repository';
import { VisitRepository } from './visit.repository';
import { FlowRepository } from './flow.repository';
import { EventRepository } from './event.repository';
import { CheckoutRepository } from './checkout.repository';

@Injectable()
export class HistoryService {
  constructor(
    private readonly config: AppConfig,
    private readonly runRepository: RunRepository,
    private readonly documentRepository: DocumentRepository,
    private readonly visitRepository: VisitRepository,
    private readonly flowRepository: FlowRepository,
    private readonly eventRepository: EventRepository,
    private readonly checkoutRepository: CheckoutRepository,
  ) {}

  /** @deprecated Removed in part 33. */
  root(): string {
    return root(this.config);
  }

  /** @deprecated Removed in part 33. */
  runDir(key: string): string {
    return runDir(this.config, key);
  }

  /** @deprecated Removed in part 33. */
  async tokenTotal(runId: number): Promise<number> {
    return this.visitRepository.tokenTotal(runId);
  }

  /** @deprecated Removed in part 33. */
  async findRun(key: string): Promise<RunEntity | null> {
    return this.runRepository.findRun(key);
  }

  /** @deprecated Removed in part 33. */
  async openWaiting(key: string, targetPath: string): Promise<RunEntity> {
    return this.runRepository.openWaiting(key, targetPath);
  }

  /** @deprecated Removed in part 33. */
  async begin(key: string, step: string): Promise<RunEntity> {
    return this.runRepository.begin(key, step);
  }

  /** @deprecated Removed in part 33. */
  held(run: RunEntity): boolean {
    return this.runRepository.held(run);
  }

  /** @deprecated Removed in part 33. */
  async saveStat(stat: StepStatEntity): Promise<void> {
    return this.visitRepository.saveStat(stat);
  }

  /** @deprecated Removed in part 33. */
  async saveRun(run: RunEntity): Promise<RunEntity> {
    return this.runRepository.saveRun(run);
  }

  /** @deprecated Removed in part 33. */
  async listFlows(runId: number): Promise<FlowEntity[]> {
    return this.flowRepository.listFlows(runId);
  }

  /** @deprecated Removed in part 33. */
  async noteFlow(key: string, phases: readonly string[], fromStep: string | null): Promise<void> {
    return this.flowRepository.noteFlow(key, phases, fromStep);
  }

  /** @deprecated Removed in part 33. */
  async activePhases(runId: number): Promise<PhaseName[]> {
    return this.flowRepository.activePhases(runId);
  }

  /** @deprecated Removed in part 33. */
  async listCheckouts(): Promise<CheckoutEntity[]> {
    return this.checkoutRepository.listCheckouts();
  }

  /** @deprecated Removed in part 33. */
  async saveCheckout(name: string, path: string): Promise<void> {
    return this.checkoutRepository.saveCheckout(name, path);
  }

  /** @deprecated Removed in part 33. */
  async listDenyPaths(): Promise<string[]> {
    return this.checkoutRepository.listDenyPaths();
  }

  /** @deprecated Removed in part 33. */
  async latestBody(key: string, kind: string): Promise<string | null> {
    return this.documentRepository.latestBody(key, kind);
  }

  /** @deprecated Removed in part 33. */
  async latestDocument(key: string, kind: string): Promise<{ id: number; body: string } | null> {
    return this.documentRepository.latestDocument(key, kind);
  }

  /** @deprecated Removed in part 33. */
  async putDocument(run: RunEntity, kind: string, body: string): Promise<void> {
    return this.documentRepository.putDocument(run, kind, body);
  }

  /** @deprecated Removed in part 33. */
  async hasDocument(key: string, kind: string): Promise<boolean> {
    return this.documentRepository.hasDocument(key, kind);
  }

  /** @deprecated Removed in part 33. */
  async finishVisit(run: RunEntity, visit: VisitDraft): Promise<StepStatEntity> {
    return this.visitRepository.finishVisit(run, visit);
  }

  /** @deprecated Removed in part 33. */
  async recordLoop(run: RunEntity, counter: string, attempt: number, reason: string): Promise<void> {
    return this.eventRepository.recordLoop(run, counter, attempt, reason);
  }

  /** @deprecated Removed in part 33. */
  async appendProgress(_key: string, _line: string): Promise<void> {
    return Promise.resolve();
  }

  /** @deprecated Removed in part 33. */
  async listRuns(): Promise<RunEntity[]> {
    return this.runRepository.listRuns();
  }

  /** @deprecated Removed in part 33. */
  async remove(run: RunEntity): Promise<void> {
    return this.runRepository.remove(run);
  }

  /** @deprecated Removed in part 33. */
  async listDocuments(runId: number): Promise<DocumentEntity[]> {
    return this.documentRepository.listDocuments(runId);
  }

  /** @deprecated Removed in part 33. */
  async listStats(runId: number): Promise<StepStatEntity[]> {
    return this.visitRepository.listStats(runId);
  }

  /** @deprecated Removed in part 33. */
  async durationByRun(): Promise<Map<number, number>> {
    return this.runRepository.durationByRun();
  }

  /** @deprecated Removed in part 33. */
  async codeReviewReportMs(runId?: number): Promise<Map<number, number>> {
    return this.visitRepository.codeReviewReportMs(runId);
  }

  /** @deprecated Removed in part 33. */
  async listSamples(statIds: number[]): Promise<ResourceSampleEntity[]> {
    return this.visitRepository.listSamples(statIds);
  }

  /** @deprecated Removed in part 33. */
  async listExchanges(statIds: number[]): Promise<AgentExchangeEntity[]> {
    return this.visitRepository.listExchanges(statIds);
  }

  /** @deprecated Removed in part 33. */
  async latestChatId(runId: number): Promise<string | null> {
    return this.visitRepository.latestChatId(runId);
  }

  /** @deprecated Removed in part 33. */
  async listLoops(runId: number): Promise<LoopEventEntity[]> {
    return this.eventRepository.listLoops(runId);
  }

  /** @deprecated Removed in part 33. */
  async listHttpCalls(runId: number): Promise<HttpCallEntity[]> {
    return this.eventRepository.listHttpCalls(runId);
  }

  /** @deprecated Removed in part 33. */
  async listPastes(runKey: string): Promise<PasteEntity[]> {
    return this.checkoutRepository.listPastes(runKey);
  }

  /** @deprecated Removed in part 33. */
  async savePaste(runKey: string, url: string, body: string): Promise<void> {
    return this.checkoutRepository.savePaste(runKey, url, body);
  }
}
