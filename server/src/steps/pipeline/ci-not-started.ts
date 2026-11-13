import type { EventRepository } from '../../history/event.repository';
import { CI_WAIT_COUNTER } from '../../history/loop-detail';
import { ERROR_CODES } from '../../contract/error-codes';
import { HostUnavailable } from '../../core/swarmloop-error';
import type { CodeHost, PipelineRef } from '../../integrations/code-host/code-host';
import type { StepContext } from '../base-step';
import { ARTIFACTS } from '../contract/artifacts';
import type { StepResult } from '../contract/step-contract';
import { mergeRequestDetails, parseMergeRequests } from '../merge-request/merge-request-record';
import { CI_INFRA_SOURCE, issueOf } from '../shared/handoff';
import { finish } from './pipeline-result';
import { report } from './pipeline-red';

/** How long after a look the next one happens. */
const CI_LOOK_MS = 2 * 60_000;
/** How long a commit has no run before the host is nudged, once. */
const CI_NUDGE_AFTER_MS = 10 * 60_000;
/** How long a commit has no run before a person is asked. */
const CI_GIVE_UP_AFTER_MS = 60 * 60_000;

/** What is known of one commit that has no CI run: when it was first seen so, and what was done about it. */
interface CiWait {
  source: string;
  since: string;
  nudge: string | null;
}

const minutes = (ms: number): number => Math.round(ms / 60_000);

function sourceOf(ref: PipelineRef): string {
  return `${ref.project}@${ref.sha ?? 'unknown'}`;
}

/** The links of the merge requests of the run, or a text that says there is none. */
async function linkOf(ctx: StepContext): Promise<string> {
  const stored = await ctx.reread(ARTIFACTS.mergeRequest);
  const links = mergeRequestDetails(stored ? parseMergeRequests(stored) : []);
  return links.length > 0 ? links.join(', ') : 'no merge request link';
}

/** Asks the host to start the pipeline of each commit not nudged yet. The outcome of each is kept for the person who is asked last. */
async function nudge(
  waits: CiWait[],
  refs: PipelineRef[],
  input: { ctx: StepContext; events: EventRepository; host: CodeHost },
): Promise<string[]> {
  const lines: string[] = [];
  for (const wait of waits.filter((item) => item.nudge === null)) {
    const ref = refs.find((item) => sourceOf(item) === wait.source)!;
    try {
      input.ctx.calls.push(...(await input.host.startPipeline(ref)).httpCalls);
      wait.nudge = `asked the host to start the pipeline of ${wait.source}`;
    } catch (error) {
      if (error instanceof HostUnavailable) throw error;
      const reason = error instanceof Error ? error.message : 'the request failed';
      wait.nudge = `asking the host to start the pipeline of ${wait.source} failed: ${reason}`;
    }
    lines.push(`nudge: ${wait.nudge}`);
    await input.events.recordLoop(input.ctx.opened.run, CI_WAIT_COUNTER, 1, `CI did not start: ${wait.nudge}`);
  }
  return lines;
}

/**
 * A commit with no CI run and no conflict or closed request to explain it is waited for, never failed: the host
 * sometimes delivers the event that starts CI late or not at all. Each look runs again after `CI_LOOK_MS`. After
 * `CI_NUDGE_AFTER_MS` the host is nudged once per commit, and after `CI_GIVE_UP_AFTER_MS` a person is asked.
 */
export async function waitForCi(input: {
  ctx: StepContext;
  events: EventRepository;
  host: CodeHost;
  refs: PipelineRef[];
  notes: string[];
}): Promise<StepResult> {
  const { ctx, refs } = input;
  const stored = JSON.parse((await ctx.reread(ARTIFACTS.ciWaits)) ?? '[]') as CiWait[];
  const now = ctx.clock.now();
  const waits = refs.map(
    (ref) =>
      stored.find((item) => item.source === sourceOf(ref)) ?? {
        source: sourceOf(ref),
        since: ctx.clock.iso(),
        nudge: null,
      },
  );
  const waited = now - Math.min(...waits.map((item) => Date.parse(item.since)));
  const commits = refs.map((ref) => ref.sha ?? 'unknown').join(', ');
  const lines = [
    ...input.notes,
    `waited: ${minutes(waited)} minutes; the host has not started CI and no conflict or closed request explains it`,
  ];
  if (waited >= CI_NUDGE_AFTER_MS) lines.push(...(await nudge(waits, refs, input)));
  const others = stored.filter((item) => !waits.some((wait) => wait.source === item.source));
  const giveUp = waited >= CI_GIVE_UP_AFTER_MS;
  // A person's Resume after the give-up starts a new wait and a new nudge, so the record is dropped with it.
  await ctx.write(ARTIFACTS.ciWaits, JSON.stringify(giveUp ? others : [...others, ...waits]));
  if (giveUp) {
    const tried = waits.map((item) => item.nudge).filter(Boolean);
    const body = [
      `${ERROR_CODES.CI_NOT_RUN}: CI did not start for ${commits} in ${minutes(waited)} minutes`,
      ...lines,
      `commit: ${commits}`,
      `link: ${await linkOf(ctx)}`,
      `tried: looked again every ${minutes(CI_LOOK_MS)} minutes for ${minutes(waited)} minutes${tried.length > 0 ? `; ${tried.join('; ')}` : ''}`,
    ].join('\n');
    const result = finish('blocked', report(ctx.opened, 'CI did not run', `${body}\n`), 'blocked', `${body}\n`);
    return {
      ...result,
      outputs: [
        ...result.outputs,
        { artifact: ARTIFACTS.issues, value: [issueOf(CI_INFRA_SOURCE, ERROR_CODES.CI_NOT_RUN, body)] },
      ],
    };
  }
  const retryAt = new Date(now + CI_LOOK_MS).toISOString();
  const text = `CI has not started for ${commits}; next look at ${retryAt}`;
  return {
    route: { to: 'wait', reason: text, code: ERROR_CODES.CI_NOT_STARTED, retryAt },
    summary: report(ctx.opened, text),
    outputs: [{ artifact: ARTIFACTS.pipelineLog, value: `result: waiting\n${text}\n${lines.join('\n')}\n` }],
    visit: { status: 'waiting' },
  };
}
