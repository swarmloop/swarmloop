import { mkdirSync, writeFileSync } from 'fs';
import { join } from 'path';
import { storeRun } from '../store-run.spec-helpers';
import { agentFor } from '../../config/agents';
import { AppConfig } from '../../config/env';
import { ERROR_CODES } from '../../contract/error-codes';
import type { Subtask } from '../../contract/subtask';
import type { StepName } from '../../contract/steps';
import type { StepOptions } from '../../core/pipeline-result';
import { AgentCallRepository } from '../../history/agent-call.repository';
import { DocumentRepository } from '../../history/document.repository';
import type { RunEntity } from '../../history/entities';
import { sessionFileName, sessionHome } from '../../history/session-group';
import { agentStateDir } from '../../sandbox/sandbox-launch';
import { RunRepository } from '../../history/run.repository';
import { CommandService } from '../../pipeline/command.service';
import { PipelineService } from '../../pipeline/pipeline.service';
import { installScripts } from '../../pipeline/run-driver.spec-helpers';
import { renderMergeRequest } from '../../steps/merge-request/merge-request-record';
import { ARTIFACTS } from '../../steps/contract/artifacts';
import { renderNeeds } from '../../steps/shared/needs';
import type { Step, StepSnapshot } from '../../steps/step';
import { StepRegistry } from '../../steps/step.registry';
import type { createFlowHarness } from '../flow-harness';
import { loggedCall, save } from '../runs.spec-helpers';
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

const REQUIREMENTS = (key: string) =>
  `${JSON.stringify({
    prompt: 'Ship the field\n',
    tickets: [{ key, summary: 'Ship the field' }],
    plan: { name: 'plan', overview: '', items: ['do it'], decision: 'approve' },
  })}\n`;

const task = (id: string): Subtask => ({
  id,
  title: `Task ${id}`,
  description: `Do ${id}.`,
  depends: [],
  files: [`src/${id}.ts`],
  proof: `${id}.spec.ts`,
  status: 'waiting',
});

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
 * has merged), as flow-loop.e2e.spec.ts does: a machine start of that task is refused as the same input of its last
 * visit. The task has had its first visit when this returns.
 */
export async function loopingTask(flow: Awaited<ReturnType<typeof createFlowHarness>>, key: string) {
  const runs = flow.app.app.get(RunRepository);
  const documents = flow.app.app.get(DocumentRepository);
  const taskKey = `${key}-a`;
  const requirements = REQUIREMENTS(key);
  const settle = async () => {
    for (let round = 0; round < 4; round++) {
      await flow.app.app.get(CommandService).idle();
      await flow.app.pipeline.whenIdle(key);
      await flow.app.pipeline.whenIdle(taskKey);
    }
  };

  const parent = await save(runs, key, 'implement', 'waiting');
  parent.split = true;
  parent.projects = 'demo\n';
  await storeRun(runs, parent);
  await documents.putDocument(parent, 'requirements', requirements);
  await documents.putDocument(parent, 'repos', 'demo\n');
  await documents.putDocument(parent, 'subtasks', `${JSON.stringify([task('a'), task('b')])}\n`);
  await flow.app.pipeline.step('implement', key);
  await flow.app.app.get(CommandService).idle();
  const merged = (await runs.findRun(`${key}-b`))!;
  await documents.putDocument(merged, 'requirements', requirements);
  await documents.putDocument(merged, 'repos', 'demo\n');
  const record = { project: 'demo', iid: 1, url: 'https://code.example/demo/1', draft: false, summary: 'adds it' };
  await documents.putDocument(merged, 'merge_request', renderMergeRequest([record]));
  writeRunState(merged, { status: 'done', currentStep: 'done' });
  await storeRun(runs, merged);
  await flow.app.pipeline.step('implement', key);
  await flow.app.app.get(CommandService).idle();
  const waiting = (await runs.findRun(taskKey))!;
  await documents.putDocument(waiting, 'requirements', requirements);
  await documents.putDocument(waiting, 'repos', 'demo\n');
  writeRunState(waiting, { status: 'waiting', currentStep: 'implement' });
  await storeRun(runs, waiting);
  mkdirSync(join(flow.app.root, 'worktrees', taskKey, 'demo'), { recursive: true });
  flow.app.clock.advance(60_000);
  const registry = flow.app.app.get<{ get(name: StepName): Step | null }>(StepRegistry);
  const real = registry.get('implement')!;
  const steps = installScripts(
    flow.app,
    {
      implement: async (_visit, ctx) => {
        await ctx.write(ARTIFACTS.needs, renderNeeds([{ id: 'b', what: 'which retry policy wins' }]));
        const now = ctx.clock.iso();
        const call = await loggedCall(flow.app.app.get(AgentCallRepository), {
          model: 'fake',
          startedAt: now,
          finishedAt: now,
          durationMs: 0,
          requestText: 'implement',
          responseText: 'I cannot decide which retry policy wins.',
        });
        return { outcome: 'waiting', exitCode: 0, code: ERROR_CODES.SUBTASK_WAITING, visit: { callIds: [call] } };
      },
    },
    ['implement'],
  );
  const scripted = registry.get('implement')!;
  const others = registry.get.bind(registry);
  const pick = (runKey: string) => (runKey === taskKey ? scripted : real);
  registry.get = (name) =>
    name !== 'implement'
      ? others(name)
      : new Proxy(real, {
          get: (target, prop) => {
            if (prop === 'usesModel') return true;
            if (prop === 'execute')
              return (runKey: string, options: StepOptions, snapshot?: StepSnapshot) =>
                pick(runKey).execute(runKey, options, snapshot);
            if (prop === 'missingInput')
              return (runKey: string, options: StepOptions) => pick(runKey).missingInput(runKey, options);
            const value: unknown = Reflect.get(target, prop, target);
            return typeof value === 'function' ? value.bind(target) : value;
          },
        });
  const detached = PipelineService.prototype.startDetached.bind(flow.app.pipeline);
  jest.spyOn(flow.app.pipeline, 'startDetached').mockImplementation((runKey, ...rest) => {
    if (runKey === key || runKey === taskKey) return detached(runKey, ...rest);
    flow.launched.push(runKey);
    return Promise.resolve({ exitCode: 0, message: `${runKey} started` });
  });
  await flow.app.app.get(CommandService).submit('resume', taskKey, { ...PERSON_RESUME });
  await settle();
  planChatOf(flow, (await runs.findRun(taskKey))!);
  return { taskKey, settle, visits: () => steps.get('implement')?.count ?? 0, task: () => runs.findRun(taskKey) };
}
