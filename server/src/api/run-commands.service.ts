import { BadRequestException, ConflictException, Inject, Injectable } from '@nestjs/common';
import { Clock } from '../core/clock';
import { AppConfig } from '../config/env';
import { RunEntity } from '../history/entities';
import { RunRepository } from '../history/run.repository';
import { DocumentRepository } from '../history/document.repository';
import { FlowRepository } from '../history/flow.repository';
import { CheckoutRepository } from '../history/checkout.repository';
import { PipelineService } from '../pipeline/pipeline.service';
import { assertKey, isStep, nextSessionKey, normalizePhases, ticketKey } from '../core/pipeline-result';
import type { Subtask } from '../contract/subtask';
import { branchName, summaryForBranch } from '../steps/branch/branch-name';
import { requirementsBrief } from '../steps/shared/requirements-brief';
import { PhaseName, pipelineStepOf, reviewerOf } from '../contract/steps';
import { CHECKOUT_NAME, storedProjects } from '../steps/prepare/checkout-path';
import { PrepareStep } from '../steps/prepare/prepare.step';
import { ProjectAppendService } from '../steps/prepare/project-append.service';
import { SwarmloopError } from '../core/swarmloop-error';
import { type IssueTracker, runKeys } from '../integrations/issue-tracker/issue-tracker';
import { ISSUE_TRACKER } from '../integrations/issue-tracker/tokens';
import {
  AnswersBody,
  CreateRunBody,
  TicketKeysBody,
  TicketKeysView,
  FlowView,
  ProjectsView,
  RemovedRunView,
  RunRef,
  StartStepBody,
} from '../contract/api';
import { requireRun, RunQueriesService } from './run-queries.service';
import { writeRunState } from '../history/run-state';

/** The prompt of a subtask: its task, the parent's requirements as context, and the branch it starts from. */
function subtaskPrompt(task: Subtask, brief: string, branch: string): string {
  return [
    `${task.title}\n\n${task.description}`,
    `files: ${task.files.join(', ')}`,
    `proof: ${task.proof}`,
    `Requirements of the parent run, for context:\n${brief.trimEnd()}`,
    `branch: ${branch}`,
  ].join('\n\n');
}

/** What `plan` decided for a new run. It is the payload of the start command. */
export interface StartPlan {
  key: string;
  prompt?: string;
  path?: string;
  phases: PhaseName[];
  phasesGiven: boolean;
  projects: string[];
  created?: boolean;
  /** Set for a subtask: the run row is made with these two values. */
  parentRunId?: number;
  taskId?: string;
  /** The planner may split the run into subtasks. Never set for a subtask. */
  split?: boolean;
}

@Injectable()
export class RunCommandsService {
  constructor(
    private readonly runs: RunRepository,
    private readonly documents: DocumentRepository,
    private readonly flows: FlowRepository,
    private readonly checkouts: CheckoutRepository,
    private readonly pipeline: PipelineService,
    private readonly projects: ProjectAppendService,
    private readonly prepare: PrepareStep,
    private readonly queries: RunQueriesService,
    private readonly clock: Clock,
    private readonly config: AppConfig,
    @Inject(ISSUE_TRACKER) private readonly tracker: IssueTracker,
  ) {}

  async addProject(key: string, name: string): Promise<ProjectsView> {
    const trimmed = name.trim();
    if (!trimmed) {
      throw new BadRequestException('name is missing');
    }
    await requireRun(this.runs, key);
    try {
      return await this.projects.add(key, trimmed);
    } catch (error) {
      if (error instanceof SwarmloopError) {
        throw new BadRequestException(error.message);
      }
      throw error;
    }
  }

  /** The keys a run with this prompt and run id would fetch from the tracker. */
  async ticketKeys(body: TicketKeysBody): Promise<TicketKeysView> {
    return { keys: await runKeys(this.tracker, body.key?.trim() ?? '', body.prompt ?? '') };
  }

  /** The checks of a new run, and the session it opens. Nothing is written. */
  async plan(body: CreateRunBody): Promise<StartPlan> {
    const prompt = body.prompt?.trim() || undefined;
    const given = body.key?.trim() ?? '';
    if (!given && !prompt) {
      throw new BadRequestException('prompt is missing');
    }
    const phases = this.phases(body.phases);
    let key = given || (await this.tracker.ticketKeys(prompt ?? ''))[0] || `run-${this.clock.now().toString(36)}`;
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
    const projects =
      storedProjects(existing?.projects).length > 0
        ? storedProjects(existing?.projects)
        : this.projectNames(body.projects);
    if (!path && projects.length === 0) {
      throw new BadRequestException('projects is missing');
    }
    return { key, prompt, path, phases, phasesGiven: body.phases !== undefined, projects, split: this.splits(body) };
  }

  async start(body: CreateRunBody): Promise<RunRef> {
    return this.startPlanned(await this.plan(body));
  }

  /** Starts one task of a parent run as a run of its own. A second call for the same task returns that run. */
  async startSubtask(parent: RunEntity, task: Subtask): Promise<RunRef> {
    const existing = await this.runs.findSubtask(parent, task.id);
    if (existing) {
      return { key: existing.key, status: existing.status === 'done' ? 'done' : 'started' };
    }
    const requirements = await this.documents.latestBody(parent.key, 'requirements');
    if (!requirements?.trim()) {
      throw new BadRequestException('requirements is missing');
    }
    const branch = branchName(parent.key, summaryForBranch(requirements, parent.key));
    const plan = await this.plan({
      key: `${parent.key}-${task.id}`,
      prompt: subtaskPrompt(task, requirementsBrief(requirements), branch),
      projects: storedProjects(parent.projects),
    });
    return this.startPlanned({ ...plan, split: false, parentRunId: parent.id, taskId: task.id });
  }

  /** Starts the planned run. `created` says the command path made the run row just now. */
  async startPlanned(plan: StartPlan): Promise<RunRef> {
    const { key, prompt, path, phases, projects } = plan;
    const existing = plan.created ? null : await this.runs.findRun(key);
    if (!existing && plan.parentRunId !== undefined) {
      // The row only links the subtask to its parent; the run still starts as a new one.
      await this.runs.openSubtask(key, plan.parentRunId, plan.taskId ?? '');
    } else if (!existing && plan.split && !path) {
      await this.runs.openSplit(key);
    }
    if (!existing || (plan.phasesGiven && !this.runs.held(existing))) {
      await this.flows.noteFlow(key, phases, null);
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

  async answers(key: string, body: AnswersBody): Promise<FlowView> {
    const run = await requireRun(this.runs, key);
    if (this.runs.held(run)) {
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
      await this.documents.putDocument(run, 'answers', `${text}\n`);
    }
    for (const answer of incoming.filter((item) => item.kind === 'paste' && item.id && item.body?.trim())) {
      await this.checkouts.savePaste(key, answer.id ?? '', answer.body?.trim() ?? '');
    }
    this.demandStart(await this.pipeline.startDetached(key));
    return this.queries.flow(key);
  }

  async startStep(key: string, step: string, body: StartStepBody = {}): Promise<RunRef> {
    const name = pipelineStepOf(step);
    if (!isStep(name) || name === 'done') {
      throw new BadRequestException(`${step} is unknown`);
    }
    await requireRun(this.runs, key);
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

  async replay(key: string, step: string, prompt: string, phases?: string[]): Promise<RunRef> {
    const name = pipelineStepOf(step);
    if (!isStep(name) || name === 'done') {
      throw new BadRequestException(`${step} is unknown`);
    }
    const text = prompt.trim();
    if (!text) {
      throw new BadRequestException('prompt is missing');
    }
    await requireRun(this.runs, key);
    await this.runs.bumpGeneration(key);
    if (phases !== undefined) {
      await this.flows.noteFlow(key, this.phases(phases), name);
    }
    return this.accepted(key, await this.pipeline.replay(key, name, text));
  }

  async stop(key: string): Promise<RunRef> {
    await requireRun(this.runs, key);
    const result = await this.pipeline.stop(key);
    if (result.exitCode !== 0) {
      throw new ConflictException(result.message);
    }
    return { key, status: 'stopped' };
  }

  async remove(key: string): Promise<RemovedRunView> {
    try {
      assertKey(key);
    } catch (error) {
      throw new BadRequestException(error instanceof Error ? error.message : 'run id is invalid');
    }
    const run = await requireRun(this.runs, key);
    const stopped = await this.pipeline.stop(key);
    if (stopped.exitCode !== 0) {
      throw new ConflictException(stopped.message);
    }
    await this.prepare.removeWorktrees(key);
    await this.runs.remove(run);
    return { key };
  }

  async resume(key: string, prompt?: string): Promise<RunRef> {
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
      return { key, status: 'done' };
    }
    return this.accepted(key, await this.pipeline.startDetached(key, prompt?.trim() ? { prompt: prompt.trim() } : {}));
  }

  /** New run always opens the next free session. Resume keeps the current one. */
  private async openSession(key: string): Promise<{ key: string; run: RunEntity | null }> {
    const ticket = ticketKey(key);
    const family = (await this.runs.listRuns()).filter((run) => ticketKey(run.key) === ticket);
    const session = nextSessionKey(
      ticket,
      family.map((run) => run.key),
    );
    return { key: session, run: await this.runs.findRun(session) };
  }

  /** A subtask never splits. A new run follows its checkbox, then the `SPLIT` default. */
  private splits(body: CreateRunBody): boolean {
    return body.split ?? this.config.env.SPLIT === 'auto';
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
    const existing = await this.runs.findRun(key);
    if (existing) {
      if (!this.runs.held(existing)) {
        existing.prompt = prompt;
        await this.runs.saveRun(existing);
      }
      return;
    }
    const created = await this.runs.begin(key, 'code-review');
    writeRunState(created, { status: 'waiting' });
    created.prompt = prompt;
    created.stepStartedAt = null;
    await this.runs.saveRun(created);
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

  accepted(key: string, result: { exitCode: number; message: string }): RunRef {
    this.demandStart(result);
    if (result.message.endsWith('is done')) {
      return { key, status: 'done' };
    }
    return { key, status: 'started' };
  }
}
