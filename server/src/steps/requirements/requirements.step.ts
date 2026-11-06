import { Inject, Injectable } from '@nestjs/common';
import type { StepCapabilities } from '../contract/step-contract';
import { StepKernel } from '../step-kernel';
import { runDir } from '../../history/run-paths';
import { RunEntity } from '../../history/entities';
import { SampleDraft, sampleSelf } from '../../history/visit';
import { FetchFailed, HttpCallDraft, SwarmloopError, PasteNeeded } from '../../core/swarmloop-error';
import { PipelineResult, StepOptions } from '../../core/pipeline-result';
import { StepName } from '../../contract/steps';
import { IssueBundle } from '../../integrations/issue-tracker/issue-bundle';
import { IssueTracker } from '../../integrations/issue-tracker/issue-tracker';
import { REQUIREMENTS_SOURCE } from '../../integrations/requirements-source/requirements-source.module';
import { RequirementsSource } from '../../integrations/requirements-source/requirements-source';
import { ISSUE_TRACKER } from '../../integrations/issue-tracker/tokens';
import { BaseStep, StepContext, VisitLeftOpen } from '../base-step';
import type { StepSnapshot } from '../step';
import { readPrompt, taskKeys, unreadSource } from './requirements-input';
import {
  emptyWrite,
  RequirementsFinish,
  requirementsOutputs,
  requirementsVisit,
  stopReason,
} from './requirements-visit';
import { ARTIFACTS } from '../contract/artifacts';
import type { InputSpec, Route, StepInput, StepResult } from '../contract/step-contract';

/** The progress is read when a pass resumes, not on every pass. */
const INPUTS = {
  requirementsProgress: { artifact: ARTIFACTS.requirementsProgress, need: 'optional', late: true },
} as const satisfies InputSpec;

@Injectable()
export class RequirementsStep extends BaseStep<typeof INPUTS> {
  readonly name: StepName = 'requirements';
  readonly inputs = INPUTS;
  readonly outputs = [ARTIFACTS.requirements, ARTIFACTS.pending, ARTIFACTS.requirementsProgress];
  override readonly capabilities: StepCapabilities = { prompt: true, projects: true };

  constructor(
    kernel: StepKernel,
    @Inject(ISSUE_TRACKER) private readonly tracker: IssueTracker,
    @Inject(REQUIREMENTS_SOURCE) private readonly source: RequirementsSource,
  ) {
    super(kernel);
  }

  async fetch(key: string): Promise<PipelineResult> {
    const prior = await this.runs.findRun(key);
    const prompt = prior?.prompt ?? undefined;
    const keys = new Set<string>([key]);
    const existing = parseRecord(await this.reader.reread(key, ARTIFACTS.requirements));
    for (const ticket of existing?.tickets ?? []) {
      if (ticket.key) {
        keys.add(ticket.key);
      }
    }
    return this.perform(key, async (ctx) => this.conclude(ctx, await this.produce(ctx, prompt, [...keys])));
  }

  override async execute(key: string, options: StepOptions = {}, snapshot?: StepSnapshot): Promise<PipelineResult> {
    let prompt: string | undefined;
    try {
      prompt = await readPrompt(options);
    } catch (error) {
      const message = error instanceof SwarmloopError ? error.message : 'prompt failed';
      return { exitCode: 1, message };
    }
    try {
      const resolved = prompt ?? (await this.runs.findRun(key))?.prompt ?? undefined;
      if (resolved === undefined) {
        return { exitCode: 1, message: 'prompt is missing' };
      }
      return await super.execute(key, { ...options, prompt: resolved }, snapshot);
    } catch (error) {
      return { exitCode: 1, message: this.failureText(error) };
    }
  }

  protected work(_input: StepInput<typeof INPUTS>, ctx: StepContext): Promise<StepResult> {
    const { prompt } = ctx.options;
    return this.produce(ctx, prompt, taskKeys(prompt ?? '', ctx.opened.run.key));
  }

  private async produce(ctx: StepContext, prompt: string | undefined, issueKeys: string[]): Promise<StepResult> {
    const { opened } = ctx;
    const key = opened.run.key;
    const effectivePrompt = prompt ?? opened.prior?.prompt ?? undefined;
    if (effectivePrompt !== undefined) {
      opened.run.prompt = effectivePrompt;
      try {
        await this.runs.saveRun(opened.run);
      } catch (error) {
        throw new VisitLeftOpen({ exitCode: 1, message: this.failureText(error) });
      }
    }
    const samples: SampleDraft[] = [sampleSelf(this.clock.iso())];
    const finish = (input: RequirementsFinish) => this.finish(ctx, samples, input);
    try {
      const unread = effectivePrompt ? unreadSource(effectivePrompt) : null;
      if (unread) {
        throw new SwarmloopError(unread);
      }
      const fetched = await this.collect(
        ctx,
        runDir(this.config, key),
        key,
        effectivePrompt,
        issueKeys,
        resuming(opened.prior),
      );
      const written = await this.source.write({
        key,
        runDir: runDir(this.config, key),
        bundle: fetched.bundle,
        bundles: fetched.bundles,
        prompt: effectivePrompt,
        issueKeys,
        agentCalls: opened.run.agentCalls,
        spentUsd: opened.run.spentUsd,
        tokensInRun: await this.visits.tokenTotal(opened.run.id),
      });
      samples.push(...written.samples, sampleSelf(this.clock.iso()));
      const stopped = stopReason(key, written);
      if (stopped) {
        return finish({ written, calls: fetched.httpCalls, ...stopped, exitCode: 1, body: null });
      }
      return finish({
        written,
        calls: fetched.httpCalls,
        outcome: 'ok',
        exitCode: 0,
        message: 'requirements done',
        body: written.body,
      });
    } catch (error) {
      samples.push(sampleSelf(this.clock.iso()));
      if (error instanceof PasteNeeded) {
        return finish({
          written: emptyWrite(),
          calls: error.httpCalls,
          outcome: 'waiting',
          exitCode: 0,
          message: error.message,
          body: `${JSON.stringify({ url: error.url })}\n`,
          artifact: ARTIFACTS.pending,
        });
      }
      return finish({
        written: emptyWrite(),
        calls: error instanceof FetchFailed ? error.httpCalls : [],
        outcome: 'failed',
        exitCode: 1,
        message: this.failureText(error),
        body: null,
      });
    }
  }

  private finish(ctx: StepContext, samples: SampleDraft[], input: RequirementsFinish): StepResult {
    ctx.opened.run.agentCalls += input.written.calls;
    ctx.opened.run.spentUsd += input.written.usd;
    return {
      route: routeOf(input),
      summary: `${ctx.opened.startedAt} ${input.message}`,
      outputs: requirementsOutputs(input),
      handoff: input.outcome === 'ok' ? `- ${input.message}\n` : undefined,
      visit: requirementsVisit(samples, input),
    };
  }

  private async collect(
    ctx: StepContext,
    runDir: string,
    key: string,
    prompt: string | undefined,
    issueKeys: string[],
    resume: boolean,
  ): Promise<{ bundle: IssueBundle; bundles: IssueBundle[]; httpCalls: HttpCallDraft[] }> {
    const progress = resume ? parseProgress(await ctx.reread(ARTIFACTS.requirementsProgress)) : { issues: {} };
    const bundles: IssueBundle[] = [];
    const httpCalls: HttpCallDraft[] = [];
    for (const issueKey of issueKeys) {
      const cached = progress.issues[issueKey];
      if (cached) {
        bundles.push(cached);
        continue;
      }
      const fetched = await this.tracker.fetch(issueKey, runDir);
      bundles.push(fetched.bundle);
      httpCalls.push(...fetched.httpCalls);
      progress.issues[issueKey] = fetched.bundle;
      await ctx.write(ARTIFACTS.requirementsProgress, `${JSON.stringify(progress)}\n`);
    }
    return {
      bundle: bundles[0] ?? promptBundle(key, prompt ?? ''),
      bundles,
      httpCalls,
    };
  }
}

function routeOf(input: RequirementsFinish): Route {
  switch (input.outcome) {
    case 'ok':
      return { to: 'next' };
    case 'waiting':
      return { to: 'wait', reason: input.message };
    case 'blocked':
      return { to: 'block', reason: input.message };
    case 'failed':
      return { to: 'fail', error: { code: 'requirements', message: input.message } };
  }
}

function resuming(prior: RunEntity | null): boolean {
  if (!prior || prior.currentStep !== 'requirements') {
    return false;
  }
  return prior.status === 'failed' || prior.status === 'running' || prior.status === 'waiting';
}

function parseProgress(body: string | null): { issues: Record<string, IssueBundle> } {
  if (!body) {
    return { issues: {} };
  }
  try {
    const parsed = JSON.parse(body) as { issues?: Record<string, IssueBundle> };
    return { issues: parsed.issues ?? {} };
  } catch {
    return { issues: {} };
  }
}

function parseRecord(body: string | null): { tickets?: { key?: string }[] } | null {
  if (!body) {
    return null;
  }
  try {
    return JSON.parse(body) as { tickets?: { key?: string }[] };
  } catch {
    return null;
  }
}

function promptBundle(key: string, prompt: string): IssueBundle {
  return {
    key,
    summary: prompt.trim().split('\n')[0]?.slice(0, 120) || 'Prompt',
    descriptionMarkdown: prompt,
    acceptanceCriteria: '',
    epic: null,
    comments: [],
    attachments: [],
    links: [],
    confluence: [],
    pages: [],
  };
}
