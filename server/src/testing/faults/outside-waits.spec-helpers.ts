import { mkdirSync, writeFileSync } from 'fs';
import { join } from 'path';
import { storeRun } from '../store-run.spec-helpers';
import { epicLoop } from '../epic-loop.spec-helpers';
import { agentFor } from '../../config/agents';
import { AppConfig } from '../../config/env';
import type { RunEntity } from '../../history/entities';
import { sessionFileName, sessionHome } from '../../history/session-group';
import { agentStateDir } from '../../sandbox/sandbox-launch';
import { RunRepository } from '../../history/run.repository';
import { CommandService } from '../../pipeline/command.service';
import type { createFlowHarness } from '../flow-harness';
import type { RunStateChange } from '../../history/run-state';
import { writeRunState } from '../../history/run-state';
import { PERSON_RESUME } from '../../pipeline/resume-sender';
import { Reconciler } from '../../pipeline/reconciler';
import { StartGate } from '../../pipeline/start-gate';
import { AgentDoor } from '../../steps/shared/agent-door';
import { credentialDatabase } from '../credential-database.spec-helpers';

export const MACHINE = { by: 'machine', level: null };

/** What the outside the reconciler asks of is answering: the sandbox, the disk and the person's connection. */
export interface Outside {
  docker: boolean;
  disk: boolean;
  connection: boolean;
}

/**
 * A reconciler over a real run store with the outside waits' stubs. The command store is a stub that answers a second
 * command under one key as replayed, as the real one does, so a second resume of one wait shows as a replay.
 */
export async function reconcilerWorld() {
  const fixture = await credentialDatabase();
  const accepted: unknown[][] = [];
  const keys = new Set<string>();
  const accept = async (...call: unknown[]) => {
    const key = (call[3] as { idempotencyKey: string }).idempotencyKey;
    if (keys.has(key)) return { replayed: true };
    keys.add(key);
    accepted.push(call);
    return { replayed: false };
  };
  const outside: Outside = { docker: false, disk: false, connection: false };
  const none = undefined as never;
  const door = new AgentDoor(none, fixture.runs, none, none, none, none, none, none, none);
  const reconciler = new Reconciler(
    fixture.runs,
    {} as never,
    { dockerAnswers: async () => outside.docker } as never,
    fixture.config,
    fixture.db.clock,
    { accept } as never,
    {} as never,
    fixture.cooldowns,
    {} as never,
    {} as never,
    { hasFreeSpace: async () => outside.disk } as never,
    {} as never,
    { listStats: async () => [] } as never,
    {} as never,
    {} as never,
    new StartGate({ accept } as never, {} as never, {} as never, door),
    { isHealthy: async () => outside.connection } as never,
    fixture.credentials,
  );
  /** A run that waits as a step leaves it, with the reason and its words. */
  const waiting = async (key: string, change: RunStateChange, startedBy: string | null = null) => {
    const run = await fixture.run(key, startedBy);
    writeRunState(run, { currentStep: 'implement', ...change });
    return storeRun(fixture.runs, run);
  };
  return { ...fixture, accepted, outside, reconciler, waiting };
}

/** The task has a plan chat to talk in, as a run whose plan step ran has: the planner of the run answers a question in it. */
function planChatOf(flow: Awaited<ReturnType<typeof createFlowHarness>>, run: RunEntity): void {
  const key = run.key;
  const { runtime } = agentFor(flow.app.app.get(AppConfig).env, run, 'plan');
  const file = join(flow.app.root, 'data', sessionFileName(key, 'plan'));
  mkdirSync(agentStateDir(flow.app.root, key, sessionHome('plan')), { recursive: true });
  writeFileSync(
    file,
    JSON.stringify({
      runtime,
      chatId: 'chat-plan',
      resultName: 'plan',
      resumed: true,
      completed: true,
      killReason: null,
    }),
  );
}

/**
 * An epic whose subtask `<key>-a` runs a scripted implement that ends every visit on the same need (on a sibling that
 * has merged), as epic-loop.spec-helpers.ts sets up for flow-loop.e2e.spec.ts: a machine start of that task is refused as the same input of its last
 * visit. The task has had its first visit when this returns.
 */
export async function loopingTask(flow: Awaited<ReturnType<typeof createFlowHarness>>, key: string) {
  const runs = flow.app.app.get(RunRepository);
  const loop = epicLoop(flow, key);
  await loop.seed();
  const visits = loop.fakeAgent();
  await flow.app.app.get(CommandService).submit('resume', loop.taskKey, { ...PERSON_RESUME });
  await loop.settle();
  planChatOf(flow, (await runs.findRun(loop.taskKey))!);
  return { taskKey: loop.taskKey, settle: loop.settle, visits, task: () => runs.findRun(loop.taskKey) };
}
