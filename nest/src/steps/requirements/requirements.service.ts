import { Inject, Injectable } from '@nestjs/common';
import { HistoryService } from '../../history/history.service';
import { RunEntity } from '../../history/entities';
import { SampleDraft, sampleSelf } from '../../history/visit';
import { FetchFailed, HttpCallDraft, SwarmloopError, PasteNeeded } from '../../swarmloop-error';
import { PipelineResult, StepName, StepOptions } from '../../pipeline/pipeline-result';
import { IssueBundle } from '../../integrations/issue-tracker/issue-bundle';
import { IssueTracker } from '../../integrations/issue-tracker/issue-tracker';
import { REQUIREMENTS_SOURCE } from '../../integrations/requirements-source/requirements-source.module';
import { RequirementsSource } from '../../integrations/requirements-source/requirements-source';
import { ISSUE_TRACKER } from '../../providers/tokens';
import { BaseStep, StepContext } from '../base-step';
import { readPrompt, taskKeys, unreadSource } from './requirements-input';
import { emptyWrite, RequirementsFinish, requirementsVisit, stopReason } from './requirements-visit';

@Injectable()
export class RequirementsService extends BaseStep {
  readonly name: StepName = 'requirements';
  readonly requiredKind = 'requirements';

  constructor(
    history: HistoryService,
    @Inject(ISSUE_TRACKER) private readonly tracker: IssueTracker,
    @Inject(REQUIREMENTS_SOURCE) private readonly source: RequirementsSource,
  ) {
    super(history);
  }

  async fetch(key: string): Promise<PipelineResult> {
    const prior = await this.history.findRun(key);
    const prompt = prior?.prompt ?? undefined;
    const keys = new Set<string>([key]);
    const existing = parseRecord(await this.history.latestBody(key, 'requirements'));
    for (const ticket of existing?.tickets ?? []) {
      if (ticket.key) {
        keys.add(ticket.key);
      }
    }
    return this.perform(key, (ctx) => this.produce(ctx, prompt, [...keys]));
  }

  async missingInput(): Promise<string | null> {
    return null;
  }

  async execute(key: string, options: StepOptions = {}): Promise<PipelineResult> {
    let prompt: string | undefined;
    try {
      prompt = await readPrompt(options);
    } catch (error) {
      const message = error instanceof SwarmloopError ? error.message : 'prompt failed';
      return { exitCode: 1, message };
    }
    try {
      const resolved = prompt ?? (await this.history.findRun(key))?.prompt ?? undefined;
      if (resolved === undefined) {
        return { exitCode: 1, message: 'prompt is missing' };
      }
      return await super.execute(key, { ...options, prompt: resolved });
    } catch (error) {
      return { exitCode: 1, message: this.failureText(error) };
    }
  }

  protected run(key: string, options: StepOptions, ctx: StepContext): Promise<PipelineResult> {
    return this.produce(ctx, options.prompt, taskKeys(options.prompt ?? '', key));
  }

  private async produce(ctx: StepContext, prompt: string | undefined, issueKeys: string[]): Promise<PipelineResult> {
    const { opened } = ctx;
    const key = opened.run.key;
    const effectivePrompt = prompt ?? opened.prior?.prompt ?? undefined;
    if (effectivePrompt !== undefined) {
      opened.run.prompt = effectivePrompt;
      try {
        await this.history.saveRun(opened.run);
      } catch (error) {
        return { exitCode: 1, message: this.failureText(error) };
      }
    }
    const samples: SampleDraft[] = [sampleSelf()];
    const finish = (input: RequirementsFinish) => this.finish(ctx, samples, input);
    try {
      const unread = effectivePrompt ? unreadSource(effectivePrompt) : null;
      if (unread) {
        throw new SwarmloopError(unread);
      }
      const fetched = await this.collect(
        this.history.runDir(key),
        key,
        effectivePrompt,
        issueKeys,
        opened.run,
        resuming(opened.prior),
      );
      const written = await this.source.write({
        key,
        runDir: this.history.runDir(key),
        bundle: fetched.bundle,
        bundles: fetched.bundles,
        prompt: effectivePrompt,
        issueKeys,
        agentCalls: opened.run.agentCalls,
        spentUsd: opened.run.spentUsd,
        tokensInRun: await this.history.tokenTotal(opened.run.id),
      });
      samples.push(...written.samples, sampleSelf());
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
      samples.push(sampleSelf());
      if (error instanceof PasteNeeded) {
        return finish({
          written: emptyWrite(),
          calls: error.httpCalls,
          outcome: 'waiting',
          exitCode: 0,
          message: error.message,
          body: `${JSON.stringify({ url: error.url })}\n`,
          kind: 'pending',
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

  private finish(ctx: StepContext, samples: SampleDraft[], input: RequirementsFinish): Promise<PipelineResult> {
    ctx.opened.run.agentCalls += input.written.calls;
    ctx.opened.run.spentUsd += input.written.usd;
    return ctx.end({
      outcome: input.outcome,
      exitCode: input.exitCode,
      line: `${ctx.opened.startedAt} ${input.message}`,
      handoff: input.outcome === 'ok' ? `- ${input.message}\n` : undefined,
      visit: requirementsVisit(samples, input),
    });
  }

  private async collect(
    runDir: string,
    key: string,
    prompt: string | undefined,
    issueKeys: string[],
    run: RunEntity,
    resume: boolean,
  ): Promise<{ bundle: IssueBundle; bundles: IssueBundle[]; httpCalls: HttpCallDraft[] }> {
    const progress = resume ? parseProgress(await this.history.latestBody(key, 'requirements_progress')) : { issues: {} };
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
      await this.history.putDocument(run, 'requirements_progress', `${JSON.stringify(progress)}\n`);
    }
    return {
      bundle: bundles[0] ?? promptBundle(key, prompt ?? ''),
      bundles,
      httpCalls,
    };
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
