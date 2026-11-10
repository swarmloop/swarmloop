import { roleOf } from '../config/agents';
import { BadRequestException, NotFoundException } from '@nestjs/common';
import type { SwarmloopEnv } from '../config/env';
import type { FlowItem, FlowView, StepView } from '../contract/api';
import { pipelineStepOf } from '../contract/steps';
import type { CommandRepository } from '../history/command.repository';
import type { DocumentEntity, RunEntity } from '../history/entities';
import type { StepEventLog } from '../history/step-event.log';
import type { StepRegistry } from '../steps/step.registry';
import type { RunRepository } from '../history/run.repository';
import { resumeState, stateView } from './run-view/flow';

export async function requireRun(runs: RunRepository, key: string): Promise<RunEntity> {
  const run = await runs.findRun(key);
  if (!run) {
    throw new NotFoundException(`${key} is missing`);
  }
  return run;
}

function count(value: string | undefined, name: string): number | undefined {
  if (value === undefined) {
    return undefined;
  }
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 0) {
    throw new BadRequestException(`${name} is not a count`);
  }
  return parsed;
}

/** The paging of the events route, from its query strings. */
export function eventPaging(query: { step?: string; after?: string; limit?: string }): {
  step?: string;
  after?: number;
  limit?: number;
} {
  return { step: query.step, after: count(query.after, 'after'), limit: count(query.limit, 'limit') };
}

/** What a step is, and how far the events of the run go. A reviewer is a part of `code-review`; `done` has no entry. */
export async function stepMeta(
  registry: StepRegistry,
  log: StepEventLog,
  env: SwarmloopEnv,
  run: RunEntity,
  name: string,
): Promise<Pick<StepView, 'descriptor' | 'eventsCursor'>> {
  const step = pipelineStepOf(name);
  const found = registry.describe(env).find((entry) => entry.name === step);
  return {
    descriptor: found
      ? {
          name: found.name,
          kind: found.kind,
          agent: found.agent && { ...found.agent, ...roleOf(run, name) },
          reviewers: found.reviewers,
        }
      : { name: step, kind: 'server' },
    eventsCursor: await log.lastSeq(run.id),
  };
}

/** The resume answer, the honest state and what the server allows in it, with the revision they were read at. */
export async function runState(
  commands: CommandRepository,
  run: RunEntity,
  open: FlowItem[],
  documents: DocumentEntity[],
): Promise<Pick<FlowView, 'resume' | 'state' | 'stateReason' | 'actions' | 'revision'>> {
  const pending = await commands.pending(run.id);
  const { state, reason, actions } = stateView(run, open, documents, {
    stopping: pending.some((command) => command.type === 'stop'),
    queued: pending.some((command) => command.state === 'accepted' && command.type !== 'stop'),
  });
  return { resume: resumeState(run, open, documents), state, stateReason: reason, actions, revision: run.revision };
}
