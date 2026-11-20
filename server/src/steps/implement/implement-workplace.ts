import { checkoutSnapshot, featureHeads, worktreeSnapshot } from '../../git/worktree-git';
import type { PerRepo } from '../../git/per-repo';
import type { SandboxMount } from '../../core/sandbox-mount';
import type { EnvironmentService } from '../../environment/environment.service';
import type { StepName } from '../../contract/steps';
import type { RuntimeName } from '../../integrations/agent-runtime/runtime-name';
import type { ModelStepContext } from '../agent-step';
import { agentWorkplace, projectFor } from '../shared/agent-environment';

type Workplace = Awaited<ReturnType<typeof agentWorkplace>>;
type Place = Parameters<typeof projectFor>[1];

/** What the agent is launched with, and the state to compare against afterwards. */
interface OpenWorkplace extends Workplace {
  heads: Awaited<ReturnType<typeof featureHeads>>;
  place: Place;
  reproject: ReturnType<typeof projectFor>;
  snapshot: typeof worktreeSnapshot;
  before: string;
  sameWorkplace: {
    mounts: SandboxMount[];
    allowHosts: Workplace['allowHosts'];
    manifestHosts: Workplace['manifestHosts'];
    project: Workplace['project'];
    projectFor: ReturnType<typeof projectFor>;
  };
}

/** Where the implement agent works: its prompt with the environment, the mounts it sees, and the state before it ran. */
export async function openWorkplace(
  environments: EnvironmentService,
  ctx: ModelStepContext,
  step: StepName,
  setup: { mounts: SandboxMount[]; runtime: RuntimeName; branch: PerRepo<string>; basePrompt: string },
): Promise<OpenWorkplace> {
  const { mounts, runtime, branch, basePrompt } = setup;
  const { key } = ctx.opened.run;
  const heads = await featureHeads(mounts, branch);
  const place = { run: ctx.opened.run, key, step, mounts, runtime, samples: ctx.samples };
  const reproject = projectFor(environments, place);
  const { prompt, project, allowHosts, manifestHosts, executionRules } = await agentWorkplace(
    environments,
    place,
    basePrompt,
  );
  const snapshot = ctx.opened.run.targetPath ? checkoutSnapshot : worktreeSnapshot;
  const before = await snapshot(mounts);
  const sameWorkplace = { mounts, allowHosts, manifestHosts, project, projectFor: reproject };
  return {
    heads,
    place,
    reproject,
    prompt,
    project,
    allowHosts,
    manifestHosts,
    executionRules,
    snapshot,
    before,
    sameWorkplace,
  };
}
