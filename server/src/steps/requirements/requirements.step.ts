import { Inject, Injectable } from '@nestjs/common';
import type { StepCapabilities } from '../contract/step-contract';
import { StepKernel } from '../step-kernel';
import { runDir } from '../../history/run-paths';
import { RunEntity } from '../../history/entities';
import { SampleDraft, sampleSelf } from '../../history/visit';
import {
  FetchFailed,
  HostUnavailable,
  HttpCallDraft,
  IssueNotFound,
  SwarmloopError,
  PasteNeeded,
} from '../../core/swarmloop-error';
import { PipelineResult, StepOptions } from '../../core/pipeline-result';
import { ERROR_CODES } from '../../contract/error-codes';
import type { ErrorCode } from '../../contract/error-codes';
import { waitingEnd } from '../step-error-end';
import { StepName } from '../../contract/steps';
import { IssueBundle } from '../../integrations/issue-tracker/issue-bundle';
import { IssueTracker, runKeys } from '../../integrations/issue-tracker/issue-tracker';
import { REQUIREMENTS_SOURCE } from '../../integrations/requirements-source/requirements-source.module';
import { RequirementsSource } from '../../integrations/requirements-source/requirements-source';
import { ISSUE_TRACKER } from '../../integrations/issue-tracker/tokens';
import { BaseStep, StepContext, VisitLeftOpen } from '../base-step';
import type { StepSnapshot } from '../step';
import { isSubtask } from '../../contract/subtask';
import { readPrompt, unreadSource } from './requirements-input';
import {
  emptyWrite,
  RequirementsFinish,
  requirementsOutputs,
  requirementsVisit,
  stopReason,
} from './requirements-visit';
import { assertRepoAllowed, storedProjects } from '../../config/checkout-path';
import { RemoteRepositories } from '../prepare/remote-repositories.service';
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
    private readonly remote: RemoteRepositories,
  ) {
    super(kernel);
  }

  async fetch(key: string): Promise<PipelineResult> {
    const prior = await this.runs.findRun(key);
    const prompt = prior?.prompt ?? undefined;
    const keys = new Set<string>();
    // A subtask takes its requirements from its prompt only, whatever the parent used.
    if (!prior || !isSubtask(prior)) {
      keys.add(key);
      const existing = parseRecord(await this.reader.reread(key, ARTIFACTS.requirements));
      for (const ticket of existing?.tickets ?? []) {
        if (ticket.key) {
          keys.add(ticket.key);
        }
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

  protected async work(_input: StepInput<typeof INPUTS>, ctx: StepContext): Promise<StepResult> {
    const { prompt } = ctx.options;
    const { run } = ctx.opened;
    const keys = !isSubtask(run) ? await runKeys(this.tracker, run.key, prompt ?? '') : [];
    return this.produce(ctx, prompt, keys);
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
      for (const name of storedProjects(opened.run.projects)) {
        assertRepoAllowed(this.config.env.SWARMLOOP_REPOS, name);
      }
      for (const name of storedProjects(opened.run.projects)) {
        if (!this.remote.hasFolder(name)) {
          await ctx.activity(
            `Clone ${name}`,
            () => this.remote.clone(name, opened.run.startedBy),
            () => 'cloned',
          );
        }
      }
      const fetched = await this.collect(
        ctx,
        runDir(this.config, key),
        key,
        effectivePrompt,
        issueKeys,
        resuming(opened.prior),
      );
      const loadedKeys = issueKeys.filter((issueKey) => !fetched.missing.includes(issueKey));
      const written = await this.source.write({
        key,
        runDir: runDir(this.config, key),
        bundle: fetched.bundle,
        bundles: fetched.bundles,
        prompt: effectivePrompt,
        issueKeys: loadedKeys,
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
        notes: fetched.missing.map((issueKey) => `${issueKey} was not found in Jira`),
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
      const waiting = waitingEnd(error, this.clock, this.config.env);
      if (waiting) {
        return finish({
          written: emptyWrite(),
          calls: error instanceof HostUnavailable ? error.httpCalls : [],
          outcome: 'waiting',
          exitCode: 0,
          message: waiting.message,
          code: waiting.code as ErrorCode,
          retryAt: waiting.retryAt,
          body: null,
        });
      }
      if (error instanceof SwarmloopError && error.code === ERROR_CODES.INPUT_MISSING) {
        return finish({
          written: emptyWrite(),
          calls: [],
          outcome: 'blocked',
          code: error.code,
          exitCode: 1,
          message: error.message,
          body: null,
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
      handoff:
        input.outcome === 'ok'
          ? [input.message, ...(input.notes ?? [])].map((line) => `- ${line}\n`).join('')
          : undefined,
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
  ): Promise<{ bundle: IssueBundle; bundles: IssueBundle[]; httpCalls: HttpCallDraft[]; missing: string[] }> {
    const progress = resume ? parseProgress(await ctx.reread(ARTIFACTS.requirementsProgress)) : { issues: {} };
    const bundles: IssueBundle[] = [];
    const httpCalls: HttpCallDraft[] = [];
    const missing: string[] = [];
    for (const issueKey of issueKeys) {
      const cached = progress.issues[issueKey];
      if (cached) {
        bundles.push(cached);
        continue;
      }
      let fetched: Awaited<ReturnType<IssueTracker['fetch']>>;
      try {
        fetched = await this.tracker.fetch(issueKey, runDir);
      } catch (error) {
        if (error instanceof IssueNotFound) {
          httpCalls.push(...error.httpCalls);
          missing.push(issueKey);
          continue;
        }
        throw error;
      }
      bundles.push(fetched.bundle);
      httpCalls.push(...fetched.httpCalls);
      progress.issues[issueKey] = fetched.bundle;
      await ctx.write(ARTIFACTS.requirementsProgress, `${JSON.stringify(progress)}\n`);
    }
    return {
      bundle: bundles[0] ?? promptBundle(key, prompt ?? ''),
      bundles,
      httpCalls,
      missing,
    };
  }
}

function routeOf(input: RequirementsFinish): Route {
  switch (input.outcome) {
    case 'ok':
      return { to: 'next' };
    case 'waiting':
      return { to: 'wait', reason: input.message, code: input.code, retryAt: input.retryAt };
    case 'blocked':
      return { to: 'block', reason: input.message, code: input.code };
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
