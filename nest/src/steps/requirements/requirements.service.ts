import { Inject, Injectable } from '@nestjs/common';
import { existsSync } from 'fs';
import { readFile } from 'fs/promises';
import { HistoryService } from '../../history/history.service';
import { sampleSelf, SampleDraft, VisitDraft } from '../../history/visit';
import { RunEntity } from '../../history/entities';
import { KillReason } from '../../limits/limits';
import { FetchFailed, HttpCallDraft, SwarmloopError, PasteNeeded } from '../../swarmloop-error';
import { PipelineResult, StepOptions } from '../../pipeline/pipeline-result';
import { closeStep, OpenedStep, openStep } from '../../pipeline/step-run';
import { IssueBundle } from '../../integrations/issue-tracker/issue-bundle';
import { IssueTracker } from '../../integrations/issue-tracker/issue-tracker';
import { RequirementsSource, RequirementsWrite } from '../../providers/contracts';
import { ISSUE_TRACKER, REQUIREMENTS_SOURCE } from '../../providers/tokens';
import { recordHandoff } from '../model-step';

@Injectable()
export class RequirementsService {
  constructor(
    private readonly history: HistoryService,
    @Inject(ISSUE_TRACKER) private readonly tracker: IssueTracker,
    @Inject(REQUIREMENTS_SOURCE) private readonly source: RequirementsSource,
  ) {}

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
    return this.produce(key, prompt, [...keys]);
  }

  async execute(key: string, options: StepOptions = {}): Promise<PipelineResult> {
    let prompt: string | undefined;
    try {
      prompt = await readPrompt(options);
    } catch (error) {
      const message = error instanceof SwarmloopError ? error.message : 'prompt failed';
      return { exitCode: 1, message };
    }
    if (prompt === undefined) {
      prompt = (await this.history.findRun(key))?.prompt ?? undefined;
    }
    if (prompt === undefined) {
      return { exitCode: 1, message: 'prompt is missing' };
    }
    return this.produce(key, prompt, taskKeys(prompt, key));
  }

  private async produce(key: string, prompt: string | undefined, issueKeys: string[]): Promise<PipelineResult> {
    const opened = await openStep(this.history, key, 'requirements');
    const effectivePrompt = prompt ?? opened.prior?.prompt ?? undefined;
    if (effectivePrompt !== undefined) {
      opened.run.prompt = effectivePrompt;
      await this.history.saveRun(opened.run);
    }
    const samples: SampleDraft[] = [sampleSelf()];
    const finish = (input: RequirementsFinish) => this.finish(opened, samples, input);
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
        visitStatus: 'done',
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
          visitStatus: 'waiting',
          exitCode: 0,
          message: error.message,
          body: `${JSON.stringify({ url: error.url })}\n`,
          kind: 'pending',
        });
      }
      const message = error instanceof SwarmloopError ? error.message : 'requirements failed';
      return finish({
        written: emptyWrite(),
        calls: error instanceof FetchFailed ? error.httpCalls : [],
        outcome: 'failed',
        visitStatus: 'failed',
        exitCode: 1,
        message,
        body: null,
      });
    }
  }

  private async finish(opened: OpenedStep, samples: SampleDraft[], input: RequirementsFinish) {
    opened.run.agentCalls += input.written.calls;
    opened.run.spentUsd += input.written.usd;
    const visit = requirementsVisit(opened, samples, input);
    if (input.outcome === 'ok') {
      const note = await recordHandoff(this.history, opened.run.key, 'requirements', `- ${input.message}\n`);
      const primary = visit.document;
      visit.document = null;
      visit.documents = [...(primary ? [primary] : []), note];
    }
    return closeStep({
      history: this.history,
      run: opened.run,
      previousStep: opened.previousStep,
      previousStatus: opened.previousStatus,
      step: 'requirements',
      outcome: input.outcome,
      visit,
      line: `${opened.startedAt} ${input.message}`,
      exitCode: input.exitCode,
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

interface RequirementsFinish {
  written: RequirementsWrite;
  calls: HttpCallDraft[];
  outcome: 'ok' | 'failed' | 'blocked' | 'waiting';
  visitStatus: string;
  exitCode: number;
  message: string;
  body: string | null;
  kind?: string;
}

function requirementsVisit(opened: OpenedStep, samples: SampleDraft[], input: RequirementsFinish): VisitDraft {
  return {
    step: 'requirements',
    model: input.written.exchange?.model ?? null,
    mode: input.written.exchange ? 'agent' : null,
    startedAt: opened.startedAt,
    finishedAt: new Date().toISOString(),
    durationMs: Date.now() - opened.started,
    status: input.visitStatus,
    exitCode: input.exitCode,
    killReason: input.written.killReason,
    tokensIn: input.written.tokensIn,
    tokensOut: input.written.tokensOut,
    usd: input.written.usd,
    samples,
    exchange: input.written.exchange,
    httpCalls: input.calls,
    document: input.body ? { kind: input.kind ?? 'requirements', fileName: '', body: input.body } : null,
    resumed: input.written.resumed,
  };
}

function resuming(prior: RunEntity | null): boolean {
  if (!prior || prior.currentStep !== 'requirements') {
    return false;
  }
  return prior.status === 'failed' || prior.status === 'running' || prior.status === 'waiting';
}

function stopReason(
  key: string,
  written: RequirementsWrite,
): Pick<RequirementsFinish, 'outcome' | 'visitStatus' | 'message'> | null {
  if (ceiling(written.killReason)) {
    return { outcome: 'blocked', visitStatus: 'blocked', message: `${key} blocked: ${written.killReason}` };
  }
  if (written.killReason === 'time' || written.killReason === 'idle') {
    return { outcome: 'failed', visitStatus: 'failed', message: `${key} requirements killed: ${written.killReason}` };
  }
  if (!written.body.trim()) {
    return { outcome: 'failed', visitStatus: 'failed', message: 'requirements record is empty' };
  }
  return null;
}


function emptyWrite(): RequirementsWrite {
  return {
    body: '',
    calls: 0,
    usd: 0,
    tokensIn: 0,
    tokensOut: 0,
    exchange: null,
    killReason: null,
    samples: [],
    resumed: false,
  };
}

const JIRA_KEY = /[A-Z][A-Z0-9]+-\d+/g;
const JIRA_KEY_EXACT = /^[A-Z][A-Z0-9]+-\d+$/;

export function taskKeys(prompt: string, runId: string): string[] {
  const found = new Set<string>();
  if (JIRA_KEY_EXACT.test(runId)) {
    found.add(runId);
  }
  for (const match of prompt.matchAll(JIRA_KEY)) {
    found.add(match[0]);
  }
  return [...found];
}

function unreadSource(prompt: string): string | null {
  if (/https?:\/\/\S*slack\.com/i.test(prompt)) {
    return 'slack is not readable';
  }
  if (/https?:\/\/\S*teams\.microsoft\.com/i.test(prompt)) {
    return 'teams is not readable';
  }
  return null;
}

function ceiling(reason: KillReason | null): boolean {
  return reason === 'usd' || reason === 'tokens' || reason === 'calls';
}

async function readPrompt(options: StepOptions): Promise<string | undefined> {
  if (options.prompt !== undefined && options.promptFile !== undefined) {
    throw new SwarmloopError('prompt and prompt-file are both set');
  }
  if (options.prompt === undefined && options.promptFile === undefined) {
    return undefined;
  }
  const text = options.promptFile !== undefined ? await readPromptFile(options.promptFile) : options.prompt ?? '';
  if (!text.trim()) {
    throw new SwarmloopError('prompt is empty');
  }
  return text.endsWith('\n') ? text : `${text}\n`;
}

async function readPromptFile(path: string): Promise<string> {
  if (!existsSync(path)) {
    throw new SwarmloopError('prompt file is missing');
  }
  return readFile(path, 'utf8');
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
