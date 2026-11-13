import type { DocumentRepository } from '../../history/document.repository';
import type { FlakyTestRepository } from '../../history/flaky-test.repository';
import type { CodeHost, PipelineRef } from '../../integrations/code-host/code-host';
import { git } from '../../git/git';
import { checkedRepoNames, worktreePath } from '../../git/repo-names';
import type { StepContext } from '../base-step';
import type { StepResult } from '../contract/step-contract';
import { ARTIFACTS } from '../contract/artifacts';
import {
  parseMergeRequestSummaries,
  parseMergeRequests,
  renderMergeRequest,
} from '../merge-request/merge-request-record';
import { flakyBlock, mainRef } from './pipeline-red';
import { originProject, parsePipelineRefs, type Seen } from './pipeline-report';

interface FlakyDeps {
  documents: DocumentRepository;
  flaky: FlakyTestRepository;
  root: string;
}

interface FailedJob {
  project: string;
  job: string;
  text: string;
}

/** The `project:` blocks of a failed log that name a job, each with its own text. */
function failedJobs(log: string): FailedJob[] {
  const lines = log.split('\n');
  const starts = lines.flatMap((line, index) =>
    line.startsWith('project: ') && lines[index + 1]?.startsWith('pipeline: ') ? [index] : [],
  );
  return starts.flatMap((start, at) => {
    const block = lines.slice(start, starts[at + 1] ?? lines.length);
    const job = block.find((line) => line.startsWith('job: '));
    return job
      ? [
          {
            project: block[0].slice('project: '.length).trim(),
            job: job.slice('job: '.length).trim(),
            text: block.join('\n'),
          },
        ]
      : [];
  });
}

function flakyTests(document: string | null): string[] {
  return (document ?? '')
    .split('\n')
    .filter((line) => line.startsWith('flaky: '))
    .map((line) => line.slice('flaky: '.length).trim());
}

/** The code is the same when the sha is the same, or when the commits between differ only in files the failed log names. */
async function sameCode(
  deps: FlakyDeps,
  ctx: StepContext,
  job: FailedJob,
  failedSha: string,
  passedSha: string,
): Promise<boolean> {
  if (failedSha === passedSha) {
    return true;
  }
  const lines = await ctx.reread(ARTIFACTS.repos);
  if (!lines || lines.length === 0) {
    return false;
  }
  let names: string[];
  try {
    names = checkedRepoNames(lines);
  } catch {
    return false;
  }
  let matched = false;
  for (const name of names) {
    const cwd = worktreePath(deps.root, ctx.opened.run.key, name);
    if ((await originProject(cwd)) !== job.project) {
      continue;
    }
    try {
      const changed = (await git(['-C', cwd, 'diff', '--name-only', failedSha, passedSha])).split('\n').filter(Boolean);
      if (!changed.every((path) => job.text.includes(path))) {
        return false;
      }
      matched = true;
    } catch {
      return false;
    }
  }
  return matched;
}

async function updateMergeRequests(ctx: StepContext, host: CodeHost, tests: string[]): Promise<void> {
  const body = await ctx.reread(ARTIFACTS.mergeRequest);
  if (!body) {
    return;
  }
  const summaries = parseMergeRequestSummaries(body);
  const lines = tests.map((test) => `flaky: ${test}`).join('\n');
  const updated = parseMergeRequests(body).map((record, index) => ({
    ...record,
    summary: summaries[index] ? `${summaries[index]}\n\n${lines}` : lines,
  }));
  // The host description is replaced whole, so a record with no stored prose is not sent: it would lose the real text.
  for (const record of updated.filter((_, index) => summaries[index])) {
    ctx.calls.push(...(await host.updateMergeRequest(record.project, record.iid, record.summary)).httpCalls);
  }
  await ctx.write(ARTIFACTS.mergeRequest, renderMergeRequest(updated));
}

/**
 * A pass after a failed log: a job that failed there and passes now on the same code is flaky.
 * It is stored, shown on the run and in the merge request, and blocks when its test already blocks.
 * Returns null when the run goes on.
 */
export async function flakyOnPass(
  deps: FlakyDeps,
  ctx: StepContext,
  records: PipelineRef[],
  seen: Seen[],
  host: CodeHost,
): Promise<StepResult | null> {
  const { opened } = ctx;
  const failedId = (await deps.documents.latestIds(opened.run.id, [ARTIFACTS.pipelineLog.kind])).get(
    ARTIFACTS.pipelineLog.kind,
  );
  const failedBody =
    failedId === undefined
      ? null
      : await deps.documents.bodyBefore(opened.run.key, ARTIFACTS.pipelineLog.kind, failedId + 1);
  if (failedId === undefined || !failedBody?.split('\n').some((line) => line.trim() === 'result: fail')) {
    return null;
  }
  const failed = { id: failedId, body: failedBody };
  const refBody = await deps.documents.bodyBefore(opened.run.key, ARTIFACTS.pipelineRef.kind, failed.id);
  const earlier = parsePipelineRefs(refBody ?? '');
  const known = flakyTests(await ctx.reread(ARTIFACTS.flaky));
  const found: FailedJob[] = [];
  for (const item of failedJobs(failed.body)) {
    const passing = seen
      .find((entry) => entry.project === item.project)
      ?.jobs.find((entry) => entry.name === item.job && entry.status === 'success');
    const failedSha = earlier.find((ref) => ref.project === item.project)?.sha;
    const current = records.find((ref) => ref.project === item.project);
    if (!passing || !failedSha || !current?.sha || [...known, ...found.map((entry) => entry.job)].includes(item.job)) {
      continue;
    }
    if (!(await sameCode(deps, ctx, item, failedSha, current.sha))) {
      continue;
    }
    const passed = await host.readJobTrace(item.project, passing.id);
    ctx.calls.push(...passed.httpCalls);
    await deps.flaky.record({
      runId: opened.run.key,
      project: item.project,
      test: item.job,
      ref: current.ref,
      seed: /seed[=: ]+(\d+)/i.exec(item.text)?.[1] ?? '',
      failedLog: item.text,
      passedLog: passed.trace,
      createdAt: ctx.clock.iso(),
    });
    found.push(item);
  }
  if (found.length === 0) {
    return null;
  }
  const tests = [...known, ...found.map((entry) => entry.job)];
  await ctx.write(ARTIFACTS.flaky, tests.map((test) => `flaky: ${test}`).join('\n'));
  await updateMergeRequests(ctx, host, tests);
  for (const { project, job } of found) {
    if (await deps.flaky.blocks(project, job, mainRef(opened.run.prompt))) {
      return flakyBlock(opened, job);
    }
  }
  return null;
}
