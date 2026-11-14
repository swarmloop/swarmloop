import { runtimesNamingEffort } from '../config/agents';
import { SwarmloopError } from '../core/swarmloop-error';
import type { AgentRuntime } from '../integrations/agent-runtime/agent-runtime';
import { RUNTIME_NAMES, runtimeFor } from '../integrations/agent-runtime/agent-runtime.registry';
import { loadModelList } from './model-list';

/**
 * Reads the model list of a runtime (cache, else its CLI) and hands it to the runtime. A runtime whose levels do not
 * depend on a list reads none. A list that stays empty fails.
 */
export async function loadRuntimeModelIds(
  root: string,
  runtime: AgentRuntime,
  now: number,
  list: () => Promise<string>,
): Promise<void> {
  if (runtime.modelListArgs() === null) {
    return;
  }
  const output = await loadModelList(root, runtime, now, list);
  if (output.trim() === '') {
    throw new SwarmloopError(`the model list of ${runtime.name} is empty and no cached list exists`);
  }
  runtime.useModelList(output);
}

/**
 * Start-up of every process that resolves agents (API and CLI). Each cached model list goes to its runtime first, so a
 * level saved earlier still counts. Then the list of each runtime whose env agents name an effort is read, from the
 * cache else its CLI, so the levels can be checked. An env with no effort starts no CLI. A runtime with no lister (no
 * credential) is not read: that is a readiness item, not a refusal to start. A failure names the runtime and its reason.
 */
export async function warmModelLists(
  env: Parameters<typeof runtimesNamingEffort>[0],
  root: string,
  now: number,
  listerFor: (runtime: AgentRuntime) => (() => Promise<string>) | null,
): Promise<void> {
  for (const name of RUNTIME_NAMES) {
    await useCachedModelList(root, runtimeFor(name), now);
  }
  for (const name of runtimesNamingEffort(env)) {
    const runtime = runtimeFor(name);
    const lister = listerFor(runtime);
    if (!lister) {
      continue;
    }
    try {
      await loadRuntimeModelIds(root, runtime, now, lister);
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      throw new SwarmloopError(`agents of ${name} name an effort, but its models cannot be read: ${reason}`);
    }
  }
}

/** Hands a runtime the cached model list only. It never starts the CLI, so a request stays fast. */
export async function useCachedModelList(root: string, runtime: AgentRuntime, now: number): Promise<void> {
  const output = await loadModelList(root, runtime, now, () => Promise.resolve(''));
  if (output.trim() !== '') {
    runtime.useModelList(output);
  }
}
