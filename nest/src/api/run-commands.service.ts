import { BadRequestException, ConflictException, Injectable } from '@nestjs/common';
import { RunEntity } from '../history/entities';
import { HistoryService } from '../history/history.service';
import { PipelineService } from '../pipeline/pipeline.service';
import { assertKey, isStep, nextSessionKey, normalizePhases, PhaseName, pipelineStepOf, reviewerOf, ticketKey } from '../pipeline/pipeline-result';
import { CHECKOUT_NAME, storedProjects } from '../steps/prepare/checkout-path';
import { PrepareService } from '../steps/prepare/prepare.service';
import { ProjectAppendService } from '../steps/prepare/project-append.service';
import { SwarmloopError } from '../swarmloop-error';
import { taskKeys } from '../steps/requirements/requirements.service';
import { FlowView } from './run-view/run-view.types';
import { requireRun, RunQueriesService } from './run-queries.service';

@Injectable()
export class RunCommandsService {
  constructor(
    private readonly history: HistoryService,
    private readonly pipeline: PipelineService,
    private readonly projects: ProjectAppendService,
    private readonly prepare: PrepareService,
    private readonly queries: RunQueriesService,
  ) {}

  async addProject(key: string, name: string): Promise<{ projects: string[]; applied: boolean }> {
    const trimmed = name.trim();
    if (!trimmed) {
      throw new BadRequestException('name is missing');
    }
    await requireRun(this.history, key);
    try {
      return await this.projects.add(key, trimmed);
    } catch (error) {
      if (error instanceof SwarmloopError) {
        throw new BadRequestException(error.message);
      }
      throw error;
    }
  }

  async start(body: { key?: string; prompt?: string; path?: string; projects?: string[]; phases?: string[] }): Promise<{ http: number; body: { key: string; status: string } }> {
    const prompt = body.prompt?.trim() || undefined;
    const given = body.key?.trim() ?? '';
    if (!given && !prompt) {
      throw new BadRequestException('prompt is missing');
    }
    const phases = this.phases(body.phases);
    let key = given || taskKeys(prompt ?? '', '')[0] || `run-${Date.now().toString(36)}`;
    try {
      assertKey(key);
    } catch (error) {
      throw new BadRequestException(error instanceof Error ? error.message : 'run id is invalid');
    }
    const path = body.path?.trim() || undefined;
    const opened = await this.openSession(key);
    key = opened.key;
    const existing = opened.run;
    if (!path && !prompt && !existing?.prompt) {
      throw new BadRequestException('prompt is missing');
    }
    const projects = storedProjects(existing?.projects).length > 0 ? storedProjects(existing?.projects) : this.projectNames(body.projects);
    if (!path && projects.length === 0) {
      throw new BadRequestException('projects is missing');
    }
    if (!existing || (body.phases !== undefined && !this.history.held(existing))) {
      await this.history.noteFlow(key, phases, null);
    }
    const acceptsPrompt = !existing || existing.currentStep === 'requirements';
    if (prompt && (path || !acceptsPrompt)) {
      await this.rememberPrompt(key, prompt);
    }
    const result = path
      ? await this.pipeline.startDetached(key, { path, phases }, 'code-review')
      : await this.pipeline.startDetached(key, acceptsPrompt ? { prompt, projects, phases } : { projects, phases });
    return this.accepted(key, result);
  }

  async answers(key: string, body: { answers?: { kind?: string; id?: string; body?: string }[] }): Promise<FlowView> {
    const run = await requireRun(this.history, key);
    if (this.history.held(run)) {
      throw new ConflictException(`${key} is already running`);
    }
    const incoming = body.answers ?? [];
    const view = await this.queries.flow(key);
    for (const item of view.items) {
      const found = incoming.find((answer) => answer.kind === item.kind && answer.id === item.id);
      if (!found?.body?.trim()) {
        throw new BadRequestException('answers are missing');
      }
    }
    const questions = incoming.filter((answer) => answer.kind === 'question' && answer.id && answer.body?.trim());
    if (questions.length > 0) {
      const text = questions.map((answer) => `question: ${answer.id}\nanswer: ${answer.body?.trim()}`).join('\n\n');
      await this.history.putDocument(run, 'answers', `${text}\n`);
    }
    for (const answer of incoming.filter((item) => item.kind === 'paste' && item.id && item.body?.trim())) {
      await this.history.savePaste(key, answer.id ?? '', answer.body?.trim() ?? '');
    }
    this.demandStart(await this.pipeline.startDetached(key));
    return this.queries.flow(key);
  }

  async startStep(
    key: string,
    step: string,
    body: { prompt?: string; path?: string } = {},
  ): Promise<{ http: number; body: { key: string; status: string } }> {
    const name = pipelineStepOf(step);
    if (!isStep(name) || name === 'done') {
      throw new BadRequestException(`${step} is unknown`);
    }
    await requireRun(this.history, key);
    const prompt = body.prompt?.trim();
    const path = body.path?.trim();
    return this.accepted(
      key,
      await this.pipeline.startDetached(
        key,
        { prompt: prompt || undefined, path: path || undefined, reviewer: reviewerOf(step) },
        name,
      ),
    );
  }

  async replay(key: string, step: string, prompt: string, phases?: string[]): Promise<{ http: number; body: { key: string; status: string } }> {
    const name = pipelineStepOf(step);
    if (!isStep(name) || name === 'done') {
      throw new BadRequestException(`${step} is unknown`);
    }
    const text = prompt.trim();
    if (!text) {
      throw new BadRequestException('prompt is missing');
    }
    await requireRun(this.history, key);
    if (phases !== undefined) {
      await this.history.noteFlow(key, this.phases(phases), name);
    }
    return this.accepted(key, await this.pipeline.replay(key, name, text));
  }

  async stop(key: string): Promise<{ http: number; body: { key: string; status: string } }> {
    await requireRun(this.history, key);
    const result = await this.pipeline.stop(key);
    if (result.exitCode !== 0) {
      throw new ConflictException(result.message);
    }
    return { http: 200, body: { key, status: 'stopped' } };
  }

  async remove(key: string): Promise<{ key: string }> {
    try {
      assertKey(key);
    } catch (error) {
      throw new BadRequestException(error instanceof Error ? error.message : 'run id is invalid');
    }
    const run = await requireRun(this.history, key);
    const stopped = await this.pipeline.stop(key);
    if (stopped.exitCode !== 0) {
      throw new ConflictException(stopped.message);
    }
    await this.prepare.removeWorktrees(key);
    await this.history.remove(run);
    return { key };
  }

  async resume(key: string, prompt?: string): Promise<{ http: number; body: { key: string; status: string } }> {
    const view = await this.queries.flow(key);
    if (view.resume === 'need-answers') {
      throw new BadRequestException('answers are missing');
    }
    if (view.resume === 'blocked') {
      throw new ConflictException('run is blocked');
    }
    if (view.resume === 'running') {
      throw new ConflictException(`${key} is already running`);
    }
    if (view.resume === 'done') {
      return { http: 200, body: { key, status: 'done' } };
    }
    return this.accepted(key, await this.pipeline.startDetached(key, prompt?.trim() ? { prompt: prompt.trim() } : {}));
  }

  /** New run always opens the next free session. Resume keeps the current one. */
  private async openSession(key: string): Promise<{ key: string; run: RunEntity | null }> {
    const ticket = ticketKey(key);
    const family = (await this.history.listRuns()).filter((run) => ticketKey(run.key) === ticket);
    const session = nextSessionKey(ticket, family.map((run) => run.key));
    return { key: session, run: await this.history.findRun(session) };
  }

  private phases(input?: string[]): PhaseName[] {
    try {
      return normalizePhases(input);
    } catch (error) {
      throw new BadRequestException(error instanceof Error ? error.message : 'phases are invalid');
    }
  }

  private projectNames(input?: string[]): string[] {
    const names = [...new Set((input ?? []).map((name) => name.trim()).filter((name) => name.length > 0))].sort();
    for (const name of names) {
      if (name.startsWith('.') || name.startsWith('run-') || !CHECKOUT_NAME.test(name)) {
        throw new BadRequestException(`${name} is not a project`);
      }
    }
    return names;
  }

  private async rememberPrompt(key: string, prompt: string): Promise<void> {
    const existing = await this.history.findRun(key);
    if (existing) {
      if (!this.history.held(existing)) {
        existing.prompt = prompt;
        await this.history.saveRun(existing);
      }
      return;
    }
    const created = await this.history.begin(key, 'code-review');
    created.status = 'waiting';
    created.ownerPid = null;
    created.prompt = prompt;
    created.stepStartedAt = null;
    await this.history.saveRun(created);
  }

  private demandStart(result: { exitCode: number; message: string }): void {
    if (result.exitCode === 0) {
      return;
    }
    if (result.message.includes('already running')) {
      throw new ConflictException(result.message);
    }
    throw new BadRequestException(result.message);
  }

  accepted(key: string, result: { exitCode: number; message: string }): { http: number; body: { key: string; status: string } } {
    this.demandStart(result);
    if (result.message.endsWith('is done')) {
      return { http: 200, body: { key, status: 'done' } };
    }
    return { http: 202, body: { key, status: 'started' } };
  }
}
